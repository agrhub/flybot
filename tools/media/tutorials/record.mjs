// CamOS tutorial videos, step 1: plays a lesson of lessons.mjs in headless Chrome and writes a take: the page's
// pictures (each distinct one once) and, for every frame of the video, which picture, where the drawn cursor is, the
// zoom, the highlight and the caption. Nothing runs in real time except the page itself, so a slow machine records
// the same take. compose.html draws the frames from it (render.mjs).
//   node record.mjs <lesson|all> <en|vi>
// Needs the mock camera of the firmware repository (CAMOS_REPO): node tools/mock/server.js 8099 (CAMOS_MOCK).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../cdp.mjs';
import { LESSONS } from './lessons.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FPS = 30;
const MOCK = process.env.CAMOS_MOCK || 'http://localhost:8099';
const REPO = process.env.CAMOS_REPO || path.resolve(here, '../../../../camos-esp32-trap');
const WORK = process.env.CAMOS_TUTORIAL_WORK || path.join(here, 'media');
// The flasher page and the props are served from here (ESP Web Tools needs http for its manifest)
const STATIC_PORT = Number(process.env.CAMOS_TUTORIAL_PORT) || 8097;

// The flasher page of the firmware repository, with a manifest like the release's (no firmware is downloaded)
function staticServer() {
    const manifest = (update) => JSON.stringify({
        name: update ? 'CamOS trap camera, Freenove ESP32-S3 CAM (FNK0085) (update: keeps the settings and the camera\'s identity)' : 'CamOS trap camera, Freenove ESP32-S3 CAM (FNK0085)',
        version: '0.9.2', new_install_prompt_erase: !update,
        builds: [{ chipFamily: 'ESP32-S3', parts: [{ path: 'install.bin', offset: 0 }] }]
    });
    const srv = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname;
        const send = (type, body) => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
        if (p.startsWith('/flash/firmware/manifest')) return send('application/json', manifest(p.includes('update')));
        if (p === '/flash/') return send('text/html; charset=utf-8', fs.readFileSync(path.join(REPO, 'docs/flash/index.html')));
        if (p.startsWith('/img/')) {
            const file = path.join(REPO, 'docs', p);
            if (fs.existsSync(file)) return send(p.endsWith('.svg') ? 'image/svg+xml' : 'image/png', fs.readFileSync(file));
        }
        if (p.startsWith('/props/')) {
            const file = path.join(here, p);
            if (fs.existsSync(file)) return send('text/html; charset=utf-8', fs.readFileSync(file));
        }
        res.writeHead(404); res.end();
    });
    return new Promise(res => srv.listen(STATIC_PORT, () => res(srv)));
}

const ease = (k) => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const frames = (sec) => Math.max(1, Math.round(sec * FPS));

// The recorder a lesson drives. Coordinates are CSS pixels of the page's viewport.
function recorder(page, dir, lang) {
    const take = { lang, fps: FPS, scenes: [], texts: [], frames: [], images: 0 };
    const hashes = new Map();
    const textIndex = new Map();
    let scene = null, img = -1, cursor = null, ripple = -1, caption = -1, zoom = null, light = null, address = -1;
    const text = (s) => {
        if (s == null || s === '') return -1;
        if (!textIndex.has(s)) { textIndex.set(s, take.texts.length); take.texts.push(s); }
        return textIndex.get(s);
    };
    const js = async (expr) => page.eval(expr);
    const push = () => {
        const f = { s: take.scenes.length - 1, i: img, t: caption };
        if (cursor) f.c = [Math.round(cursor.x * 10) / 10, Math.round(cursor.y * 10) / 10];
        if (ripple >= 0) f.r = take.frames.length - ripple;
        if (zoom) f.z = zoom.map(v => Math.round(v * 10) / 10);
        if (light) f.h = light;
        if (address >= 0) f.a = address;
        take.frames.push(f);
        if (ripple >= 0 && take.frames.length - ripple > 20) ripple = -1;
    };
    const capture = async () => {
        if (!scene || scene.kind === 'card') return;
        const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
        const buf = Buffer.from(data, 'base64');
        const h = crypto.createHash('sha1').update(buf).digest('hex');
        if (!hashes.has(h)) {
            hashes.set(h, take.images);
            fs.writeFileSync(path.join(dir, `i${String(take.images).padStart(5, '0')}.jpg`), buf);
            take.images++;
        }
        img = hashes.get(h);
    };
    const r = {
        lang,
        t: (en, vi) => (lang === 'vi' && vi ? vi : en),
        mock: (p) => MOCK + p,
        local: (p) => `http://localhost:${STATIC_PORT}${p}`,
        js,
        sleep,
        // A new scene: kind 'desktop' (a browser window), 'phone', 'image' (a picture to pan over) or 'card' (text)
        async scene(opts) {
            const s = { kind: 'desktop', w: 1280, h: 720, dsf: 1.5, ...opts };
            if (s.kind === 'phone') Object.assign(s, { w: 390, h: s.h || 844, dsf: 2, ...opts });
            if (s.kind === 'card') {
                s.title = text(s.title); s.sub = text(s.sub);
                s.bullets = (s.bullets || []).map(text);
                s.foot = text(s.foot);
            }
            delete s.url;
            take.scenes.push(s);
            scene = s; img = -1; cursor = null; ripple = -1; zoom = null; light = null; caption = -1;
            address = text(opts.address);
            if (s.kind === 'card') return;
            await page.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: s.dsf, mobile: s.kind === 'phone' });
            await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
            if (opts.url) await r.goto(opts.url, opts.settle ?? 2500);
            await capture();
        },
        async goto(url, settle = 2500) {
            await page.goto(url, settle);
            await capture();
        },
        address(s) { address = text(s); },
        say(s) { caption = text(s); },
        // Frames of the page as it is, refreshed every `every` frames in about real time (counters, spinners)
        async hold(sec, { every = 3 } = {}) {
            const n = frames(sec);
            for (let k = 0; k < n; k++) {
                if (k % every === 0 && k > 0) {
                    const t0 = Date.now();
                    await capture();
                    const wait = every * 1000 / FPS - (Date.now() - t0);
                    if (wait > 0) await sleep(wait);
                }
                push();
            }
        },
        // The centre and box of an element: { sel } or { text, sel? } (the smallest visible element with the text)
        async find(target, { scroll = true, timeout = 15000 } = {}) {
            if (typeof target.x === 'number') return target;
            const t = typeof target === 'string' ? { text: target } : target;
            const expr = `
                const t = ${JSON.stringify(t)};
                const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
                // Inside web components too (the flasher's dialog)
                const all = (root, sel, out = []) => {
                    out.push(...root.querySelectorAll(sel));
                    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) all(e.shadowRoot, sel, out);
                    return out;
                };
                const label = (e) => e.innerText || e.value || e.placeholder || e.getAttribute('label') || '';
                let els = all(document, t.sel || 'button, a, label, summary, select, input, li, span, div, td, p, b, h1, h2, h3, ew-list-item, ew-text-button, ew-checkbox').filter(vis);
                if (t.text) {
                    const want = t.text.toLowerCase();
                    els = els.filter(e => label(e).toLowerCase().includes(want));
                    if (t.exact) els = els.filter(e => label(e).trim().toLowerCase() === want);
                    els.sort((x, y) => label(x).length - label(y).length);
                }
                if (t.within) els = els.filter(e => e.closest(t.within));
                let el = els[t.index || 0];
                if (!el) return null;
                for (let k = 0; k < (t.up || 0); k++) el = el.parentElement;
                if (${scroll}) { const b = el.getBoundingClientRect(); if (b.top < 10 || b.bottom > innerHeight - 10) { el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 400)); } }
                const b = el.getBoundingClientRect();
                return { x: b.left + b.width / 2, y: b.top + b.height / 2, box: [b.left, b.top, b.width, b.height] };`;
            const until = Date.now() + timeout;
            for (;;) {
                const found = await js(expr);
                if (found) { await capture(); return found; }
                if (Date.now() > until) throw new Error(`not found: ${JSON.stringify(t)}`);
                await sleep(300);
            }
        },
        // Moves the drawn cursor there, eased; the real mouse follows at the end (hover)
        async move(target, sec = 0.7) {
            const to = await r.find(target);
            const from = cursor || { x: scene.w * 0.6, y: scene.h * 0.75 };
            const n = frames(sec);
            for (let k = 1; k <= n; k++) {
                const e = ease(k / n);
                cursor = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
                push();
            }
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y });
            await capture();
            return to;
        },
        async click(target, { sec = 0.7, after = 1 } = {}) {
            const to = await r.move(target, sec);
            for (let k = 0; k < 4; k++) push();
            ripple = take.frames.length;
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: to.x, y: to.y, button: 'left', clickCount: 1 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
            await sleep(150);
            await capture();
            await r.hold(after);
            return to;
        },
        // Types into the focused field, a picture after each character
        async type(s, { cps = 12 } = {}) {
            for (const ch of s) {
                await page.send('Input.insertText', { text: ch });
                await sleep(20);
                await capture();
                for (let k = 0; k < Math.round(FPS / cps); k++) push();
            }
        },
        async key(key, code = key, keyCode = 13) {
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
            await capture();
        },
        // Wheel scrolling at the cursor, over sec
        async scroll(dy, { sec = 1, x, y } = {}) {
            const at = { x: x ?? cursor?.x ?? scene.w / 2, y: y ?? cursor?.y ?? scene.h / 2 };
            const n = frames(sec), step = 3;
            for (let k = 0; k < n; k++) {
                if (k % step === 0) {
                    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: dy * step / n });
                    await sleep(60);
                    await capture();
                }
                push();
            }
            await sleep(300);
            await capture();
        },
        // Zooms the picture onto a target (factor 1.5-3, or 'fit' for a box [x, y, w, h] with a margin) or back to the
        // whole view (null), over sec
        async zoom(target, factor = 2, sec = 0.8) {
            const full = [0, 0, scene.w, scene.h];
            let to = full;
            if (target) {
                if (factor === 'fit') factor = Math.min(3.5, Math.max(1, 0.92 * Math.min(scene.w / target[2], scene.h / target[3])));
                const c = Array.isArray(target) ? { x: target[0] + target[2] / 2, y: target[1] + target[3] / 2 } : await r.find(target);
                const w = scene.w / factor, h = scene.h / factor;
                to = [Math.min(Math.max(c.x - w / 2, 0), scene.w - w), Math.min(Math.max(c.y - h / 2, 0), scene.h - h), w, h];
            }
            const from = zoom || full;
            const n = frames(sec);
            for (let k = 1; k <= n; k++) {
                const e = ease(k / n);
                zoom = from.map((v, j) => v + (to[j] - v) * e);
                push();
            }
            if (!target) zoom = null;
        },
        // Dims everything but this element's box (or a box [x, y, w, h]), until highlight(null)
        async highlight(target, pad = 6) {
            if (!target) { light = null; return; }
            const b = Array.isArray(target) ? target : (await r.find(target)).box;
            light = [b[0] - pad, b[1] - pad, b[2] + 2 * pad, b[3] + 2 * pad].map(Math.round);
        },
        // Holds the frames until the page's expression is true (at most sec)
        async until(expr, sec = 15) {
            for (let k = 0; k < sec * 10; k++) {
                if (await js(expr)) { await capture(); return r.hold(0.2); }
                await capture();
                for (let j = 0; j < 3; j++) push();
                await sleep(100);
            }
            throw new Error(`still waiting for: ${expr}`);
        },
        hideCursor() { cursor = null; },
        capture,
        take
    };
    return r;
}

async function recordLesson(lesson, lang) {
    const dir = path.join(WORK, 'takes', `${lesson.name}-${lang}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const page = await launch({ port: Number(process.env.FLYBOT_CDP_PORT) || 9339, profile: path.join(WORK, 'profile') });
    try {
        // Fake identities and a stand-in serial port for the flasher; the camera's language for the pages
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(here, 'inject.js'), 'utf8').replace('__LANG__', lang) });
        // The mock camera and the FlyBot demo are in Vietnam
        await page.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Ho_Chi_Minh' });
        const r = recorder(page, dir, lang);
        const started = Date.now();
        await lesson.run(r);
        fs.writeFileSync(path.join(dir, 'take.json'), JSON.stringify({ name: lesson.name, title: r.t(...lesson.title), ...r.take }));
        console.log(`${lesson.name}-${lang}: ${(r.take.frames.length / FPS).toFixed(1)} s, ${r.take.images} pictures, recorded in ${Math.round((Date.now() - started) / 1000)} s`);
    } finally {
        await page.close();
    }
    return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [, , which = 'all', lang = 'en'] = process.argv;
    const list = which === 'all' ? LESSONS : LESSONS.filter(l => which.split(',').includes(l.name));
    if (!list.length) throw new Error(`no lesson ${which}: ${LESSONS.map(l => l.name).join(', ')}`);
    const srv = await staticServer();
    try {
        for (const lesson of list) await recordLesson(lesson, lang);
    } finally {
        srv.close();
    }
}
