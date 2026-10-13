// End-to-end smoke test: the demo (tools/media: API with an in-memory database and seeded farm
// data, Vite dev server) in headless Chrome. Opens every main page and checks the main flows.
// Nothing here touches a real database or outside service.
// Run: npm run test:e2e -w client   (needs Google Chrome, ~500 MB free for MongoDB)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MEDIA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/media');
const BASE = 'http://localhost:3010';
const TMP = path.join(os.tmpdir(), 'flybot-e2e');
// Its own Chrome port and profile, so it can run next to the screenshot scripts
process.env.FLYBOT_CDP_PORT ||= '9444';
process.env.FLYBOT_SHOT_PROFILE ||= path.join(TMP, 'chrome');
const { launch, sleep } = await import(pathToFileURL(path.join(MEDIA, 'cdp.mjs')).href);

const children = [];
let page;
const errors = [];

const portFree = (port) => new Promise(res => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port);
});

function start(script, ready, env = {}) {
  const child = spawn(process.execPath, [script], { cwd: MEDIA, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start:\n${log.slice(-2000)}`)), 240000);
    const onData = (d) => { log += d; if (log.includes(ready)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${script} exited (${code}):\n${log.slice(-2000)}`)); });
  });
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // The API's MongoDB runs as a child of it: stop the whole tree
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch { /* already gone */ }
  }
}

before(async () => {
  for (const port of [3013, 3010]) {
    assert.ok(await portFree(port), `port ${port} is in use: stop the demo (or whatever uses it) first`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  await start('demo-server.js', 'Demo API on', { FLYBOT_DEMO_DB: path.join(TMP, 'db'), DEMO_LANG: 'vi' });
  await start('demo-client.mjs', 'demo client on');

  page = await launch();
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      // The demo has no camera streams: the players say so, as they would for an offline camera
      if (!/Demo: no (live|recording) stream/.test(text)) errors.push(text);
    }
  });
  await page.viewport(1440, 900);
  await page.goto(`${BASE}/auth/login`, 3000);
  const { manager } = JSON.parse(fs.readFileSync(path.join(MEDIA, 'demo-tokens.json'), 'utf8'));
  await page.eval(`localStorage.setItem('token', ${JSON.stringify(manager.token)});
    localStorage.setItem('user', ${JSON.stringify(JSON.stringify(manager.user))});
    localStorage.setItem('flybot_language', 'vi');
    localStorage.setItem('flybot_tour_done', '1'); return true;`);
}, { timeout: 600000 });

after(async () => {
  if (page) await page.close();
  stopAll();
  await sleep(1000);
  fs.rmSync(path.join(MEDIA, 'demo-tokens.json'), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

// Wait until the page shows `text` (or the time runs out)
const waitForText = (text, ms = 20000) => page.eval(`
  for (let i = 0; i < ${Math.ceil(ms / 250)}; i++) {
    if (document.body.innerText.includes(${JSON.stringify(text)})) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;`);

test('every main page opens without a script error', { timeout: 300000 }, async () => {
  const pages = ['/dashboard', '/cameras', '/analytics', '/reports', '/farms', '/logbook', '/map', '/settings?tab=notifications'];
  const problems = [];
  for (const url of pages) {
    errors.length = 0;
    await page.goto(BASE + url, 1000);
    // The dev server compiles a page the first time it is opened: wait for its content
    const shown = await page.eval(`
      for (let i = 0; i < 120 && document.body.innerText.length < 200; i++) await new Promise(r => setTimeout(r, 250));
      await new Promise(r => setTimeout(r, 1500));
      return { text: document.body.innerText.length, login: location.pathname.startsWith('/auth') };`);
    if (shown.login) problems.push(`${url}: sent to sign-in`);
    if (shown.text < 200) problems.push(`${url}: almost empty`);
    for (const e of errors) problems.push(`${url}: ${String(e).split('\n')[0]}`);
  }
  assert.deepEqual(problems, []);
});

test('the overview shows the area still inside its pre-harvest interval', { timeout: 60000 }, async () => {
  await page.goto(`${BASE}/dashboard`, 2000);
  assert.ok(await waitForText('đang trong thời gian cách ly'), 'withholding alert');
  assert.ok(await waitForText('Lô thanh long C'));
  await page.eval(`[...document.querySelectorAll('.el-alert button')].find(b => b.innerText.includes('Mở nhật ký vườn')).click(); return true;`);
  assert.equal(await page.eval(`
    for (let i = 0; i < 80 && location.pathname !== '/logbook'; i++) await new Promise(r => setTimeout(r, 250));
    return location.pathname;`), '/logbook');
});

test('the field log sends last month\'s VietGAP record', { timeout: 60000 }, async () => {
  await page.goto(`${BASE}/logbook`, 2500);
  assert.ok(await waitForText('Radiant 60SC'), 'treatments listed');
  assert.ok(await waitForText('Hiệu quả theo hoạt chất'), 'effect by ingredient');
  assert.ok(await waitForText('Spinetoram'));
  await page.eval(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('Gửi sổ tháng trước')).click(); return true;`);
  assert.ok(await waitForText('Đang gửi sổ tháng'), 'sent message');
});

test('the monthly VietGAP switch is saved', { timeout: 60000 }, async () => {
  await page.goto(`${BASE}/settings?tab=notifications`, 3000);
  assert.ok(await waitForText('Sổ VietGAP hằng tháng'));
  await page.eval(`const card = [...document.querySelectorAll('.el-card')].filter(c => c.innerText.includes('Sổ VietGAP hằng tháng')).pop();
    const sw = card.querySelector('.el-switch'); if (!sw.classList.contains('is-checked')) sw.click();
    await new Promise(r => setTimeout(r, 1500)); return true;`);
  const prefs = await page.eval(`const r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    const body = await r.json(); return (body.user || body).notificationPrefs;`);
  assert.equal(prefs.vietgapMonthly, true);
});

test('on a phone the pages fit the screen', { timeout: 120000 }, async () => {
  await page.viewport(390, 844, true);
  const wide = [];
  for (const url of ['/dashboard', '/logbook', '/farms', '/settings?tab=notifications']) {
    await page.goto(BASE + url, 3000);
    const { scroll, width } = await page.eval('return { scroll: document.documentElement.scrollWidth, width: innerWidth };');
    if (scroll > width + 1) wide.push(`${url}: ${scroll}px wide`);
  }
  await page.viewport(1440, 900);
  assert.deepEqual(wide, []);
});
