// Screen recordings of the live app for the demo film, as JPEG frames with their times (Page.startScreencast).
// Every page gets inject.js first: the privacy mask (rules from privacy.local.json, not versioned), a drawn
// cursor and click ripples. A take stops and its frames are deleted as soon as a masked value shows up
// unmasked anywhere in the page.
//
//   node record-app.mjs explore <path>...       guest session: a screenshot and the clickable texts of each page
//   node record-app.mjs guest <shot|all>...     guest takes (shots.mjs), in a headless Chrome
//   node record-app.mjs browser                 opens a Chrome window on the sign-in page, for the owner to sign in
//   node record-app.mjs owner <shot|all>...     owner takes, driven in that window (it must stay open)
//
// FLYBOT_FILM_URL: the app (default https://flybot.agrhub.com). FLYBOT_FILM_MEDIA: the media folder (default
// ./media; frames go to <media>/rec/<shot>/). The owner's window uses its own profile in <media>/profile and
// debugging port FLYBOT_FILM_OWNER_PORT (9555); nobody types a password from here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { launch, attach, sleep } from '../cdp.mjs';
import { SHOTS } from './shots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BASE = (process.env.FLYBOT_FILM_URL || 'https://flybot.agrhub.com').replace(/\/$/, '');
export const MEDIA = path.resolve(process.env.FLYBOT_FILM_MEDIA || path.join(here, 'media'));
const OWNER_PORT = Number(process.env.FLYBOT_FILM_OWNER_PORT) || 9555;
const GUEST_PORT = Number(process.env.FLYBOT_CDP_PORT) || 9441;
const W = 1920, H = 1080;

// privacy.local.json: { "rules": [{ "find": "regex", "flags": "gi", "replace": "text" }], "emailOk": "regex" }
function privacyRules() {
    const file = path.join(here, 'privacy.local.json');
    if (!fs.existsSync(file)) throw new Error(`${file} is missing: copy privacy.example.json and fill in the values to mask`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function prepare(page) {
    const p = privacyRules();
    const boot = `window.__FILM_RULES = ${JSON.stringify(p.rules || [])};` +
        (p.emailOk ? `window.__FILM_EMAIL_OK = ${JSON.stringify(p.emailOk)};` : '') +
        // English, and no first-visit tour over the recording
        `try { localStorage.setItem('flybot_language', 'en'); localStorage.setItem('flybot_tour_done', '1'); } catch (e) {}\n` +
        fs.readFileSync(path.join(here, 'inject.js'), 'utf8');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: boot });
    await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    // The page that is open already gets the script too
    await page.send('Runtime.evaluate', { expression: boot }).catch(() => {});
}

// Actions a shot uses. Coordinates are CSS pixels of the 1920x1080 page.
function actions(page) {
    let mouse = { x: W * 0.6, y: H * 0.55 };
    const js = async (expr) => page.eval(expr);
    const a = {
        page,
        sleep,
        js,
        async goto(p, settle = 2500) {
            await page.goto(p.startsWith('http') ? p : BASE + p, settle);
            await js(`window.__filmCursor(${mouse.x}, ${mouse.y}); return true;`).catch(() => {});
        },
        // The centre of an element: { sel } or { text, sel? } (the smallest visible element containing the text)
        async find(target, { scroll = true, timeout = 15000 } = {}) {
            const t = typeof target === 'string' ? { text: target } : target;
            const expr = `
                const t = ${JSON.stringify(t)};
                const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
                let els = [...document.querySelectorAll(t.sel || 'button, a, [role=button], [role=tab], [role=menuitem], .el-menu-item, .el-tabs__item, .el-checkbox, .el-radio-button, .el-select, .el-option, .el-dropdown-menu__item, li, label, span, div, td, p, h1, h2, h3, h4')].filter(vis);
                if (t.text) {
                    const want = t.text.toLowerCase();
                    els = els.filter(e => (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').toLowerCase().includes(want));
                    if (t.exact) els = els.filter(e => (e.innerText || '').trim().toLowerCase() === want);
                    els.sort((x, y) => (x.innerText || '').length - (y.innerText || '').length);
                }
                if (t.within) els = els.filter(e => e.closest(t.within));
                const el = els[t.index || 0];
                if (!el) return null;
                if (${scroll}) { const b = el.getBoundingClientRect(); if (b.top < 70 || b.bottom > innerHeight - 20) { el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 500)); } }
                const b = el.getBoundingClientRect();
                return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };`;
            const until = Date.now() + timeout;
            for (;;) {
                const r = await js(expr);
                if (r) return r;
                if (Date.now() > until) throw new Error(`not found: ${JSON.stringify(t)}`);
                await sleep(300);
            }
        },
        // Moves the drawn cursor and the real mouse there, eased, in about ms
        async move(target, ms = 700) {
            const to = typeof target.x === 'number' ? target : await a.find(target);
            const from = { ...mouse };
            const steps = Math.max(8, Math.round(ms / 16));
            for (let i = 1; i <= steps; i++) {
                const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
                const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
                await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
                await js(`window.__filmCursor(${x}, ${y}); return true;`);
                await sleep(ms / steps);
            }
            mouse = { x: to.x, y: to.y };
            return to;
        },
        async click(target, { ms = 700, after = 900 } = {}) {
            const to = await a.move(target, ms);
            await sleep(150);
            await js(`window.__filmRipple(${to.x}, ${to.y}); return true;`);
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: to.x, y: to.y, button: 'left', clickCount: 1 });
            await sleep(70);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
            await sleep(after);
            return to;
        },
        async type(text, perChar = 70) {
            for (const ch of text) {
                await page.send('Input.insertText', { text: ch });
                await sleep(perChar);
            }
        },
        async key(key, code = key, keyCode = 13) {
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
        },
        // Smooth wheel scrolling at the cursor (or at target)
        async scroll(dy, { target = null, ms = 1200 } = {}) {
            if (target) await a.move(target, 500);
            const steps = Math.max(6, Math.round(ms / 50));
            for (let i = 0; i < steps; i++) {
                await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mouse.x, y: mouse.y, deltaX: 0, deltaY: dy / steps });
                await sleep(ms / steps);
            }
        },
        highlight: (sel, on = true) => js(`window.__filmHighlight(${JSON.stringify(sel)}, ${on}); return true;`)
    };
    return a;
}

// One take: frames of the page while the shot runs
async function take(page, shot) {
    const dir = path.join(MEDIA, 'rec', shot.name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const a = actions(page);
    if (shot.before) await shot.before(a);
    const frames = [];
    let t0 = null, leak = null, n = 0;
    const off = page.on((m) => {
        if (m.method !== 'Page.screencastFrame') return;
        const { data, metadata, sessionId } = m.params;
        page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (leak) return;
        const ts = metadata.timestamp;
        if (t0 === null) t0 = ts;
        const file = `f${String(n++).padStart(5, '0')}.jpg`;
        fs.writeFileSync(path.join(dir, file), Buffer.from(data, 'base64'));
        frames.push({ f: file, t: +(ts - t0).toFixed(3) });
    });
    const watch = setInterval(async () => {
        try {
            const found = await page.eval('return window.__filmLeaks ? window.__filmLeaks() : [];');
            if (found.length && !leak) leak = found;
        } catch { /* page navigating */ }
    }, 250);
    await page.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    // A still first frame, even when nothing moves
    await page.eval(`window.__filmCursor(${W * 0.6}, ${H * 0.55}); return true;`).catch(() => {});
    let error = null;
    try {
        await shot.run(a);
        await sleep(600);
    } catch (e) { error = e; }
    await page.send('Page.stopScreencast').catch(() => {});
    clearInterval(watch);
    off();
    if (leak) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`${shot.name}: masked value visible (${leak.join(', ')}); the take was deleted`);
    }
    if (error) throw new Error(`${shot.name}: ${error.message}`);
    const duration = frames.length ? frames[frames.length - 1].t : 0;
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ shot: shot.name, width: W, height: H, duration, frames }, null, 0));
    console.log(`${shot.name}: ${frames.length} frames, ${duration.toFixed(1)} s`);
}

// Every take, even when one fails; the failures are listed at the end
async function takeAll(page, shots) {
    const failed = [];
    for (const shot of shots) {
        try { await take(page, shot); } catch (e) { failed.push(e.message); console.log('FAILED', e.message); }
    }
    if (failed.length) { console.log(`${failed.length} take(s) failed`); process.exitCode = 1; }
}

async function guestSignIn(page) {
    const a = actions(page);
    await a.goto('/auth/login', 3000);
    await a.click({ text: 'Guest access', sel: 'button' }, { after: 5000 });
    const where = await page.eval('return location.pathname;');
    if (where.startsWith('/auth')) throw new Error('guest sign-in failed (still on the sign-in page)');
    return a;
}

const [, , mode, ...names] = process.argv;
const pick = (session) => {
    const list = SHOTS.filter(s => s.session === session);
    return !names.length || names.includes('all') ? list : names.map(n => list.find(s => s.name === n) || (() => { throw new Error(`no ${session} shot ${n}`); })());
};

if (mode === 'browser') {
    // A window of its own that outlives this script (Windows "start"), with its own profile
    const profile = path.join(MEDIA, 'profile');
    const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    const args = [`--remote-debugging-port=${OWNER_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-sync', '--window-size=1600,1000',
        // Keep painting (and so recording) while the window is behind others
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
        BASE + '/auth/login'];
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', chrome, ...args], { stdio: 'ignore', detached: true }).unref();
    else spawn(chrome, args, { stdio: 'ignore', detached: true }).unref();
    console.log(`Chrome is open on ${BASE}/auth/login (port ${OWNER_PORT}). Sign in there, then run: node record-app.mjs owner all`);
} else if (mode === 'owner') {
    const page = await attach(OWNER_PORT);
    try {
        await prepare(page);
        await takeAll(page, pick('owner'));
    } finally { await page.close(); }
} else if (mode === 'guest' || mode === 'explore') {
    const page = await launch({ port: GUEST_PORT, profile: path.join(MEDIA, 'guest-profile') });
    try {
        await prepare(page);
        const shots = mode === 'guest' ? pick('guest') : [];
        // The guest-login take signs in itself; otherwise sign in first, off camera
        const a = shots[0]?.name === 'guest-login' ? actions(page) : await guestSignIn(page);
        if (mode === 'guest') {
            await takeAll(page, shots);
        } else {
            const out = path.join(MEDIA, 'explore');
            fs.mkdirSync(out, { recursive: true });
            for (const p of names) {
                await a.goto(p, 6000);
                const name = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
                await page.shot(path.join(out, `${name}.jpg`), { format: 'jpeg', quality: 80 });
                const info = await page.eval(`
                    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
                    const txt = (sel) => [...document.querySelectorAll(sel)].filter(vis).map(e => (e.innerText || e.placeholder || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60)).filter(Boolean);
                    return { url: location.href, h: txt('h1, h2, h3, .el-card__header'), buttons: txt('button, [role=tab], .el-tabs__item, a'), inputs: txt('input, .el-select'), leaks: window.__filmLeaks() };`);
                fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(info, null, 1));
                console.log(name, info.url, 'leaks:', info.leaks.join(',') || 'none');
            }
        }
    } finally { await page.close(); }
} else {
    console.log('usage: node record-app.mjs explore <path>... | guest <shot|all>... | browser | owner <shot|all>...');
    process.exit(2);
}
