// Screenshots of the demo for the guide (client/public/manual/<lang>) and the product tour: node shoot.mjs <outdir> <names|all> <vi|en>
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2];
const only = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3].split(',') : null;
const LANG = process.argv[4] === 'en' ? 'en' : 'vi';
// Button and section labels the actions look for, per language
const W = (vi, en) => (LANG === 'en' ? en : vi);
const tokens = JSON.parse(fs.readFileSync(new URL('./demo-tokens.json', import.meta.url), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

// In-page helpers, prepended to every action
const H = `
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const byText = (sel, text) => [...document.querySelectorAll(sel)].find(e => e.innerText && e.innerText.trim().includes(text));
const click = async (sel, text, wait = 800) => { const el = text ? byText(sel, text) : document.querySelector(sel); if (!el) throw new Error('not found: ' + sel + ' ' + (text || '')); el.click(); await sleep(wait); };
const top = (el, offset = 72) => { const r = el.getBoundingClientRect(); (document.querySelector('main.overflow-y-auto') || document.scrollingElement).scrollBy(0, 0); el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -offset); };
`;

const SHOW_STILL = `
  document.querySelectorAll('.aspect-video, .live-tab, [class*="player"]').forEach(box => {
    [...box.querySelectorAll('div')].filter(d => /Demo: no live stream/.test(d.innerText || '') && d.children.length < 6 && !d.querySelector('.aspect-video'))
      .forEach(d => { const o = d.closest('.absolute') || d; o.style.display = 'none'; });
    box.querySelectorAll('img').forEach(img => { img.style.opacity = '1'; });
  });`;

// Camera page: the latest trap photo in the player (the demo has no video stream)
const LIVE_STILL = `
  const serial = (document.querySelector('.cameras-meta.font-mono')?.innerText || '').replace('SN:', '').trim();
  const res = await fetch('/api/ai/results?limit=1&deviceSerials=' + serial, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }).then(r => r.json());
  const item = res.results?.[0]; const box = document.querySelector('.live-tab__viewport');
  if (item && box) {
    box.querySelector('.live-tab__scrim')?.remove();
    const img = document.createElement('img'); img.src = '/api/s3/' + item.s3Key;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
    box.appendChild(img); await sleep(1500);
  }
  document.querySelectorAll('.live-tab__value').forEach(e => { if (/Mất kết nối|Disconnected/.test(e.innerText)) e.innerText = ${JSON.stringify(LANG === 'en' ? 'Live' : 'Trực tiếp')}; });`;

// Assistant: a fresh conversation, one question, the answer scrolled into view (the demo's
// stand-in model picks the tool from the question)
const ASK = (question, wait = 6000) => `
  const panel = () => document.getElementById('smart-trap-assistant-sidebar');
  if (!panel() || getComputedStyle(panel()).display === 'none') { document.querySelector('[data-tour="assistant"]').click(); await sleep(1200); }
  panel().querySelector('.assistant-header button').click(); await sleep(800);
  const input = panel().querySelector('form input');
  input.value = ${JSON.stringify(question)}; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);
  input.closest('form').requestSubmit(); await sleep(1500);
  for (let i = 0; i < 90 && document.querySelector('#smart-trap-assistant-sidebar .thinking'); i++) await sleep(500); await sleep(1500);
  const box = panel().querySelector('.overflow-y-auto'); box.scrollTop = box.scrollHeight; await sleep(600);
  document.querySelectorAll('.el-notification').forEach(n => n.remove());`;

// "Ask the assistant about this photo" from the history's photo window
const PHOTO_ASK = `
        const panel = document.getElementById('smart-trap-assistant-sidebar');
        if (panel && getComputedStyle(panel).display !== 'none') { panel.querySelector('.assistant-header button').click(); await sleep(800); }
        for (let i = 0; i < 40 && !document.querySelector('.el-table__body .el-button'); i++) await sleep(500);
        document.querySelector('.el-table__body .el-button').click(); await sleep(1500);
        await click('.el-dialog button', ${JSON.stringify(W('Hỏi trợ lý', 'Ask the assistant'))}, 1500);
        for (let i = 0; i < 90 && document.querySelector('#smart-trap-assistant-sidebar .thinking'); i++) await sleep(500); await sleep(1500);
        const box = document.getElementById('smart-trap-assistant-sidebar').querySelector('.overflow-y-auto'); box.scrollTop = box.scrollHeight; await sleep(600);
        document.querySelectorAll('.el-notification').forEach(n => n.remove());`;

const DESKTOP = [1440, 900];
const MOBILE = [390, 844];

const shots = [
    { name: 'dashboard', url: '/dashboard', settle: 6000 },
    { name: 'diagnosis', url: '/dashboard', action: `
        const b = [...document.querySelectorAll('.el-card button')].find(b => b.innerText.includes(${JSON.stringify(W('Chẩn đoán lại bằng AI', 'Re-evaluate with AI'))}));
        b.click(); for (let i = 0; i < 40 && !document.querySelector('.dd-panel'); i++) await sleep(300);
        await sleep(1500); document.querySelectorAll('.el-notification').forEach(n => n.remove());
        document.querySelector('.dd-panel').closest('.el-card').scrollIntoView({ block: 'start' }); await sleep(600);` },
    { name: 'cameras', url: '/cameras', settle: 20000, action: SHOW_STILL },
    { name: 'add-camera', url: '/cameras', action: `await click('button', ${JSON.stringify(W('Thêm camera', 'Add Camera'))}, 1200);` },
    { name: 'camera-detail', url: '/cameras', action: `
        await click('button', ${JSON.stringify(W('Xem chi tiết', 'Details'))}, 3500);
        ${LIVE_STILL}
        document.querySelector('.playback')?.scrollIntoView({ block: 'end' }); await sleep(800);` },
    { name: 'camera-info', url: '/cameras', action: `
        await click('button', ${JSON.stringify(W('Xem chi tiết', 'Details'))}, 3000);
        ${LIVE_STILL}
        await click('button', ${JSON.stringify(W('Thông tin nhanh', 'Quick Info'))}, 1500);` },
    { name: 'playback', url: '/cameras', action: `
        await click('button', ${JSON.stringify(W('Xem chi tiết', 'Details'))}, 3000);
        for (let i = 0; i < 30 && !document.querySelector('.playback__clip'); i++) await sleep(300);
        await sleep(1500);
        const clips = document.querySelectorAll('.playback__clip'); clips[Math.min(4, clips.length - 1)]?.click(); await sleep(1500);
        const c = document.querySelector('.playback'); c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -90);
        (document.querySelector('main.overflow-y-auto') || document.scrollingElement).scrollBy(0, -90); await sleep(800);` },
    { name: 'camera-history', url: '/cameras', action: `
        await click('button', ${JSON.stringify(W('Xem chi tiết', 'Details'))}, 3000);
        const h = document.querySelector('.history-card'); h.scrollIntoView({ block: 'start' }); await sleep(2500);` },
    { name: 'maintenance', url: '/cameras', action: `
        await click('button', ${JSON.stringify(W('Xem chi tiết', 'Details'))}, 2500);
        const c = [...document.querySelectorAll('.el-card')].find(e => e.innerText.includes(${JSON.stringify(W('Bảo trì bẫy', 'Trap maintenance'))}));
        c?.scrollIntoView({ block: 'start' }); await sleep(800);` },
    { name: 'camera-settings', url: '/settings?tab=cameras' },
    { name: 'analytics', url: '/analytics', settle: 4000 },
    { name: 'history', url: '/analytics', action: `
        await click('.el-tabs__item', ${JSON.stringify(W('Lịch sử', 'History'))}, 3000);` },
    { name: 'history-export', url: '/analytics', action: `
        await click('.el-tabs__item', ${JSON.stringify(W('Lịch sử', 'History'))}, 3000);
        await click('.history-card button', ${JSON.stringify(W('Xuất dữ liệu', 'Export'))}, 1200);` },
    { name: 'widget-filter', url: '/analytics', settle: 4000, action: `
        const b = [...document.querySelectorAll('button[aria-label]')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(W('Bộ lọc của khối này', 'This widget’s filters'))});
        b.click(); await sleep(1200);` },
    { name: 'reports', url: '/reports', action: `
        document.querySelector('.dash-card').click(); await sleep(7000);` },
    { name: 'report-share', url: '/reports', action: `
        document.querySelector('.dash-card').click(); await sleep(5000);
        await click('button', ${JSON.stringify(W('Chia sẻ', 'Share'))}, 1500);` },
    { name: 'dashboard-cameras', url: '/dashboard', settle: 6000, action: `
        for (let i = 0; i < 30 && document.querySelectorAll('.roster-card .snap__img').length < 3; i++) await sleep(300);
        const c = document.querySelector('.roster-card').closest('.el-card:not(.roster-card)'); c.scrollIntoView({ block: 'start' }); await sleep(1000);` },
    { name: 'detection', url: '/analytics', action: `
        await click('.el-tabs__item', ${JSON.stringify(W('Lịch sử', 'History'))}, 2500);
        const view = document.querySelector('.el-table__body button'); view.click(); await sleep(3500);` },
    { name: 'insights', url: '/analytics', action: `
        await click('.el-tabs__item', ${JSON.stringify(W('Phân tích chuyên sâu', 'Insights'))}, 4000);` },
    { name: 'insights-table', url: '/analytics', action: `
        await click('.el-tabs__item', ${JSON.stringify(W('Phân tích chuyên sâu', 'Insights'))}, 4000);
        const c = [...document.querySelectorAll('.el-card')].find(e => e.innerText.includes(${JSON.stringify(W('Tổng hợp từng bẫy', 'Trap summary'))}));
        c?.scrollIntoView({ block: 'start' }); await sleep(800);` },
    { name: 'catch-chart', url: '/dashboard', settle: 6000, action: `
        const c = [...document.querySelectorAll('.el-card')].find(e => e.innerText.includes(${JSON.stringify(W('Ruồi vào bẫy 14 ngày qua', 'Flies caught in the last 14 days'))}));
        c?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); await sleep(1000);` },
    { name: 'report-schedule', url: '/reports', action: `
        document.querySelector('.dash-card').click(); await sleep(5000);
        [...document.querySelectorAll('button')].find(b => b.classList.contains('is-circle') && b.closest('.el-dropdown')).click(); await sleep(800);
        await click('.el-dropdown-menu__item', ${JSON.stringify(W('Gửi định kỳ', 'Email on a schedule'))}, 1000);
        const dialog = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent);
        [...dialog.querySelectorAll('.el-radio-button')].find(b => b.innerText.includes(${JSON.stringify(W('Hằng tuần', 'Weekly'))})).click(); await sleep(800);` },
    { name: 'app-tour', url: '/dashboard', settle: 4000, action: `
        document.querySelector('[data-tour="profile"]').click(); await sleep(800);
        await click('.el-dropdown-menu__item', ${JSON.stringify(W('Hướng dẫn nhanh', 'Quick tour'))}, 1500);
        for (let i = 0; i < 5; i++) { [...document.querySelectorAll('.el-tour button')].find(b => b.className.includes('primary') || /Tiếp|Next/.test(b.innerText)).click(); await sleep(700); }` },
    { name: 'assistant', url: '/dashboard', settle: 4000, action: ASK(W('Ảnh mới nhất của các bẫy?', 'Latest photos of the traps?')) },
    { name: 'assistant-chart', url: '/dashboard', settle: 4000, action: ASK(W('24 giờ qua thế nào?', 'How were the last 24 hours?')) },
    { name: 'assistant-confirm', url: '/dashboard', settle: 4000, action: ASK(W('Tôi đã thay tấm keo bẫy xoài A1', 'I replaced the card on mango trap A1')) },
    { name: 'assistant-photo', url: '/analytics?tab=history', settle: 4000, action: PHOTO_ASK },
    // The chat panel alone, for slides (same scenes as above)
    { name: 'chat-photos', url: '/dashboard', settle: 4000, clip: [1021, 100, 419, 620], action: ASK(W('Ảnh mới nhất của các bẫy?', 'Latest photos of the traps?')) },
    { name: 'chat-chart', url: '/dashboard', settle: 4000, clip: [1021, 210, 419, 470], action: ASK(W('24 giờ qua thế nào?', 'How were the last 24 hours?')) },
    { name: 'chat-photo', url: '/analytics?tab=history', settle: 4000, clip: [1021, 110, 419, 580], action: PHOTO_ASK },
    { name: 'chat-confirm', url: '/dashboard', settle: 4000, clip: [1021, 210, 419, 362], action: ASK(W('Tôi đã thay tấm keo bẫy xoài A1', 'I replaced the card on mango trap A1')) },
    { name: 'farms', url: '/farms', settle: 3000 },
    { name: 'farm-map', url: '/farms', action: `
        const link = [...document.querySelectorAll('a, .el-card')].find(e => e.innerText && e.innerText.includes(${JSON.stringify(W('Vườn Hòa Lộc', 'Hoa Loc Orchard'))}));
        link.click(); await sleep(5000);`, settle: 2000 },
    { name: 'map', url: '/map', settle: 6000 },
    { name: 'logbook', url: '/logbook', settle: 3000 },
    { name: 'notifications', url: '/dashboard', action: `
        const bell = [...document.querySelectorAll('header button, .el-badge')].find(b => b.querySelector('svg') && (b.getAttribute('aria-label') || '').toLowerCase().includes(${JSON.stringify(W('thông báo', 'notification'))})) || document.querySelector('.el-badge');
        bell.click(); await sleep(1500);` },
    { name: 'alert-settings', url: '/settings?tab=notifications', action: `
        // The innermost card: the settings panel around it contains the same text
        const c = [...document.querySelectorAll('.el-card')].filter(e => e.innerText.includes(${JSON.stringify(W('Báo cáo tuần', 'Weekly report'))})).pop();
        for (let i = 0; i < 40 && document.querySelector('.el-loading-mask'); i++) await sleep(500);
        c?.scrollIntoView({ block: 'start' }); await sleep(600);` },
    { name: 'organizations', url: '/settings?tab=organizations' },
    { name: 'integrations', url: '/settings?tab=integrations' },
    { name: 'mobile-dashboard', url: '/dashboard', size: MOBILE, mobile: true, settle: 3500 },
    { name: 'mobile-cameras', url: '/cameras', size: MOBILE, mobile: true, settle: 20000, action: SHOW_STILL },
    { name: 'mobile-more', url: '/dashboard', size: MOBILE, mobile: true, action: `
        await click('nav button, nav a, .mobile-tabbar button', ${JSON.stringify(W('Thêm', 'More'))}, 1500);` }
];

const page = await launch();
try {
    await page.viewport(...DESKTOP);
    await page.goto(`${BASE}/`, 1000);
    const m = tokens.manager;
    await page.eval(`
        localStorage.setItem('token', ${JSON.stringify(m.token)});
        localStorage.setItem('user', ${JSON.stringify(JSON.stringify(m.user))});
        localStorage.setItem('flybot_language', '${LANG}');
        localStorage.setItem('smart_trap_theme', 'light');
        // The first-visit tour would cover every shot; the app-tour shot opens it itself
        localStorage.setItem('flybot_tour_done', '1');
        return true;`);
    for (const s of shots) {
        if (only && !only.includes(s.name)) continue;
        await page.viewport(...(s.size || DESKTOP), !!s.mobile);
        await page.goto(BASE + s.url, s.settle || 2500);
        try {
            if (s.action) await page.eval(H + s.action);
            await page.eval("document.querySelectorAll('.el-notification, .el-message').forEach(n => n.remove()); return true;");
            await sleep(400);
            const size = await page.shot(path.join(OUT, `${s.name}.webp`), { clip: s.clip || null });
            console.log(`✓ ${s.name} ${Math.round(size / 1024)} KB`);
        } catch (err) {
            console.log(`✗ ${s.name}: ${err.message.split('\n')[0]}`);
        }
    }
} finally {
    await page.close();
}
