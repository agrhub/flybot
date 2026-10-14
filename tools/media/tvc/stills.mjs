// Stills of the TVC at chosen seconds, to check the layout: node stills.mjs <outdir> <vi|en> <seconds...>
// FLYBOT_STILL_FORMAT=webp writes WebP (the video poster) instead of JPEG.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , out, lang = 'vi', ...times] = process.argv;
const webp = process.env.FLYBOT_STILL_FORMAT === 'webp';
fs.mkdirSync(out, { recursive: true });
const page = await launch({ args: ['--allow-file-access-from-files'] });
try {
    await page.viewport(1920, 1080);
    await page.goto(`${pathToFileURL(path.join(here, 'tvc.html')).href}?render&lang=${lang}`, 1500);
    await page.eval('await window.ready; return true;');
    for (const t of times.map(Number)) {
        await page.eval(`window.renderAt(${t}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;`);
        const file = path.join(out, `${lang}-${String(t).replace('.', '_')}.${webp ? 'webp' : 'jpg'}`);
        await page.shot(file, webp ? { format: 'webp', quality: 82 } : { format: 'jpeg', quality: 80 });
        console.log(file);
    }
} finally {
    await page.close();
}
