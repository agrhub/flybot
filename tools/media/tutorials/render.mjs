// CamOS tutorial videos, step 2: the takes of record.mjs drawn and encoded by compose.html, written as MP4 (H.264, no
// sound, index in front) with a poster JPEG.
//   node render.mjs <lesson|all> <en|vi> [outdir]       (default media/out)
// CAMOS_TUTORIAL_QP: the H.264 quantizer (default 28: about 1.8 MB a minute, as still screens cost almost nothing;
// 0 = a variable bitrate of CAMOS_TUTORIAL_BITRATE instead), CAMOS_TUTORIAL_KEY: seconds between key frames (10)
// CAMOS_TUTORIAL_STILL=<seconds>: only a JPEG of that moment, to check the layout
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../cdp.mjs';
import { writeMp4 } from '../tvc/mux-mp4.mjs';
import { LESSONS } from './lessons.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.CAMOS_TUTORIAL_WORK || path.join(here, 'media');
const [, , which = 'all', lang = 'en', outArg] = process.argv;
const out = outArg || path.join(WORK, 'out');
const BITRATE = Number(process.env.CAMOS_TUTORIAL_BITRATE) || 1200000;
const QP = Number(process.env.CAMOS_TUTORIAL_QP ?? 28);
const KEY = Number(process.env.CAMOS_TUTORIAL_KEY) || 10;
const still = process.env.CAMOS_TUTORIAL_STILL;
process.env.FLYBOT_CDP_TIMEOUT ||= String(30 * 60 * 1000);

const list = which === 'all' ? LESSONS : LESSONS.filter(l => which.split(',').includes(l.name));
fs.mkdirSync(out, { recursive: true });
const page = await launch({ args: ['--allow-file-access-from-files'], port: Number(process.env.FLYBOT_CDP_PORT) || 9338, profile: path.join(WORK, 'profile-render') });
try {
    await page.viewport(1920, 1080);
    await page.goto(pathToFileURL(path.join(here, 'compose.html')).href, 500);
    for (const lesson of list) {
        const n = LESSONS.indexOf(lesson) + 1;
        const name = `camos-${n}-${lesson.name}-${lang}`;
        const takeUrl = pathToFileURL(path.join(WORK, 'takes', `${lesson.name}-${lang}`, 'take.json')).href;
        if (still) {
            for (const sec of still.split(',')) {
                const file = path.join(out, `${name}-${sec}s.jpg`);
                fs.writeFileSync(file, Buffer.from(await page.eval(`return await window.still('${takeUrl}', ${Math.round(Number(sec) * 30)});`), 'base64'));
                console.log(file);
            }
            continue;
        }
        const started = Date.now();
        const video = await page.eval(`return await window.render({ take: '${takeUrl}', bitrate: ${BITRATE}, qp: ${QP}, keyEvery: ${KEY} });`);
        const SLICE = 4 * 1024 * 1024;
        const parts = [];
        for (let at = 0; at < video.size; at += SLICE) parts.push(Buffer.from(await page.eval(`return await window.part(${at}, ${at + SLICE});`), 'base64'));
        video.data = Buffer.concat(parts);
        const file = path.join(out, `${name}.mp4`);
        writeMp4(file, { video });
        // The poster: a moment a third of the way in, past the title card
        const poster = path.join(out, `${name}.jpg`);
        fs.writeFileSync(poster, Buffer.from(await page.eval(`return await window.still('${takeUrl}', ${Math.round(video.frames * (lesson.poster ?? 0.3))});`), 'base64'));
        console.log(`${file}: ${(fs.statSync(file).size / 1048576).toFixed(1)} MB, ${(video.frames / video.fps).toFixed(0)} s, in ${Math.round((Date.now() - started) / 1000)} s`);
    }
} finally {
    await page.close();
}
