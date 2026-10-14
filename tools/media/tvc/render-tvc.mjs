// FlyBot TVC: frame by frame from tvc.html, then encoded with its music by encode.html (WebCodecs)
// and written by mux-mp4.mjs. The MP4 is ready to publish, nothing else to run.
//   node render-tvc.mjs <vi|en> <out.mp4> [workdir]
// Frames go to workdir (about 400 MB, removed at the end unless FLYBOT_TVC_KEEP=1;
// FLYBOT_TVC_REUSE=1 encodes the frames already there without rendering them again).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../cdp.mjs';
import { writeMp4 } from './mux-mp4.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , lang = 'vi', out = `flybot-tvc-${lang}.mp4`, workArg] = process.argv;
const work = workArg || path.join(os.tmpdir(), `flybot-tvc-frames-${lang}`);
const FPS = 30;
// Motion graphics stay sharp at 5 Mbps (about 38 MB a minute); FLYBOT_TVC_BITRATE changes it
const BITRATE = Number(process.env.FLYBOT_TVC_BITRATE) || 5000000;
// Every frame is drawn at an exact time, so a single still can be checked: FLYBOT_TVC_ONLY=12.5
const only = process.env.FLYBOT_TVC_ONLY;
const keepFrames = process.env.FLYBOT_TVC_KEEP === '1';
const reuse = process.env.FLYBOT_TVC_REUSE === '1' && !only;
// One long call: the whole encode
process.env.FLYBOT_CDP_TIMEOUT ||= String(20 * 60 * 1000);

if (!reuse) {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
}
const page = await launch({ args: ['--allow-file-access-from-files'] });
try {
    await page.viewport(1920, 1080);
    await page.goto(`${pathToFileURL(path.join(here, 'tvc.html')).href}?render&lang=${lang}`, 2000);
    await page.eval('await window.ready; return true;');
    const duration = await page.eval('return window.TVC.duration;');
    const count = only ? 1 : Math.round(duration * FPS);
    const started = Date.now();
    for (let i = 0; i < (reuse ? 0 : count); i++) {
        const t = only ? Number(only) : i / FPS;
        const { data } = await page.send('Runtime.evaluate', { expression: `window.renderAt(${t})` })
            .then(() => page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 }));
        fs.writeFileSync(path.join(work, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
        if (i % 150 === 0) console.log(`frame ${i}/${count} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    if (only) {
        console.log(path.join(work, 'f00000.jpg'));
        process.exit(0);
    }

    // Encode: a second page reads the frames back and encodes them with the music
    await page.goto(pathToFileURL(path.join(here, 'encode.html')).href, 1000);
    const base = pathToFileURL(work).href;
    console.log('encoding...');
    const encodeStarted = Date.now();
    const tables = await page.eval(`return await window.encode({ frameUrl: (i) => '${base}/f' + String(i).padStart(5, '0') + '.jpg', count: ${count}, fps: ${FPS}, bitrate: ${BITRATE} });`);
    // The packets come over in slices
    const SLICE = 4 * 1024 * 1024;
    for (const name of ['video', 'audio']) {
        const parts = [];
        for (let at = 0; at < tables[name].size; at += SLICE) {
            parts.push(Buffer.from(await page.eval(`return await window.part('${name}', ${at}, ${at + SLICE});`), 'base64'));
        }
        tables[name].data = Buffer.concat(parts);
    }
    writeMp4(out, tables);
    const { video, audio } = tables;
    console.log(`${out}: ${Math.round(fs.statSync(out).size / 1024)} KB, ${video.samples.length} frames, ${audio.samples.length} sound packets, encoded in ${Math.round((Date.now() - encodeStarted) / 1000)} s`);
} finally {
    await page.close();
    if (!only && !keepFrames) fs.rmSync(work, { recursive: true, force: true });
}
