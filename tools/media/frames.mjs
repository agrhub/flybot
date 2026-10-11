// Grab frames of a recorded video at given seconds (headless Chrome)
import fs from 'node:fs';
import { launch } from './cdp.mjs';
const [, , file, out, ...times] = process.argv;
const page = await launch();
try {
    await page.viewport(1280, 720);
    await page.goto('about:blank', 300);
    const b64 = fs.readFileSync(file).toString('base64');
    for (const t of times) {
        await page.eval(`
            document.body.style.margin = 0;
            let v = document.querySelector('video');
            if (!v) { v = document.createElement('video'); v.muted = true; v.style.width = '1280px'; v.src = 'data:video/mp4;base64,${b64}'; document.body.appendChild(v); await new Promise(r => v.onloadeddata = r); }
            v.currentTime = ${Number(t)}; await new Promise(r => v.onseeked = r); await new Promise(r => setTimeout(r, 200)); return v.duration;`);
        await page.shot(`${out}-${t}.webp`);
    }
} finally { await page.close(); }
