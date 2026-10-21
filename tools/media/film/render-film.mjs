// The demo film as an MP4 (H.264 + AAC, 1920x1080, 30 fps), in one command:
//   node render-film.mjs [out.mp4] [--subs en|vi|none] [--work <folder>] [--footage placeholder]
// --footage placeholder: an internal review cut with the stand-in clip of media/vendor/footage.json in the orchard slot,
// labelled in the corner; its file name must end in -placeholder.mp4 and it is never to be published. Without it, the
// slot shows the owner's clip (media/footage) or the placeholder card.
// 1. film.html drawn frame by frame (JPEG frames in the work folder, about 2.5 GB, removed at the end);
// 2. the sound mixed by mix.html (music bed + media/voice/*.wav at their cues);
// 3. both encoded by ../tvc/encode.html (WebCodecs) and written by ../tvc/mux-mp4.mjs, index in front.
// Also writes <out>.en.srt and <out>.vi.srt for the video site. Fails if the film runs over 5:00.
// FLYBOT_FILM_KEEP=1 keeps the frames; FLYBOT_FILM_REUSE=1 encodes the frames already there (sound is mixed again).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../cdp.mjs';
import { writeMp4 } from '../tvc/mux-mp4.mjs';
import { serve, MEDIA } from './serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const subs = opt('--subs', 'en');
const footage = opt('--footage', 'owner');
if (!['owner', 'placeholder'].includes(footage)) throw new Error('--footage is owner or placeholder');
const suffix = footage === 'placeholder' ? '-placeholder' : '';
const work = path.resolve(opt('--work', path.join(MEDIA, 'work')));
const out = path.resolve(args[0] || path.join(MEDIA, 'out', `flybot-demo-${subs}${suffix}.mp4`));
if (footage === 'placeholder' && !/-placeholder\.mp4$/i.test(out)) throw new Error('a cut with the stand-in clip must be named *-placeholder.mp4');
if (footage !== 'placeholder' && /-placeholder\.mp4$/i.test(out)) throw new Error('only --footage placeholder cuts are named *-placeholder.mp4');
const FPS = 30;
const BITRATE = Number(process.env.FLYBOT_FILM_BITRATE) || 8000000;
const reuse = process.env.FLYBOT_FILM_REUSE === '1';
// One long call: the whole encode
process.env.FLYBOT_CDP_TIMEOUT ||= String(40 * 60 * 1000);

const srtTime = (t) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = (cues, lang) => cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c[lang]}\n`).join('\n');
async function pull(page, fn, size) {
    const SLICE = 4 * 1024 * 1024, parts = [];
    for (let at = 0; at < size; at += SLICE) parts.push(Buffer.from(await page.eval(`return await ${fn}(${at}, ${at + SLICE});`), 'base64'));
    return Buffer.concat(parts);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
if (!reuse) { fs.rmSync(work, { recursive: true, force: true }); }
fs.mkdirSync(work, { recursive: true });
const { server, port } = await serve(0, { '/work/': work, '/tvc/': path.join(here, '..', 'tvc') });
const base = `http://127.0.0.1:${port}`;
const page = await launch({ port: Number(process.env.FLYBOT_CDP_PORT) || 9443, profile: path.join(MEDIA, 'render-profile') });
try {
    await page.viewport(1920, 1080);
    await page.goto(`${base}/film.html?render&subs=${subs}${footage === 'placeholder' ? '&footage=placeholder' : ''}`, 1500);
    const film = await page.eval('return await window.ready;');
    console.log(`film: ${film.duration.toFixed(1)} s, ${film.scenes.length} scenes, ${film.cues.filter(c => c.voice).length}/${film.cues.length} lines voiced, orchard clip: ${film.footage || 'placeholder card'}`);
    // The stand-in clip only in a cut asked for and named as a placeholder
    if ((footage === 'placeholder') !== (film.footage === 'placeholder')) throw new Error(`footage source mismatch: asked ${footage}, page has ${film.footage}`);
    if (film.duration > film.maxSeconds) throw new Error(`the film runs ${film.duration.toFixed(1)} s, over ${film.maxSeconds} s: shorten script.js`);
    const count = Math.round(film.duration * FPS);
    const started = Date.now();
    for (let i = 0; i < (reuse ? 0 : count); i++) {
        await page.send('Runtime.evaluate', { expression: `window.renderAt(${i / FPS})`, awaitPromise: true });
        const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
        fs.writeFileSync(path.join(work, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
        if (i % 300 === 0) console.log(`frame ${i}/${count} (${Math.round((Date.now() - started) / 1000)} s)`);
    }

    // The sound
    await page.goto(`${base}/mix.html`, 500);
    const size = await page.eval(`return await window.mix(${JSON.stringify(film)});`);
    fs.writeFileSync(path.join(work, 'mix.wav'), await pull(page, 'window.part', size));
    console.log(`sound mixed (${Math.round(size / 1048576)} MB)`);

    // Encode and write
    await page.goto(`${base}/tvc/encode.html`, 1000);
    const encodeStarted = Date.now();
    const tables = await page.eval(`return await window.encode({ frameUrl: (i) => '/work/f' + String(i).padStart(5, '0') + '.jpg', count: ${count}, fps: ${FPS}, bitrate: ${BITRATE}, width: 1920, height: 1080, audio: '/work/mix.wav' });`);
    for (const name of ['video', 'audio']) tables[name].data = await pull(page, `((a, b) => window.part('${name}', a, b))`, tables[name].size);
    writeMp4(out, tables);
    const stem = out.replace(/\.mp4$/i, '');
    fs.writeFileSync(`${stem}.en.srt`, srt(film.cues, 'en'));
    fs.writeFileSync(`${stem}.vi.srt`, srt(film.cues, 'vi'));
    console.log(`${out}: ${Math.round(fs.statSync(out).size / 1048576)} MB, ${tables.video.samples.length} frames, ${film.duration.toFixed(1)} s, encoded in ${Math.round((Date.now() - encodeStarted) / 1000)} s`);
} finally {
    await page.close();
    server.close();
    if (process.env.FLYBOT_FILM_KEEP !== '1' && !process.exitCode) fs.rmSync(work, { recursive: true, force: true });
}
