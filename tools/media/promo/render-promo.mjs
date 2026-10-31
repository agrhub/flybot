// The Vietnamese introduction film as an MP4 (H.264 + AAC, 1920x1080, 30 fps), in one command:
//   node render-promo.mjs [out.mp4] [--subs none] [--work <folder>]    default: ../film/media/out/flybot-intro-vi.mp4
// 1. promo.html drawn frame by frame (JPEG frames in the work folder, about 1 GB, removed at the end);
// 2. the sound mixed by ../film/mix.html (music bed, and media/promo-voice/*.wav at their cues if there are any);
// 3. both encoded by ../tvc/encode.html (WebCodecs) and written by ../tvc/mux-mp4.mjs, index in front.
// Also writes <out>.vi.srt for the video site. FLYBOT_PROMO_KEEP=1 keeps the frames; FLYBOT_PROMO_REUSE=1 encodes
// the frames already there (the sound is mixed again).
// Other modes:
//   node render-promo.mjs --serve [port]                 watch it play: http://127.0.0.1:<port>/promo/promo.html (?t=42)
//   node render-promo.mjs --stills <outdir> <s|scene>... stills at chosen seconds (a scene id: its middle)
// Pictures come from client/public (the commercial, the guide screenshots, the logo) and ../film/media (the orchard clip
// and the trap photos).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../cdp.mjs';
import { writeMp4 } from '../tvc/mux-mp4.mjs';
import { serve, MEDIA } from '../film/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const subs = opt('--subs', 'vi');
const work = path.resolve(opt('--work', path.join(MEDIA, 'work-promo')));
const ROOTS = {
    '/promo/': here,
    '/app/': path.join(repo, 'client', 'public'),
    '/tvc/': path.join(here, '..', 'tvc'),
    '/work/': work
};
const page = (port) => `http://127.0.0.1:${port}/promo/promo.html?render${subs === 'none' ? '&subs=none' : ''}`;

if (flag('--serve')) {
    const { port } = await serve(Number(args[0]) || 8091, ROOTS);
    console.log(`http://127.0.0.1:${port}/promo/promo.html`);
} else if (flag('--stills')) {
    const [outDir, ...times] = args;
    fs.mkdirSync(outDir, { recursive: true });
    const { server, port } = await serve(0, ROOTS);
    const tab = await launch({ port: Number(process.env.FLYBOT_CDP_PORT) || 9444, profile: path.join(process.env.TEMP || '.', 'flybot-promo-stills') });
    try {
        await tab.viewport(1920, 1080);
        await tab.goto(page(port), 1500);
        const film = await tab.eval('return await window.ready;');
        console.log(`duration ${film.duration.toFixed(1)} s`);
        for (const s of film.scenes) console.log(`  ${s.start.toFixed(1).padStart(6)}  ${s.len.toFixed(1).padStart(5)}  ${s.id}`);
        for (const t of times) {
            const sc = film.scenes.find(s => s.id === t);
            const at = sc ? sc.start + sc.len / 2 : Number(t);
            await tab.eval(`await window.renderAt(${at}); return true;`);
            const file = path.join(outDir, `still-${String(sc ? t : at.toFixed(1)).replace('.', '_')}.jpg`);
            await tab.shot(file, { format: 'jpeg', quality: 80 });
            console.log(file);
        }
    } finally {
        await tab.close();
        server.close();
    }
} else {
    const out = path.resolve(args[0] || path.join(MEDIA, 'out', 'flybot-intro-vi.mp4'));
    const FPS = 30;
    const BITRATE = Number(process.env.FLYBOT_PROMO_BITRATE) || 8000000;
    const reuse = process.env.FLYBOT_PROMO_REUSE === '1';
    // One long call: the whole encode
    process.env.FLYBOT_CDP_TIMEOUT ||= String(30 * 60 * 1000);
    const srtTime = (t) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
    async function pull(tab, fn, size) {
        const SLICE = 4 * 1024 * 1024, parts = [];
        for (let at = 0; at < size; at += SLICE) parts.push(Buffer.from(await tab.eval(`return await ${fn}(${at}, ${at + SLICE});`), 'base64'));
        return Buffer.concat(parts);
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!reuse) fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const { server, port } = await serve(0, ROOTS);
    const base = `http://127.0.0.1:${port}`;
    const tab = await launch({ port: Number(process.env.FLYBOT_CDP_PORT) || 9445, profile: path.join(MEDIA, 'render-profile') });
    try {
        await tab.viewport(1920, 1080);
        await tab.goto(page(port), 1500);
        const film = await tab.eval('return await window.ready;');
        console.log(`film: ${film.duration.toFixed(1)} s, ${film.scenes.length} scenes, ${film.cues.filter(c => c.voice).length}/${film.cues.length} lines voiced`);
        const count = Math.round(film.duration * FPS);
        const started = Date.now();
        for (let i = 0; i < (reuse ? 0 : count); i++) {
            await tab.send('Runtime.evaluate', { expression: `window.renderAt(${i / FPS})`, awaitPromise: true });
            const { data } = await tab.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
            fs.writeFileSync(path.join(work, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
            if (i % 300 === 0) console.log(`frame ${i}/${count} (${Math.round((Date.now() - started) / 1000)} s)`);
        }

        // The sound
        await tab.goto(`${base}/mix.html`, 500);
        const size = await tab.eval(`return await window.mix(${JSON.stringify(film)});`);
        fs.writeFileSync(path.join(work, 'mix.wav'), await pull(tab, 'window.part', size));
        console.log(`sound mixed (${Math.round(size / 1048576)} MB)`);

        // Encode and write
        await tab.goto(`${base}/tvc/encode.html`, 1000);
        const tables = await tab.eval(`return await window.encode({ frameUrl: (i) => '/work/f' + String(i).padStart(5, '0') + '.jpg', count: ${count}, fps: ${FPS}, bitrate: ${BITRATE}, width: 1920, height: 1080, audio: '/work/mix.wav' });`);
        for (const name of ['video', 'audio']) tables[name].data = await pull(tab, `((a, b) => window.part('${name}', a, b))`, tables[name].size);
        writeMp4(out, tables);
        fs.writeFileSync(out.replace(/\.mp4$/i, '.vi.srt'), film.cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.vi}\n`).join('\n'));
        console.log(`${out}: ${Math.round(fs.statSync(out).size / 1048576)} MB, ${tables.video.samples.length} frames, ${film.duration.toFixed(1)} s`);
    } finally {
        await tab.close();
        server.close();
        if (process.env.FLYBOT_PROMO_KEEP !== '1' && !process.exitCode) fs.rmSync(work, { recursive: true, force: true });
    }
}
