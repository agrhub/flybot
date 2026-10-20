// Stills of the film at chosen seconds, to check the layout: node stills.mjs <outdir> <seconds|scene id>... [--subs vi]
// A scene id gives a still in the middle of that scene. Also prints the scene list with start times.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../cdp.mjs';
import { serve } from './serve.mjs';

const args = process.argv.slice(2);
const subsAt = args.indexOf('--subs');
const subs = subsAt >= 0 ? args.splice(subsAt, 2)[1] : 'en';
const [out, ...times] = args;
fs.mkdirSync(out, { recursive: true });
const { server, port } = await serve(0);
const page = await launch({ port: Number(process.env.FLYBOT_CDP_PORT) || 9442, profile: path.join(process.env.TEMP || '.', 'flybot-film-stills') });
try {
    await page.viewport(1920, 1080);
    await page.goto(`http://127.0.0.1:${port}/film.html?render&subs=${subs}`, 1500);
    const film = await page.eval('return await window.ready;');
    console.log(`duration ${film.duration.toFixed(1)} s, footage ${film.footage ? 'yes' : 'placeholder'}`);
    for (const s of film.scenes) console.log(`  ${s.start.toFixed(1).padStart(6)}  ${s.len.toFixed(1).padStart(5)}  ${s.id}`);
    for (const t of times) {
        const sc = film.scenes.find(s => s.id === t);
        const at = sc ? sc.start + sc.len / 2 : Number(t);
        await page.eval(`await window.renderAt(${at}); return true;`);
        const file = path.join(out, `still-${String(sc ? t : at.toFixed(1)).replace('.', '_')}.jpg`);
        await page.shot(file, { format: 'jpeg', quality: 80 });
        console.log(file);
    }
} finally {
    await page.close();
    server.close();
}
