// Minimal Chrome DevTools Protocol helper: headless Chrome with a throwaway profile
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Removed and recreated on every launch
const PROFILE = process.env.FLYBOT_SHOT_PROFILE || path.join(os.tmpdir(), 'flybot-shot-profile');
const PORT = 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function launch() {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    const proc = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
        '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
        '--disable-extensions', '--disable-background-networking', '--disable-sync',
        '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900', 'about:blank'
    ], { stdio: 'ignore' });
    let target;
    for (let i = 0; i < 50 && !target; i++) {
        await sleep(200);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find(t => t.type === 'page');
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
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');

    const page = {
        send,
        on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        async viewport(width, height, mobile = false) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
            if (mobile) await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
            else await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });
        },
        async goto(url, settle = 2500) {
            const loaded = new Promise(res => { const off = page.on(m => { if (m.method === 'Page.loadEventFired') { off(); res(); } }); });
            await send('Page.navigate', { url });
            await Promise.race([loaded, sleep(15000)]);
            await sleep(settle);
        },
        async eval(expression) {
            const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result?.value;
        },
        async shot(file, { format = 'webp', quality = 82 } = {}) {
            const { data } = await send('Page.captureScreenshot', { format, quality });
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            return fs.statSync(file).size;
        },
        async close() {
            // Closing never answers: do not wait for it
            ws.send(JSON.stringify({ id: ++id, method: 'Browser.close' }));
            ws.close();
            const exited = new Promise(res => proc.once('exit', res));
            await Promise.race([exited, sleep(5000)]);
            try { proc.kill(); } catch { /* gone */ }
            await sleep(500);
            try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* removed next launch */ }
        }
    };
    return page;
}

export { sleep };
