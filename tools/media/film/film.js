// FlyBot demo film: one timeline drawn with HTML, CSS and SVG, driven by a virtual clock.
// window.renderAt(t) draws second t exactly (and resolves once every picture is decoded), so render-film.mjs can take
// frame after frame. ?subs=en|vi|none picks the subtitles; ?t=<s> shows one moment; without ?render it plays.
// Pictures come from media/ (not versioned): rec/ (record-app.mjs), photos/ (the owner's component photos),
// assets/ (flybot-aws diagrams and samples, the logo), footage/ (the owner's orchard clip), voice/ (voice.mjs).
import { SCENES, MAX_SECONDS } from './script.js';
import { EDIT } from './edit.js';

const q = new URLSearchParams(location.search);
const SUBS = q.get('subs') || 'en';
const M = 'media/';
const stage = document.getElementById('stage');
const W = 1920, H = 1080;

// Helpers
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (k) => { k = clamp(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const prog = (t, t0, d) => ease((t - t0) / d);
const el = (tag, cls, html, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; if (parent) parent.appendChild(e); return e; };
const place = (e, x, y, w, h) => { e.style.left = x + 'px'; e.style.top = y + 'px'; if (w !== undefined) e.style.width = w + 'px'; if (h !== undefined) e.style.height = h + 'px'; return e; };
const show = (e, p, dy = 30, scale = null) => {
    e.style.opacity = p;
    e.style.transform = `translateY(${(1 - p) * dy}px)` + (scale !== null ? ` scale(${scale + (1 - scale) * p})` : '');
};
const exists = async (url) => { try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; } };
const decoded = new Set();
async function setSrc(img, src) {
    if (img.dataset.src === src) return;
    img.dataset.src = src;
    img.src = src;
    if (!decoded.has(src)) { try { await img.decode(); } catch { /* missing picture: leave it blank */ } decoded.add(src); }
    else { try { await img.decode(); } catch { /* ignore */ } }
}
// A part of a photo: x0..x1, y0..y1 as fractions of the photo (natural size natW x natH), filling a box of w x h (cover)
function crop(parent, src, natW, natH, [x0, y0, x1, y1], w, h, fit = 'contain') {
    // contain: only the chosen part, centred in the box; cover: fills the box (more of the photo around it)
    const box = el('div', 'crop', undefined, parent);
    const img = el('img', '', undefined, box);
    img.src = src;
    const cw = (x1 - x0) * natW, ch = (y1 - y0) * natH;
    const s = (fit === 'cover' ? Math.max : Math.min)(w / cw, h / ch);
    img.style.width = natW * s + 'px';
    img.style.height = natH * s + 'px';
    if (fit === 'cover') {
        img.style.left = (-x0 * natW * s + (w - cw * s) / 2) + 'px';
        img.style.top = (-y0 * natH * s + (h - ch * s) / 2) + 'px';
    } else {
        Object.assign(box.style, { inset: 'auto', left: (w - cw * s) / 2 + 'px', top: (h - ch * s) / 2 + 'px', width: cw * s + 'px', height: ch * s + 'px', borderRadius: '8px' });
        img.style.left = (-x0 * natW * s) + 'px';
        img.style.top = (-y0 * natH * s) + 'px';
    }
    return box;
}
const BOARD = M + 'photos/IMG_20261019_150930.jpg';
const BW = 2592, BH = 4608;
// Where each module sits on the board photo (fractions of the photo)
const ON_BOARD = {
    esp32: [0.234, 0.505, 0.914, 0.684],
    modem: [0.319, 0.347, 0.592, 0.504],
    charger: [0.592, 0.402, 0.889, 0.5],
    gps: [0.306, 0.689, 0.464, 0.789],
    boost: [0.482, 0.694, 0.737, 0.766],
    antenna: [0.161, 0.69, 0.243, 0.827]
};

// ---------------------------------------------------------------- the timeline
let voice = {};
let TIMELINE = [];
let CUES = [];
function buildTimeline() {
    let at = 0;
    TIMELINE = [];
    CUES = [];
    for (const s of SCENES) {
        let end = s.dur;
        s.lines.forEach((l, i) => {
            const id = `${s.id}-${i}`;
            const len = voice[id] || l.en.split(/\s+/).length / 2.4;
            end = Math.max(end, l.at + len + 0.7);
            CUES.push({ id, start: +(at + l.at).toFixed(3), end: +(at + l.at + len + 0.25).toFixed(3), en: l.en, vi: l.vi, voice: voice[id] ? `${M}voice/${id}.wav` : null });
        });
        TIMELINE.push({ ...s, start: at, len: end });
        at += end;
    }
    return at;
}

// ---------------------------------------------------------------- recorded scenes
const recIndex = {};
async function loadRec(shot) {
    if (shot in recIndex) return recIndex[shot];
    try {
        const r = await fetch(`${M}rec/${shot}/index.json`);
        recIndex[shot] = r.ok ? await r.json() : null;
    } catch { recIndex[shot] = null; }
    return recIndex[shot];
}
function frameAt(idx, t) {
    const f = idx.frames;
    let lo = 0, hi = f.length - 1;
    if (t <= f[0].t) return f[0].f;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f[mid].t <= t) lo = mid; else hi = mid - 1; }
    return f[lo].f;
}
function zoomAt(keys, t) {
    if (!keys || !keys.length) return [960, 540, 1];
    if (t <= keys[0][0]) return keys[0].slice(1);
    for (let i = 1; i < keys.length; i++) {
        if (t <= keys[i][0]) {
            const a = keys[i - 1], b = keys[i], k = ease((t - a[0]) / (b[0] - a[0] || 1));
            return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
        }
    }
    return keys[keys.length - 1].slice(1);
}
const BADGE = {
    guest: ['guest', 'Guest access · read-only'],
    owner: ['owner', "Owner's account"],
    sim: ['sim', 'Includes simulated data']
};
function recView(sceneEl, id) {
    const cfg = EDIT[id];
    const win = el('div', 'win', '<div class="bar"><i></i><i></i><i></i><span>flybot.agrhub.com</span></div>', sceneEl);
    const view = el('div', 'view', undefined, win);
    const img = el('img', '', undefined, view);
    const missing = el('div', 'missing', '', win);
    missing.style.display = 'none';
    el('div', 'badges', cfg.badges.map(b => `<span class="chip ${BADGE[b][0]}">${BADGE[b][1]}</span>`).join(''), sceneEl);
    return async (t, len) => {
        // The clip at t
        let rest = t, clip = cfg.clips[cfg.clips.length - 1], local = 0;
        for (let i = 0; i < cfg.clips.length; i++) {
            const c = cfg.clips[i];
            const d = i === cfg.clips.length - 1 ? Infinity : c.dur;
            if (rest < d) { clip = c; local = rest; break; }
            rest -= d;
        }
        const idx = await loadRec(clip.shot);
        if (!idx || !idx.frames.length) {
            missing.style.display = 'grid';
            missing.innerHTML = `<div><span class="chip ph">Recording missing</span><p style="margin-top:20px">${clip.shot}</p></div>`;
            img.style.display = 'none';
            return;
        }
        missing.style.display = 'none';
        img.style.display = 'block';
        await setSrc(img, `${M}rec/${clip.shot}/${frameAt(idx, (clip.from || 0) + local * (clip.speed || 1))}`);
        // Page pixels (1920 x 1080) to the window's view (1600 x 900 shown in 1600 x 864, top bar over the page's top bar)
        const [cx, cy, s] = zoomAt(clip.zoom, local);
        const k = 1600 / 1920 * s;
        let x = 800 - cx * k, y = 432 - cy * k;
        x = Math.min(0, Math.max(1600 - 1920 * k, x));
        y = Math.min(0, Math.max(864 - 1080 * k, y));
        img.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
        img.style.width = '1920px';
        img.style.height = '1080px';
    };
}

// ---------------------------------------------------------------- the other scenes
const FLY = '<svg viewBox="0 0 40 40"><ellipse cx="20" cy="22" rx="6" ry="9" fill="#3b2a12"/><circle cx="20" cy="11" r="4.5" fill="#5a3a12"/><circle cx="18" cy="10" r="1.6" fill="#c0392b"/><circle cx="22" cy="10" r="1.6" fill="#c0392b"/><ellipse cx="11" cy="18" rx="9" ry="4" fill="rgba(220,240,255,0.55)" transform="rotate(-25 11 18)"/><ellipse cx="29" cy="18" rx="9" ry="4" fill="rgba(220,240,255,0.55)" transform="rotate(25 29 18)"/></svg>';

const VIEWS = {
    intro(s) {
        const logo = place(el('img', 'abs', undefined, s), 860, 230, 200, 200); logo.src = M + 'assets/logo.png';
        const t1 = place(el('div', 'abs title', 'FlyBot on AWS', s), 0, 470, W); t1.style.textAlign = 'center'; t1.style.fontSize = '104px';
        const t2 = place(el('div', 'abs sub', 'OpenCV 5 · AWS Lambda · IoT Core · Kinesis Video Streams', s), 0, 610, W); t2.style.textAlign = 'center';
        const t3 = place(el('div', 'abs kicker', 'AGRHUB · OpenCV AI Competition 2026', s), 0, 700, W); t3.style.textAlign = 'center';
        const flies = [...Array(9)].map((_, i) => { const f = place(el('div', 'abs', FLY, s), 0, 0, 46, 46); f.dataset.i = i; return f; });
        return (t) => {
            show(logo, prog(t, 0.2, 0.8), 20, 0.7);
            show(t1, prog(t, 0.6, 0.9));
            show(t2, prog(t, 1.2, 0.9));
            show(t3, prog(t, 1.8, 0.9));
            flies.forEach((f, i) => {
                const a = t * (0.35 + i * 0.04) + i * 1.7;
                const x = 960 + Math.cos(a) * (620 + (i % 3) * 120) + Math.sin(a * 2.3) * 40;
                const y = 520 + Math.sin(a * 1.3) * (330 + (i % 4) * 30);
                f.style.transform = `translate(${x - 23}px, ${y - 23}px) rotate(${Math.cos(a) * 40}deg)`;
                f.style.opacity = 0.75 * prog(t, 0.3 + i * 0.1, 0.6);
            });
        };
    },
    problem(s) {
        const k = place(el('div', 'abs kicker', 'The problem', s), 120, 90);
        const t = place(el('div', 'abs title', 'A count can’t tell a bad photo from a catch', s), 120, 140, 1700);
        const pics = [['glare.jpg', 'Glare on a real lure trap', 'data/samples (BE4089629)'], ['blur.jpg', 'Strong blur (failure-injection frame)', 'docs/evidence/eval/failure_injection']].map(([f, cap, src], i) => {
            const c = place(el('div', 'card', '', s), 120 + i * 860, 300, 820, 560);
            c.style.overflow = 'hidden';
            const im = place(el('img', 'abs', undefined, c), 0, 0, 820, 461); im.src = M + 'assets/' + f; im.style.objectFit = 'cover';
            place(el('div', 'abs', `<div style="font-size:28px;font-weight:700">${cap}</div><div class="source">${src}</div>`, c), 26, 476, 770);
            const q = place(el('div', 'abs chip ph', 'Count: ?', c), 26, 24);
            return { c, q };
        });
        return (tt) => {
            show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8));
            pics.forEach(({ c, q }, i) => { show(c, prog(tt, 1 + i * 0.6, 0.9), 50); q.style.opacity = prog(tt, 3 + i * 0.6, 0.5); q.style.transform = `rotate(${Math.sin(tt * 9 + i) * 3}deg)`; });
        };
    },
    idea(s) {
        const k = place(el('div', 'abs kicker', 'FlyBot Sentinel', s), 120, 90);
        const t = place(el('div', 'abs title', 'Perception → Decision → Action, and a person decides', s), 120, 140, 1700);
        const steps = [
            ['Trap camera', 'EZVIZ trap cameras and our ESP32-S3 camera take a photo'],
            ['OpenCV 5 on Lambda', 'count, photo quality, change since the last photo'],
            ['Sentinel agent', 'rules decide; every step is traced'],
            ['A person confirms', 'chat, Telegram or the console; then FlyBot acts']
        ].map(([h, p], i) => place(el('div', 'node' + (i === 3 ? ' hl' : ''), `<h3>${h}</h3><p>${p}</p>`, s), 120 + i * 440, 400));
        const svg = place(el('div', 'abs', `<svg width="1920" height="300"><defs><marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#3ecf8e"/></marker></defs>${[0, 1, 2].map(i => `<line id="ia${i}" x1="${450 + i * 440}" y1="105" x2="${555 + i * 440}" y2="105" stroke="#3ecf8e" stroke-width="5" marker-end="url(#ar)"/>`).join('')}<path id="iloop" d="M1720 215 C1720 290, 290 290, 290 215" fill="none" stroke="#3ecf8e" stroke-width="4" stroke-dasharray="12 10" marker-end="url(#ar)"/></svg>`, s), 0, 400, 1920, 300);
        const loopText = place(el('div', 'abs sub', 'a confirmed photo starts the loop again', s), 0, 720, W); loopText.style.textAlign = 'center';
        return (tt) => {
            show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8));
            steps.forEach((n, i) => show(n, prog(tt, 0.8 + i * 1.3, 0.8), 40));
            [0, 1, 2].forEach(i => { svg.querySelector('#ia' + i).style.opacity = prog(tt, 1.5 + i * 1.3, 0.5); });
            svg.querySelector('#iloop').style.opacity = prog(tt, 5.5, 0.8);
            svg.querySelector('#iloop').style.strokeDashoffset = -tt * 30;
            show(loopText, prog(tt, 5.8, 0.8));
        };
    },
    bom(s) {
        const k = place(el('div', 'abs kicker', 'The trap camera · bill of materials', s), 120, 60);
        const t = place(el('div', 'abs title', 'Open hardware, about 1.5 million VND of parts', s), 120, 104, 1700); t.style.fontSize = '54px';
        const parts = [
            ['photo', 'esp32', 'ESP32-S3 N16R8 CAM', 'OV5640 camera · 380.000 ₫'],
            ['photo', 'modem', '4G modem SIMCom A7680C', 'TDM2309 board · 169.000 ₫'],
            ['photo', 'gps', 'GPS ATGM336H', 'GPS + BeiDou · 173.280 ₫'],
            ['photo', 'charger', 'Charger TP4056 + DW01', 'USB-C, protected · 6.270 ₫'],
            ['photo', 'boost', 'Mini 5 V boost converter', 'feeds the board from the cell'],
            ['cell', null, '18650 Li-ion cell 2000 mAh', 'cell + holder · 39.000 ₫'],
            ['housing', null, 'Solar trap housing', 'hanging, with lid · US$3 – 9.90'],
            ['card', null, 'Yellow sticky cards', '15 × 25 cm, pack of 50 · 155.000 ₫']
        ].map(([kind, key, h, p], i) => {
            const card = place(el('div', 'part', '', s), 120 + (i % 4) * 430, 200 + Math.floor(i / 4) * 345);
            const pic = el('div', 'pic', '', card);
            if (kind === 'photo') crop(pic, BOARD, BW, BH, ON_BOARD[key], 400, 220);
            else if (kind === 'housing') { const im = place(el('img', 'abs', undefined, pic), 0, 0, 400, 220); im.src = M + 'photos/IMG_20261019_143502.jpg'; im.style.objectFit = 'cover'; }
            else if (kind === 'cell') pic.innerHTML = '<svg width="400" height="220"><rect x="70" y="70" width="240" height="80" rx="16" fill="#2f7d4f" stroke="#9fe3bd" stroke-width="3"/><rect x="310" y="92" width="18" height="36" rx="4" fill="#9fe3bd"/><text x="190" y="122" font-size="30" font-weight="800" fill="#eafff3" text-anchor="middle" font-family="Be Vietnam Pro">18650 · 3.7 V</text></svg>';
            else pic.innerHTML = '<svg width="400" height="220"><rect x="110" y="20" width="180" height="180" rx="8" fill="#f3d63c"/>' + [...Array(7)].map((_, j) => `<g transform="translate(${130 + (j * 53) % 150} ${40 + (j * 37) % 140}) scale(0.5)">${FLY.replace('<svg viewBox="0 0 40 40">', '').replace('</svg>', '')}</g>`).join('') + '</svg>';
            el('div', 'txt', `<h4>${h}</h4><p>${p}</p>`, card);
            return card;
        });
        const src = place(el('div', 'abs source', 'Prices read on shop pages on 17 Oct 2026 (camos-esp32-trap docs/BOM.md). Field camera with the generic board: 1.512.090 ₫ + SIM.', s), 120, 893, 1700);
        return (tt) => {
            show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8));
            parts.forEach((c, i) => show(c, prog(tt, 0.7 + i * 0.35, 0.7), 40, 0.92));
            show(src, prog(tt, 3.5, 0.8), 10);
        };
    },
    wiring: wiringView,
    board(s) {
        const k = place(el('div', 'abs kicker', 'The real build', s), 120, 70);
        const t = place(el('div', 'abs title', 'Wired on a perfboard, mounted in the trap lid', s), 120, 112, 1700); t.style.fontSize = '50px';
        const frame = place(el('div', 'card', '', s), 140, 210, 640, 736); frame.style.overflow = 'hidden';
        const R = [0.1, 0.3, 0.95, 0.85];
        const inner = place(el('div', 'abs', '', frame), 0, 0, 640, 736);
        crop(inner, BOARD, BW, BH, R, 640, 736, 'cover');
        const toFrame = ([x0, y0, x1, y1]) => [((x0 + x1) / 2 - R[0]) / (R[2] - R[0]) * 640, ((y0 + y1) / 2 - R[1]) / (R[3] - R[1]) * 736];
        const tags = [['esp32', 'ESP32-S3 + OV5640'], ['modem', '4G A7680C'], ['charger', 'TP4056 charger'], ['gps', 'GPS ATGM336H'], ['boost', '5 V boost'], ['antenna', 'LTE antenna']].map(([key, label], i) => {
            const [x, y] = toFrame(ON_BOARD[key]);
            const d = place(el('div', 'dotmark', '', s), 140 + x, 210 + y);
            const tag = place(el('div', 'tag', label, s), 140 + x + (key === 'antenna' ? 40 : 0), 210 + y + (key === 'gps' ? 50 : -46));
            return { d, tag, i };
        });
        const housing = [['IMG_20261019_143502.jpg', 'The lid: its solar panel on top, the board inside'], ['IMG_20261019_143550.jpg', 'The clear trap body under the lid']].map(([f, cap], i) => {
            const c = place(el('div', 'card', '', s), 880 + i * 470, 210, 440, 736); c.style.overflow = 'hidden';
            const im = place(el('img', 'abs', undefined, c), 0, 0, 440, 620); im.src = M + 'photos/' + f; im.style.objectFit = 'cover';
            place(el('div', 'abs', `<div style="font-size:24px;font-weight:700;line-height:1.3">${cap}</div>`, c), 22, 638, 400);
            return c;
        });
        return (tt) => {
            show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8));
            show(frame, prog(tt, 0.2, 0.8), 30);
            const z = 1 + 0.06 * clamp(tt / 9);
            inner.style.transform = `scale(${z})`;
            tags.forEach(({ d, tag, i }) => { const p = prog(tt, 1 + i * 0.4, 0.5); d.style.opacity = p; tag.style.opacity = p; });
            housing.forEach((c, i) => show(c, prog(tt, 4.2 + i * 0.6, 0.8), 40));
        };
    },
    field: fieldView,
    architecture(s) {
        const frame = place(el('div', 'abs', '', s), 0, 0, W, H); frame.style.overflow = 'hidden'; frame.style.background = '#fff';
        const im = place(el('img', 'abs', undefined, frame), 0, 0, 1920, 1080); im.src = M + 'assets/architecture.png'; im.style.transformOrigin = '0 0';
        const keys = [[0, 960, 540, 1], [2.5, 960, 540, 1], [4.5, 640, 470, 1.9], [7, 1110, 470, 1.9], [9.5, 1740, 420, 2.1], [12, 960, 540, 1]];
        return (tt) => {
            const [cx, cy, z] = zoomAt(keys, tt);
            let x = 960 - cx * z, y = 540 - cy * z;
            x = Math.min(0, Math.max(1920 - 1920 * z, x)); y = Math.min(0, Math.max(1080 - 1080 * z, y));
            im.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
        };
    },
    opencv(s) {
        const k = place(el('div', 'abs kicker', 'OpenCV 5', s), 120, 80);
        const t = place(el('div', 'abs title', 'YOLO26n on the new DNN engine, tiled on sticky cards', s), 120, 124, 1700); t.style.fontSize = '54px';
        const code = place(el('div', 'code', '<span class="c"># lambda/vision/sentinel/vision/detect_yolo26.py</span>\nself.net = cv2.dnn.<span class="k">readNet</span>(str(self.onnx_path), "", "",\n                          ENGINES[engine])  <span class="c"># ENGINE_NEW</span>', s), 120, 250, 1000);
        const a = place(el('div', 'card stat', '<b>0.953</b><p>YOLO26n test mAP@50<br>(76 images, 2,349 flies)</p><small>models/MODEL_CARD.md</small>', s), 1180, 250, 620, 250);
        const b = place(el('div', 'card stat', '<p style="margin:0 0 18px">Sticky cards, 2 × 2 tiles · recall (synthetic photos)</p>', s), 120, 520, 1000, 330);
        const rows = [['Whole frame', 0.0687, '#ef5b5b'], ['2 × 2 tiles', 0.8165, '#3ecf8e']].map(([label, v, col], i) => {
            const lab = place(el('div', 'abs', `<span style="font-size:24px;font-weight:700">${label}</span>`, b), 34, 100 + i * 90);
            const row = place(el('div', 'bar-row', '<div></div>', b), 250, 92 + i * 90, 560, 46);
            row.firstChild.style.background = col;
            const num = place(el('div', 'abs', '', b), 830, 96 + i * 90); num.style.fontSize = '30px'; num.style.fontWeight = '800';
            return { row, num, v, lab };
        });
        place(el('small', 'abs source', 'eval/SYNTHETIC_RESULTS.md · simulated cards, not field data', b), 34, 280);
        const c = place(el('div', 'card stat', '<b>980 ms</b><p>warm p50 per photo on Lambda<br>(arm64, 2 GB, whole call)</p><small>bench/results/lambda_latency.json</small>', s), 1180, 520, 620, 330);
        return (tt) => {
            show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8));
            show(code, prog(tt, 0.6, 0.8)); show(a, prog(tt, 1.6, 0.8)); show(b, prog(tt, 4, 0.8)); show(c, prog(tt, 9, 0.8));
            rows.forEach(({ row, num, v }, i) => {
                const p = prog(tt, 5 + i * 1.6, 1.4);
                row.firstChild.style.width = (v * p * 100) + '%';
                num.textContent = (v * p).toFixed(2);
            });
        };
    },
    results(s) {
        const k = place(el('div', 'abs kicker', 'Results', s), 120, 80);
        const t = place(el('div', 'abs title', 'Measured, including what did not go our way', s), 120, 124, 1700); t.style.fontSize = '54px';
        const cards = [
            ['38 / 38', 'failure-injection cases passed, 0 false actuations', 'eval/RESULTS.md · earlier build, fake devices'],
            ['≈ 17 USD', 'a month for the whole demo on AWS', 'infra/COST.md'],
            ['≈ 0.046 USD', 'per 1,000 photos on Lambda', 'infra/COST.md'],
            ['4.6 % slower', 'COOL on Graviton4 than the pip wheel, per photo', 'bench/REPORT_COOL.md']
        ].map(([b, p, src], i) => place(el('div', 'card stat', `<b>${b}</b><p>${p}</p><small>${src}</small>`, s), 120 + (i % 2) * 860, 260 + Math.floor(i / 2) * 330, 820, 290));
        return (tt) => { show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8)); cards.forEach((c, i) => show(c, prog(tt, 0.8 + i * 1.6, 0.8), 40)); };
    },
    end(s) {
        const limits = place(el('div', 'card stat', '<p style="font-size:30px;font-weight:800;margin:0 0 14px">Expert review and limits</p><p>Expert review: 43 of 49 agent decisions policy-correct (87.8 %); the 6 wrong ones were needless recaptures</p><p>0 human count labels yet · sticky cards measured on synthetic photos only</p><p>No autonomous spraying: a person always decides</p><small>eval/results/expert_review.json · REPORT.md section 6.7</small>', s), 300, 150, 1320, 330);
        const endc = place(el('div', 'abs', '', s), 0, 560, W);
        endc.innerHTML = `<div style="text-align:center"><div class="title" style="font-size:72px">Try it: <span style="color:var(--mint)">flybot.agrhub.com</span></div><div class="sub" style="margin-top:14px">Guest access · read-only, two hours, no sign-up</div><div class="sub mono" style="margin-top:24px;font-size:28px">github.com/agrhub/flybot-aws</div><div class="kicker" style="margin-top:34px">AGRHUB · FlyBot team</div></div>`;
        return (tt) => { show(limits, prog(tt, 0.2, 0.8)); show(endc, prog(tt, 5.5, 1)); };
    }
};

// ---------------------------------------------------------------- wiring animation (4G build)
// Modules and pins follow camos-esp32-trap "Sơ đồ đấu nối bẫy 4G": the cell feeds the charger, a boost converter
// feeds the board's 5V pin, the modem runs from the cell, the GPS from the board's 3V3, a divider on GPIO1.
function wiringView(s) {
    const STEPS = [
        [0, '1', 'Cell, charger and solar panel'],
        [6.6, '2', '5 V boost converter → board 5V'],
        [12.4, '3', '4G modem: power from the cell, UART on GPIO41 / 42'],
        [18.0, '4', 'GPS: 3V3, TX → GPIO14 · battery divider → GPIO1']
    ];
    const step = place(el('div', 'step', '<i></i><span></span>', s), 90, 34);
    const mods = {};
    const mod = (key, x, y, w, h, name, sub, pic, at) => {
        const m = place(el('div', 'mod', '', s), x, y, w, h);
        const p = place(el('div', 'pic', '', m), 0, 0, w, h - 74);
        if (pic === 'photo') crop(p, BOARD, BW, BH, ON_BOARD[key], w, h - 74);
        else p.innerHTML = pic;
        el('div', 'name', `${name}<small>${sub}</small>`, m);
        mods[key] = { m, at };
    };
    const panelSvg = `<svg width="300" height="96"><rect x="20" y="12" width="260" height="72" rx="6" fill="#1b3358" stroke="#6eaaff" stroke-width="2"/>${[...Array(5)].map((_, i) => `<line x1="${20 + (i + 1) * 43}" y1="12" x2="${20 + (i + 1) * 43}" y2="84" stroke="#6eaaff" stroke-width="1"/>`).join('')}<line x1="20" y1="48" x2="280" y2="48" stroke="#6eaaff" stroke-width="1"/></svg>`;
    const cellSvg = `<svg width="300" height="76"><rect x="40" y="16" width="200" height="48" rx="10" fill="#2f7d4f" stroke="#9fe3bd" stroke-width="2"/><rect x="240" y="30" width="14" height="20" rx="3" fill="#9fe3bd"/><text x="140" y="48" font-size="22" font-weight="800" fill="#eafff3" text-anchor="middle" font-family="Be Vietnam Pro">18650</text></svg>`;
    mod('solar', 90, 150, 300, 170, 'Solar panel 6 V 2 W', 'optional', panelSvg, 0.6);
    mod('charger', 90, 400, 300, 200, 'TP4056 charger', 'with DW01 protection', 'photo', 0.2);
    mod('cell', 90, 700, 300, 150, '18650 cell', '3.7 – 4.2 V', cellSvg, 0.2);
    mod('boost', 520, 400, 270, 200, '5 V boost', 'set to 5.0 – 5.2 V', 'photo', 6.8);
    mod('esp32', 920, 250, 400, 600, 'ESP32-S3 CAM', 'N16R8 · OV5640', 'photo', 6.8);
    mod('modem', 1460, 160, 380, 300, '4G A7680C', 'TDM2309 · nano SIM', 'photo', 12.6);
    mod('gps', 1460, 560, 380, 260, 'GPS ATGM336H', 'patch antenna faces up', 'photo', 18.2);

    // Pins: [label, x, y, side]
    const pins = [
        ['IN+', 150, 400, 'b', 0.6], ['IN−', 330, 400, 'b', 0.6], ['B+', 150, 600, 'u', 0.2], ['B−', 330, 600, 'u', 0.2], ['OUT+', 390, 450, 'r', 0.2], ['OUT−', 390, 500, 'r', 0.2],
        ['IN+', 520, 450, 'l', 6.8], ['IN−', 520, 500, 'l', 6.8], ['OUT+', 790, 450, 'r', 6.8], ['OUT−', 790, 500, 'r', 6.8],
        ['5V', 920, 330, 'l', 6.8], ['GND', 920, 390, 'l', 6.8], ['GPIO1', 920, 760, 'l', 18.2],
        ['GPIO41', 1320, 320, 'r', 12.6], ['GPIO42', 1320, 370, 'r', 12.6], ['3V3', 1320, 620, 'r', 18.2], ['GPIO14', 1320, 690, 'r', 18.2],
        ['VCC', 1460, 210, 'l', 12.6], ['GND', 1460, 260, 'l', 12.6], ['RXD', 1460, 320, 'l', 12.6], ['TXD', 1460, 370, 'l', 12.6],
        ['VCC', 1460, 620, 'l', 18.2], ['TX', 1460, 690, 'l', 18.2], ['GND', 1460, 750, 'l', 18.2]
    ].map(([label, x, y, side, at]) => {
        const p = el('div', 'pin', label, s);
        p.style.top = y + 'px';
        if (side === 'l') { p.style.left = (x + 6) + 'px'; }
        else if (side === 'r') { p.style.left = (x - 6) + 'px'; p.style.transform = 'translate(-100%, -50%)'; }
        else if (side === 'u') { p.style.left = (x + 8) + 'px'; p.style.transform = 'translate(0, 30%)'; }
        else { p.style.left = (x + 8) + 'px'; p.style.transform = 'translate(0, -120%)'; }
        return { p, at };
    });

    // Wires: [net, points, start, duration, dashed]
    const C = { bat: 'var(--w-bat)', v5: 'var(--w-5v)', v33: 'var(--w-3v3)', gnd: 'var(--w-gnd)', uart: 'var(--w-uart)', gps: 'var(--w-gps)', sense: 'var(--w-sense)', solar: 'var(--w-solar)' };
    const wires = [
        ['bat', [[150, 700], [150, 600]], 0.9, 0.8], ['gnd', [[330, 700], [330, 600]], 1.3, 0.8],
        ['solar', [[150, 320], [150, 400]], 2.2, 0.8, true], ['gnd', [[330, 320], [330, 400]], 2.5, 0.8, true],
        ['bat', [[390, 450], [520, 450]], 7.4, 0.8], ['gnd', [[390, 500], [520, 500]], 7.8, 0.8],
        ['v5', [[790, 450], [855, 450], [855, 330], [920, 330]], 8.6, 1.0], ['gnd', [[790, 500], [875, 500], [875, 390], [920, 390]], 9.2, 1.0],
        ['bat', [[455, 450], [455, 120], [1410, 120], [1410, 210], [1460, 210]], 13.0, 1.6], ['gnd', [[1460, 260], [1420, 260], [1420, 290]], 14.4, 0.5],
        ['uart', [[1320, 320], [1460, 320]], 15.0, 0.7], ['uart', [[1460, 370], [1320, 370]], 15.6, 0.7],
        ['v33', [[1320, 620], [1460, 620]], 18.6, 0.7], ['gps', [[1460, 690], [1320, 690]], 19.2, 0.7], ['gnd', [[1460, 750], [1420, 750], [1420, 780]], 19.8, 0.5],
        ['bat', [[455, 450], [455, 700], [560, 700]], 21.0, 0.8], ['gnd', [[680, 700], [680, 792]], 22.0, 0.4], ['sense', [[680, 700], [860, 700], [860, 760], [920, 760]], 22.2, 0.9]
    ];
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.style.position = 'absolute'; svg.style.left = '0'; svg.style.top = '0'; svg.style.pointerEvents = 'none';
    s.insertBefore(svg, s.firstChild);
    const paths = wires.map(([net, pts, at, dur, dashed]) => {
        const d = 'M' + pts.map(p => p.join(' ')).join(' L');
        const base = document.createElementNS(svgNS, 'path');
        base.setAttribute('d', d); base.setAttribute('fill', 'none'); base.setAttribute('stroke', C[net]);
        base.setAttribute('stroke-width', net === 'bat' ? 7 : 5); base.setAttribute('stroke-linecap', 'round'); base.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(base);
        const len = base.getTotalLength();
        base.style.strokeDasharray = dashed ? '14 10' : `${len} ${len}`;
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('r', 7); dot.setAttribute('fill', '#fff'); svg.appendChild(dot);
        return { base, dot, len, at, dur, dashed };
    });
    // Divider resistors and ground symbols, drawn as part of step 4
    const extras = place(el('div', 'abs', `<svg width="1920" height="1080">
        <rect x="560" y="686" width="90" height="28" rx="6" fill="#0f1c17" stroke="var(--w-sense)" stroke-width="3"/><text x="605" y="745" fill="#fff" font-size="18" text-anchor="middle" font-family="JetBrains Mono, Consolas">100k</text>
        <line x1="650" y1="700" x2="680" y2="700" stroke="var(--w-sense)" stroke-width="5"/>
        <rect x="666" y="722" width="28" height="50" rx="6" fill="#0f1c17" stroke="var(--w-sense)" stroke-width="3"/><text x="704" y="754" fill="#fff" font-size="18" font-family="JetBrains Mono, Consolas">100k</text>
        <circle cx="680" cy="700" r="7" fill="#fff"/>
        ${[[680, 792], [1420, 290], [1420, 780]].map(([x, y]) => `<g stroke="var(--w-gnd)" stroke-width="4"><line x1="${x}" y1="${y}" x2="${x}" y2="${y + 2}"/><line x1="${x - 16}" y1="${y + 4}" x2="${x + 16}" y2="${y + 4}"/><line x1="${x - 10}" y1="${y + 11}" x2="${x + 10}" y2="${y + 11}"/><line x1="${x - 4}" y1="${y + 18}" x2="${x + 4}" y2="${y + 18}"/></g>`).join('')}
        </svg>`, s), 0, 0, W, H);
    extras.style.pointerEvents = 'none';
    const notes = [
        [7.4, 9, 'Measure 5.0 – 5.2 V at the boost output before it touches the board', 470, 640, 400],
        [13.0, 7, 'Modem VCC from the cell (3.7 – 4.2 V), never 5 V or 3.3 V; 1000 µF + 100 nF at VCC', 930, 880, 900],
        [22.6, 3.4, 'All grounds common · every pin as the firmware expects, no rebuild', 470, 880, 900]
    ].map(([at, len, text, x, y, w]) => ({ n: place(el('div', 'note', text, s), x, y, w), at, len }));
    const legend = place(el('div', 'abs source', 'Drawn by function, not by position on the board · camos-esp32-trap docs/WIRING.md and the 4G wiring sheet', s), 162, 98, 1300);
    return (tt) => {
        const cur = STEPS.filter(x => tt >= x[0]).pop();
        step.querySelector('i').textContent = cur[1];
        step.querySelector('span').textContent = cur[2];
        const since = tt - cur[0];
        step.style.opacity = clamp(since / 0.4);
        Object.values(mods).forEach(({ m, at }) => show(m, prog(tt, at, 0.6), 20, 0.9));
        pins.forEach(({ p, at }) => { p.style.opacity = prog(tt, at + 0.3, 0.4); });
        paths.forEach(({ base, dot, len, at, dur, dashed }) => {
            const p = clamp((tt - at) / dur);
            base.style.opacity = p > 0 ? 1 : 0;
            if (!dashed) base.style.strokeDashoffset = len * (1 - ease(p));
            else base.style.opacity = ease(p);
            // A pulse runs along a drawn wire
            const run = ((tt - at - dur) * 0.55) % 1;
            const done = tt > at + dur;
            const pt = base.getPointAtLength(done ? run * len : ease(p) * len);
            dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
            dot.style.opacity = p > 0 ? (done ? 0.75 : 1) : 0;
        });
        extras.style.opacity = prog(tt, 21.6, 0.6);
        notes.forEach(({ n, at, len }) => { n.style.opacity = clamp((tt - at) / 0.4) * clamp((at + len - tt) / 0.4); });
        legend.style.opacity = prog(tt, 1, 0.8) * 0.9;
    };
}

// ---------------------------------------------------------------- the owner's orchard clip
// media/footage/real-trap.mp4 (or footage.json { "file": "...", "from": seconds }) fills the slot; otherwise a card.
let footage = null;
function fieldView(s) {
    const video = place(el('video', 'abs', undefined, s), 0, 0, W, H);
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.style.objectFit = 'cover'; video.style.display = 'none';
    place(el('div', 'abs', '<span class="chip">In the orchard · real footage</span>', s), 60, 50);
    const ph = place(el('div', 'abs', '', s), 0, 0, W, H);
    ph.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;background:repeating-linear-gradient(45deg,#0f1a15,#0f1a15 26px,#0c1511 26px,#0c1511 52px)">
        <div><span class="chip ph">Placeholder · 30 s</span>
        <div class="title" style="margin-top:28px">The wired trap in the orchard</div>
        <div class="sub" style="margin-top:16px">Real footage from the team goes here</div>
        <div class="source mono" style="margin-top:26px;font-size:22px">tools/media/film/media/footage/real-trap.mp4</div></div></div>`;
    return async (tt) => {
        if (!footage) { ph.style.display = 'block'; video.style.display = 'none'; return; }
        ph.style.display = 'none';
        video.style.display = 'block';
        if (video.dataset.src !== footage.file) { video.dataset.src = footage.file; video.src = footage.file; await new Promise(r => { video.onloadeddata = r; video.onerror = r; }); }
        const want = Math.min((footage.from || 0) + tt, Math.max(0, (video.duration || 0) - 0.05));
        if (Math.abs(video.currentTime - want) > 0.001) {
            await new Promise(r => { const done = () => { video.removeEventListener('seeked', done); r(); }; video.addEventListener('seeked', done); video.currentTime = want; setTimeout(done, 3000); });
        }
    };
}

// ---------------------------------------------------------------- build and draw
const subs = el('div', '', '<div></div>', stage); subs.id = 'subs';
const views = [];
let DURATION = 0;
async function ready() {
    try { const r = await fetch(M + 'voice/manifest.json'); if (r.ok) voice = await r.json(); } catch { /* no voice yet */ }
    for (const name of ['real-trap.mp4', 'real-trap.webm', 'real-trap.mov']) {
        if (await exists(M + 'footage/' + name)) { footage = { file: M + 'footage/' + name, from: 0 }; break; }
    }
    try { const r = await fetch(M + 'footage/footage.json'); if (r.ok) { const f = await r.json(); footage = { file: M + 'footage/' + f.file, from: f.from || 0 }; } } catch { /* none */ }
    DURATION = buildTimeline();
    for (const sc of TIMELINE) {
        const s = el('div', 'scene', '', stage);
        s.dataset.id = sc.id;
        const draw = sc.rec ? recView(s, sc.id) : VIEWS[sc.id](s);
        views.push({ sc, s, draw });
    }
    for (const sc of TIMELINE) if (sc.rec) for (const c of EDIT[sc.id].clips) await loadRec(c.shot);
    await document.fonts.ready;
    window.FILM = { duration: DURATION, width: W, height: H, fps: 30, cues: CUES, scenes: TIMELINE.map(s => ({ id: s.id, start: s.start, len: s.len })), footage: !!footage, maxSeconds: MAX_SECONDS };
    return window.FILM;
}

let lastScene = null;
async function renderAt(T) {
    const FADE = 0.35;
    let cur = views[views.length - 1];
    for (const v of views) if (T >= v.sc.start && T < v.sc.start + v.sc.len) { cur = v; break; }
    if (lastScene !== cur) { views.forEach(v => { v.s.style.visibility = v === cur ? 'visible' : 'hidden'; }); lastScene = cur; }
    const t = T - cur.sc.start;
    cur.s.style.opacity = Math.min(clamp(t / FADE), clamp((cur.sc.len - t) / FADE), cur === views[0] ? clamp(t / 0.8) : 1);
    await cur.draw(t, cur.sc.len);
    const cue = SUBS === 'none' ? null : CUES.find(c => T >= c.start && T < c.end);
    subs.firstChild.textContent = cue ? cue[SUBS] || cue.en : '';
}

window.ready = ready();
window.renderAt = renderAt;
if (!q.has('render')) {
    window.ready.then(async () => {
        if (q.has('t')) { await renderAt(Number(q.get('t'))); return; }
        const t0 = performance.now() - (Number(q.get('from')) || 0) * 1000;
        const loop = async () => { await renderAt(((performance.now() - t0) / 1000) % DURATION); requestAnimationFrame(loop); };
        loop();
    });
}
