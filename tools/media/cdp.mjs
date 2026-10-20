// Minimal Chrome DevTools Protocol helper: headless Chrome with a throwaway profile
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Removed and recreated on every launch
const PROFILE = process.env.FLYBOT_SHOT_PROFILE || path.join(os.tmpdir(), 'flybot-shot-profile');
// Set FLYBOT_CDP_PORT to run two of these scripts at once
const PORT = Number(process.env.FLYBOT_CDP_PORT) || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// keepProfile: reuse the previous run's profile (service worker, caches); args: extra Chrome flags;
// profile and port: another profile folder and debugging port than the defaults (two scripts at once)
export async function launch({ keepProfile = false, args = [], profile = PROFILE, port = PORT } = {}) {
    if (!keepProfile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    // FLYBOT_CHROME_ARGS: extra flags from the environment (e.g. --no-sandbox on CI runners)
    const extra = (process.env.FLYBOT_CHROME_ARGS || '').split(' ').filter(Boolean);
    const proc = spawn(CHROME, [...extra, ...args,
        '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
        '--disable-extensions', '--disable-background-networking', '--disable-sync',
        // No crash handler: it outlives Chrome on Windows and keeps the profile folder locked
        '--disable-crash-reporter', '--disable-breakpad',
        '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900', 'about:blank'
    ], { stdio: 'ignore' });
    return connect({ port, proc, profile });
}

// Drives a Chrome that is already running with --remote-debugging-port (e.g. a window where a person signed in).
// close() only disconnects: the window stays open.
export async function attach(port = PORT) {
    return connect({ port, proc: null, profile: null });
}

async function connect({ port, proc, profile }) {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
        await sleep(200);
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            target = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
        } catch { /* not up yet */ }
    }
    if (!target) throw new Error('Chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
            for (const l of listeners) l(msg);
        }
    };
    // A crashed or closed Chrome never answers: fail every call at once instead of hanging the script
    let closed = null;
    const failAll = (reason) => {
        closed ||= reason;
        for (const { reject } of pending.values()) reject(new Error(reason));
        pending.clear();
    };
    ws.onclose = () => failAll(`Chrome connection closed${proc && proc.exitCode !== null ? ` (Chrome exited with ${proc.exitCode})` : ''}`);
    if (proc) proc.once('exit', (code, signal) => failAll(`Chrome exited (${signal || code})`));
    // FLYBOT_CDP_TIMEOUT: longest wait for one call, 120 s by default (an eval may wait for the page)
    const TIMEOUT = Number(process.env.FLYBOT_CDP_TIMEOUT) || 120000;
    const send = (method, params = {}, ms = TIMEOUT) => new Promise((resolve, reject) => {
        if (closed) return reject(new Error(closed));
        const n = ++id;
        const timer = setTimeout(() => {
            pending.delete(n);
            const what = method === 'Runtime.evaluate' ? `: ${String(params.expression).replace(/\s+/g, ' ').slice(0, 120)}` : '';
            reject(new Error(`${method} got no answer in ${ms / 1000} s${what}`));
        }, ms);
        const done = (fn) => (value) => { clearTimeout(timer); fn(value); };
        pending.set(n, { resolve: done(resolve), reject: done(reject) });
        ws.send(JSON.stringify({ id: n, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');

    const page = {
        send,
        on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        async viewport(width, height, mobile = false) {
            // FLYBOT_SHOT_SCALE=2 takes sharper (larger) screenshots, e.g. as video sources
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(process.env.FLYBOT_SHOT_SCALE) || 1, mobile });
            if (mobile) await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
            else await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });
        },
        async goto(url, settle = 2500) {
            const loaded = new Promise(res => { const off = page.on(m => { if (m.method === 'Page.loadEventFired') { off(); res(); } }); });
            // A dev server that is still bundling can leave a navigation unanswered: stop and try once more
            try {
                await send('Page.navigate', { url }, 30000);
            } catch (err) {
                if (!/no answer/.test(err.message)) throw err;
                await send('Page.stopLoading', {}, 10000).catch(() => {});
                await send('Page.navigate', { url }, 30000);
            }
            await Promise.race([loaded, sleep(15000)]);
            await sleep(settle);
        },
        async eval(expression) {
            const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result?.value;
        },
        // clip: [x, y, width, height] in CSS pixels, for a part of the page
        async shot(file, { format = 'webp', quality = Number(process.env.FLYBOT_SHOT_QUALITY) || 82, clip = null } = {}) {
            const { data } = await send('Page.captureScreenshot', { format, quality, ...(clip ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 1 } } : {}) });
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            return fs.statSync(file).size;
        },
        async close() {
            if (!proc) { ws.close(); return; }
            // Closing never answers: do not wait for it
            ws.send(JSON.stringify({ id: ++id, method: 'Browser.close' }));
            ws.close();
            const exited = new Promise(res => proc.once('exit', res));
            await Promise.race([exited, sleep(5000)]);
            try { proc.kill(); } catch { /* gone */ }
            await sleep(500);
            try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* removed next launch */ }
        }
    };
    return page;
}

export { sleep };
