// FlyBot demo film: one timeline drawn with HTML, CSS and SVG, driven by a virtual clock.
// window.renderAt(t) draws second t exactly (and resolves once every picture is decoded), so render-film.mjs can take
// frame after frame. ?subs=en|vi|none picks the subtitles; ?t=<s> shows one moment; without ?render it plays.
// Pictures come from media/ (not versioned): rec/ (record-app.mjs), photos/ (the owner's component photos),
// assets/ (the logo), footage/ (the owner's orchard clip), voice/ (voice.mjs).
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
// The build of 24 Oct 2026, a sharp photo: the parts shown on their own (parts list, wiring) are cut out of it
const BUILD = M + 'photos/IMG_20261024_143114_539.jpg';
const UW = 4160, UH = 3120;
const ON_BUILD = {
    esp32: [0.415, 0.373, 0.6, 0.667],
    esp32cam: [0.405, 0.18, 0.61, 0.67],
    lens: [0.425, 0.187, 0.595, 0.393],
    modem: [0.598, 0.25, 0.748, 0.443],
    charger: [0.62, 0.453, 0.733, 0.667],
    gps: [0.306, 0.243, 0.405, 0.363],
    antenna: [0.678, 0.147, 0.71, 0.247]
};
// The 5 V boost board, from the first board's photo (19 Oct 2026): the same mini boost board the trap uses again
const FIRST = M + 'photos/IMG_20261019_150930.jpg';
const FW = 2592, FH = 4608;
const BOOST = [0.482, 0.694, 0.737, 0.766];
// The trap as it is now (25 Oct 2026): the 5 V boost board in place of the 3.3 V regulator
const NOW = M + 'photos/build-2026-10-25.webp';
const NW = 844, NH = 633;
const ON_NOW = {
    esp32: [0.48, 0.34, 0.687, 0.632],
    lens: [0.498, 0.103, 0.658, 0.332],
    modem: [0.687, 0.229, 0.853, 0.395],
    charger: [0.711, 0.403, 0.865, 0.648],
    gps: [0.355, 0.221, 0.468, 0.34],
    boost: [0.338, 0.348, 0.415, 0.521],
    antenna: [0.752, 0.063, 0.791, 0.158]
};
// The assembled trap, and its lid from above
const TRAP = 'IMG_20261024_144403_702.jpg';
const LID = 'IMG_20261024_144519_297.jpg';

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
    harm(s) {
        const k = place(el('div', 'abs kicker', 'Why it matters', s), 120, 90);
        const t = place(el('div', 'abs title', 'Fruit flies: the most damaging pest of fruit worldwide', s), 120, 140, 1700); t.style.fontSize = '58px';
        const lead = place(el('div', 'abs sub', 'Females lay their eggs inside ripening fruit; the maggots ruin it from within.', s), 120, 232, 1700);
        const stats = [
            ['US$2 billion', 'lost every year to fruit flies in Africa alone', 'icipe, Fruit fly integrated pest management'],
            ['10 – 40 %', 'of a mango harvest lost to the flies', 'ICAR-IIHR, via ICRISAT ISSCA'],
            ['Closed markets', 'infested fruit is turned away at export: trade is restricted', 'De Meyer et al., ZooKeys 2015 (FAO/IAEA); icipe']
        ].map(([n, p, src], i) => place(el('div', 'card stat', `<b>${n}</b><p>${p}</p><small>${src}</small>`, s), 120 + i * 570, 360, 530, 330));
        const src = place(el('div', 'abs source', 'Tephritid fruit flies are "by far the most important group of horticultural pests worldwide" (De Meyer, Clarke, Vera, Hendrichs, ZooKeys 2015). Figures are estimates from the sources named.', s), 120, 760, 1700);
        const flies = [...Array(6)].map((_, i) => { const fl = place(el('div', 'abs', FLY, s), 0, 0, 40, 40); return fl; });
        return (tt) => {
            show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8)); show(lead, prog(tt, 1.2, 0.8));
            stats.forEach((c, i) => show(c, prog(tt, 9.6 + i * 1.6, 0.8), 40));
            show(src, prog(tt, 10.5, 0.8), 10);
            flies.forEach((fl, i) => {
                const a = tt * (0.5 + i * 0.07) + i * 2.1;
                const x = 1500 + Math.cos(a) * (220 + (i % 3) * 60);
                const y = 280 + Math.sin(a * 1.4) * 60;
                fl.style.transform = `translate(${x}px, ${y}px) rotate(${Math.cos(a) * 40}deg)`;
                fl.style.opacity = 0.8 * prog(tt, 0.4 + i * 0.15, 0.6) * (1 - prog(tt, 9, 0.8));
            });
        };
    },
    farmers(s) {
        const k = place(el('div', 'abs kicker', 'The farmer’s problem', s), 120, 90);
        const t = place(el('div', 'abs title', 'Checking traps by hand is slow, and the numbers come late', s), 120, 140, 1700); t.style.fontSize = '58px';
        const steps = [
            ['Walk the orchard', 'to every trap, every few days'],
            ['Count by eye', 'flies on each card or in each lure trap'],
            ['Act too late', 'or spray too much, to be safe']
        ].map(([h, p], i) => place(el('div', 'node', `<h3>${h}</h3><p>${p}</p>`, s), 120 + i * 440, 330));
        const fix = place(el('div', 'node hl', '<h3>FlyBot</h3><p>a camera on every trap: the flies are counted and the farmer is told in time</p>', s), 1440, 330);
        fix.style.width = '360px';
        return (tt) => {
            show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8));
            steps.forEach((n, i) => show(n, prog(tt, 0.8 + i * 1.4, 0.8), 40));
            show(fix, prog(tt, 7.5, 0.9), 40);
        };
    },
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
    pipeline: pipelineView,
    bom(s) {
        const k = place(el('div', 'abs kicker', 'The trap camera · bill of materials', s), 120, 60);
        const t = place(el('div', 'abs title', 'Open hardware: about US$39 per trap camera', s), 120, 108, 1700); t.style.fontSize = '48px';
        const parts = [
            ['photo', 'esp32', 'ESP32-S3 N16R8 CAM board', 'sold without a camera · US$6.91'],
            ['photo', 'lens', 'OV5640, wide-angle lens', '5 MP; the lens turns to focus · US$9.20'],
            ['photo', 'modem', '4G modem A7680C', 'antenna included · US$6.49'],
            ['photo', 'gps', 'GPS ATGM336H', 'antenna included · US$6.65'],
            ['photo', 'charger', 'Charger TP4056 + DW01', 'USB-C, protected · US$0.24'],
            ['boost', null, 'Mini 5 V boost', 'set to 5 V, on the board’s 5V pin · US$0.22'],
            ['cell', null, 'LiPo pouch cell 103450', '3.7 V, 2000 mAh, flat: fits the lid · US$2.76'],
            ['housing', null, 'Solar trap housing + lure', 'hanging, with lid · US$3.00 + US$0.34']
        ].map(([kind, key, h, p], i) => {
            // Two rows of four cards
            const card = place(el('div', 'part', '', s), 120 + (i % 4) * 430, 188 + Math.floor(i / 4) * 340);
            const pic = el('div', 'pic', '', card);
            if (kind === 'photo') crop(pic, BUILD, UW, UH, ON_BUILD[key], 400, 220);
            else if (kind === 'boost') crop(pic, FIRST, FW, FH, BOOST, 400, 220);
            else if (kind === 'housing') { const im = place(el('img', 'abs', undefined, pic), 0, 0, 400, 220); im.src = M + 'photos/' + TRAP; im.style.objectFit = 'cover'; }
            else if (kind === 'cell') pic.innerHTML = '<svg width="400" height="220"><rect x="70" y="70" width="240" height="80" rx="16" fill="#2f7d4f" stroke="#9fe3bd" stroke-width="3"/><rect x="310" y="92" width="18" height="36" rx="4" fill="#9fe3bd"/><text x="190" y="122" font-size="30" font-weight="800" fill="#eafff3" text-anchor="middle" font-family="Be Vietnam Pro">LiPo · 3.7 V</text></svg>';
            el('div', 'txt', `<h4>${h}</h4><p>${p}</p>`, card);
            return card;
        });
        const src = place(el('div', 'abs source', 'Prices read on shop pages on 17, 24 and 25 Oct 2026 (camos-esp32-trap docs/BOM.md, the field camera in the hanging solar trap); VND prices at 26,050 ₫/USD (Vietcombank, 21 Oct 2026). Total ≈ US$39.27 (944,760 ₫ + US$3.00 housing), with the 4G power switch, resistors, capacitors, prototype board and terminals (US$3.45); SIM not included.', s), 120, 870, 1700);
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
        // The lid as it is now, cut to the frame's 640:736 shape so that the marks land on their modules
        const R = [0.274, 0, 0.926, 1];
        const inner = place(el('div', 'abs', '', frame), 0, 0, 640, 736);
        crop(inner, NOW, NW, NH, R, 640, 736, 'cover');
        const toFrame = ([x0, y0, x1, y1]) => [((x0 + x1) / 2 - R[0]) / (R[2] - R[0]) * 640, ((y0 + y1) / 2 - R[1]) / (R[3] - R[1]) * 736];
        // Where each label is centred from its mark: above it, or below where a neighbour's label would cover it
        const OFFSET = { gps: [-30, -46], boost: [-40, 50], charger: [0, 50], antenna: [-60, -46], esp32: [-60, 60] };
        const tags = [['esp32', 'ESP32-S3 N16R8'], ['lens', 'OV5640, wide-angle lens'], ['modem', '4G A7680C'], ['charger', 'TP4056 charger'], ['gps', 'GPS ATGM336H'], ['boost', '5 V boost'], ['antenna', 'LTE antenna']].map(([key, label], i) => {
            const [x, y] = toFrame(ON_NOW[key]);
            const [dx, dy] = OFFSET[key] || [0, -46];
            const d = place(el('div', 'dotmark', '', s), 140 + x, 210 + y);
            const tag = place(el('div', 'tag', label, s), 140 + x + dx, 210 + y + dy);
            return { d, tag, i };
        });
        const housing = [[TRAP, 'The finished trap: the camera looks down into the clear body'], [LID, 'The lid from above: its solar panel charges the cell']].map(([f, cap], i) => {
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

// ---------------------------------------------------------------- how one photo becomes a report
// The path of flybot-aws docs/SYSTEM_ARCHITECTURE.md (2.1), drawn as one photo going through it: the trap camera, 4G,
// FlyBot on EC2 (S3 and MongoDB), the vision Lambda (OpenCV 5), the Sentinel agent, the farm's reports, and a person,
// whose confirmation alone sends the camera a command through AWS IoT Core.
const PIPE_ICON = {
    trap: '<svg width="200" height="160"><line x1="100" y1="0" x2="100" y2="14" stroke="#c9d0da" stroke-width="3"/><polygon class="cone" points="100,40 64,146 136,146" fill="rgba(62,207,142,0.2)" opacity="0"/><rect x="58" y="32" width="84" height="120" rx="12" fill="rgba(200,240,255,0.10)" stroke="rgba(200,240,255,0.55)" stroke-width="3"/><circle cx="60" cy="86" r="7" fill="#0b1310"/><circle cx="140" cy="86" r="7" fill="#0b1310"/><rect x="88" y="118" width="24" height="26" rx="5" fill="#f5b83d"/><rect x="50" y="12" width="100" height="22" rx="6" fill="#1b3358" stroke="#6eaaff" stroke-width="2"/><circle cx="100" cy="38" r="7" fill="#0b1310" stroke="#3ecf8e" stroke-width="3"/><circle class="flash" cx="100" cy="38" r="40" fill="#fff" opacity="0"/></svg>',
    tower: '<svg width="200" height="160"><path d="M100 50 L76 150 M100 50 L124 150 M84 118 L116 118 M90 88 L110 88" stroke="#c9d0da" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="100" cy="46" r="8" fill="#3ecf8e"/><path class="w1" d="M76 26 A31.2 31.2 0 0 0 76 66 M124 26 A31.2 31.2 0 0 1 124 66" stroke="#3ecf8e" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.3"/><path class="w2" d="M58 12 A54 54 0 0 0 58 80 M142 12 A54 54 0 0 1 142 80" stroke="#3ecf8e" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.3"/></svg>',
    ec2: '<svg width="200" height="160">' + [14, 60, 106].map((y, i) => `<rect x="44" y="${y}" width="112" height="38" rx="8" fill="#2a1d10" stroke="#ff9a3c" stroke-width="3"/><circle class="led" cx="62" cy="${y + 19}" r="5" fill="#3ecf8e" opacity="0.3"/><line x1="78" y1="${y + 19}" x2="138" y2="${y + 19}" stroke="#ff9a3c" stroke-width="4" stroke-linecap="round" opacity="0.6"/>`).join('') + '</svg>',
    store: '<svg width="200" height="160"><path d="M22 40 L36 140 Q62 152 88 140 L102 40" fill="#2b3d12" stroke="#8cc63f" stroke-width="3"/><ellipse cx="62" cy="40" rx="40" ry="12" fill="#3d5a17" stroke="#8cc63f" stroke-width="3"/><path d="M122 44 L122 132 A32 11 0 0 0 186 132 L186 44" fill="#10301f" stroke="#3ecf8e" stroke-width="3"/><ellipse cx="154" cy="44" rx="32" ry="11" fill="#17432b" stroke="#3ecf8e" stroke-width="3"/><path d="M122 74 A32 11 0 0 0 186 74 M122 104 A32 11 0 0 0 186 104" stroke="#3ecf8e" stroke-width="2" fill="none"/></svg>',
    lambda: '<svg width="200" height="160"><rect x="40" y="12" width="120" height="120" rx="26" fill="#ff9a3c"/><text x="100" y="108" font-size="100" font-weight="800" text-anchor="middle" fill="#2a1600" font-family="Georgia, serif">λ</text></svg>',
    agent: '<svg width="200" height="160"><rect x="50" y="14" width="100" height="134" rx="12" fill="#13241d" stroke="#3ecf8e" stroke-width="3"/><rect x="78" y="6" width="44" height="18" rx="6" fill="#3ecf8e"/>' + [54, 88, 122].map((y, i) => `<rect x="64" y="${y - 10}" width="20" height="20" rx="4" fill="none" stroke="#c9d0da" stroke-width="2.5"/><line x1="96" y1="${y}" x2="136" y2="${y}" stroke="#c9d0da" stroke-width="5" stroke-linecap="round"/><path class="ck${i}" d="M67 ${y} L73 ${y + 6} L83 ${y - 8}" stroke="#3ecf8e" stroke-width="4" fill="none" stroke-linecap="round" opacity="0"/>`).join('') + '</svg>',
    report: '<svg width="200" height="160"><rect x="24" y="12" width="152" height="108" rx="10" fill="#0f1c17" stroke="#c9d0da" stroke-width="3"/><rect x="90" y="120" width="20" height="16" fill="#c9d0da"/><rect x="64" y="134" width="72" height="8" rx="4" fill="#c9d0da"/>' + [0, 1, 2, 3].map(i => `<rect class="bar${i}" x="${44 + i * 30}" y="104" width="20" height="0" rx="3" fill="${i === 3 ? '#f5b83d' : '#3ecf8e'}"/>`).join('') + '</svg>',
    person: '<svg width="200" height="160"><circle cx="66" cy="44" r="22" fill="#c9d0da"/><path d="M26 146 Q26 86 66 86 Q106 86 106 146 Z" fill="#c9d0da"/><rect x="118" y="34" width="60" height="108" rx="10" fill="#0f1c17" stroke="#6eaaff" stroke-width="3"/><rect class="btn" x="128" y="108" width="40" height="22" rx="6" fill="#3ecf8e" opacity="0.5"/><path class="ok" d="M132 70 L144 82 L164 58" stroke="#3ecf8e" stroke-width="6" fill="none" stroke-linecap="round" opacity="0"/></svg>'
};
// The flies on the photo the token carries (card pixels), the ones YOLO26n boxes at the Lambda step
const TOKEN_FLIES = [[18, 16], [40, 40], [62, 20], [80, 46], [26, 50], [56, 52], [84, 16]];
function pipelineView(s) {
    // When things happen (scene seconds), set to the voice lines of script.js
    const T = { fly: 0.8, flash: 4.4, s2: 6.2, s3: 8.4, s4: 10.8, s5: 13.8, boxes: 15.6, s6: 20.0, chip: 20.8, s7: 24.2, chipGo: 25.4, s8: 26.4, ok: 27.0, loop: 27.3, flash2: 28.6 };
    const k = place(el('div', 'abs kicker', 'How it works', s), 120, 56);
    const t = place(el('div', 'abs title', 'From one fly to the farm’s report', s), 120, 94, 1700); t.style.fontSize = '52px';
    const zones = [['', 'In the orchard', 110, 185, 800, 335], ['aws', 'AWS · Sydney · one SAM stack', 1010, 185, 850, 715], ['', 'For the farmer', 110, 560, 800, 340]]
        .map(([cls, label, x, y, w, h]) => place(el('div', 'zone ' + cls, `<span>${label}</span>`, s), x, y, w, h));
    const CX = [300, 720, 1220, 1640], CY = [320, 700];
    const STAGES = [
        ['trap', 'A fly enters the trap', 'the camera in the lid takes a photo', 0, 0, 'fly'],
        ['tower', 'Sent over 4G', 'HTTPS, with the camera’s own token', 1, 0, 's2'],
        ['ec2', 'FlyBot on EC2', 'receives every photo', 2, 0, 's3'],
        ['store', 'Amazon S3 · MongoDB', 'the photo and its record', 3, 0, 's4'],
        ['lambda', 'AWS Lambda · OpenCV 5', 'YOLO26n counts the flies', 3, 1, 's5'],
        ['agent', 'Sentinel agent', 'checks the rules, proposes', 2, 1, 's6'],
        ['report', 'Dashboard and reports', 'counts, map, alerts', 1, 1, 's7'],
        ['person', 'A person confirms', 'on Telegram or in the app', 0, 1, 's8']
    ].map(([icon, h, p, c, r, at]) => {
        const st = place(el('div', 'stg', `<div class="ic">${PIPE_ICON[icon]}</div><h3>${h}</h3><p>${p}</p>`, s), CX[c] - 220, CY[r] - 80);
        return { st, ic: st.firstChild, svg: st.querySelector('svg'), at: T[at], x: CX[c], y: CY[r] };
    });
    // Connectors, drawn as the photo goes along them; the last one is the confirmed command going back to the camera
    const LINKS = [['M400 320 H620', 's2'], ['M820 320 H1120', 's3'], ['M1320 320 H1540', 's4'], ['M1740 320 H1835 V700 H1740', 's5'], ['M1540 700 H1320', 's6'], ['M1120 700 H820', 's7'], ['M620 700 H400', 'chipGo'], ['M200 700 H92 V320 H200', 'loop']];
    const svg = place(el('div', 'abs', `<svg width="1920" height="1080"><defs><marker id="pa" markerUnits="userSpaceOnUse" markerWidth="22" markerHeight="22" refX="18" refY="11" orient="auto"><path d="M0,0 L22,11 L0,22 z" fill="#3ecf8e"/></marker><marker id="pl" markerUnits="userSpaceOnUse" markerWidth="22" markerHeight="22" refX="18" refY="11" orient="auto"><path d="M0,0 L22,11 L0,22 z" fill="#f5b83d"/></marker></defs>${LINKS.map(([d], i) => `<path id="pk${i}" d="${d}" pathLength="1" stroke="${i === 7 ? '#f5b83d' : '#3ecf8e'}" stroke-width="5" fill="none" stroke-linejoin="round" stroke-dasharray="1 1" stroke-dashoffset="1" data-marker="url(#${i === 7 ? 'pl' : 'pa'})"/>`).join('')}</svg>`, s), 0, 0);
    const links = LINKS.map(([, at], i) => ({ p: svg.querySelector('#pk' + i), at: T[at] }));
    const lab4g = place(el('div', 'plink', '4G · HTTPS', s), 965, 282);
    const labAlert = place(el('div', 'plink', 'alerts', s), 965, 662);
    const labLoop = place(el('div', 'plink amber', 'AWS IoT Core → a new photo', s), 300, 540);
    // The fly, the photo (a sticky card with seven flies) and the proposal
    const fly = place(el('div', 'abs', FLY, s), 0, 0, 36, 36);
    const tok = place(el('div', 'ptok', `<svg width="96" height="66"><rect x="1" y="1" width="94" height="64" rx="6" fill="#f2d33b" stroke="#fff" stroke-width="2"/>${TOKEN_FLIES.map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="3.5" ry="5" fill="#3b2a12"/>`).join('')}${TOKEN_FLIES.map(([x, y], i) => `<rect class="bx${i}" x="${x - 8}" y="${y - 9}" width="16" height="18" fill="none" stroke="#c0392b" stroke-width="2.5" opacity="0"/>`).join('')}</svg><div class="pbadge"></div>`, s), 0, 0);
    const badge = tok.querySelector('.pbadge');
    const chip = place(el('div', 'pchip', 'Proposal: take a new photo', s), 0, 0);
    const rest = (i) => [STAGES[i].x + 95, STAGES[i].y - 70];
    // A point a fraction k along a polyline
    const along = (pts, k) => {
        const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
        let d = clamp(k) * seg.reduce((a, b) => a + b, 0);
        for (let i = 0; i < seg.length; i++) {
            if (d <= seg[i] || i === seg.length - 1) { const f = seg[i] ? d / seg[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; }
            d -= seg[i];
        }
    };
    // [start, end, points]: the photo's moves from stage to stage
    const MOVES = [[T.s2 - 0.8, T.s2, rest(0), rest(1)], [T.s3 - 1.2, T.s3, rest(1), rest(2)], [T.s4 - 0.8, T.s4, rest(2), rest(3)], [T.s5 - 1.0, T.s5, rest(3), [1835, 250], [1835, 630], rest(4)], [T.s6 - 0.8, T.s6, rest(4), rest(5)], [T.s7 - 0.8, T.s7, rest(5), rest(6)]];
    const tokenAt = (tt) => {
        let at = rest(0);
        for (const [t0, t1, ...pts] of MOVES) if (tt >= t0) at = along(pts, ease((tt - t0) / (t1 - t0)));
        return at;
    };
    return (tt) => {
        show(k, prog(tt, 0, 0.6)); show(t, prog(tt, 0.2, 0.8));
        zones.forEach((z, i) => { z.style.opacity = prog(tt, 0.3 + i * 0.2, 0.6); });
        // Stages: dim until the photo reaches them, then lit, with a glow that fades
        STAGES.forEach((st, i) => {
            st.st.style.opacity = prog(tt, 0.4 + i * 0.1, 0.5) * (0.4 + 0.6 * prog(tt, st.at - 0.3, 0.5));
            const g = tt < st.at ? 0 : Math.max(0, 1 - (tt - st.at) / 2.5);
            st.ic.style.filter = g ? `drop-shadow(0 0 ${24 * g}px rgba(62, 207, 142, ${0.9 * g}))` : '';
        });
        links.forEach(({ p, at }, i) => {
            const t0 = i === 7 ? T.loop : i === 6 ? T.chipGo : MOVES[i][0];
            const d = prog(tt, t0, Math.max(0.6, at - t0 - (i === 7 ? 0 : 0.2)));
            p.style.strokeDashoffset = 1 - d;
            // The arrowhead only once the line has reached it
            if (d > 0.97) p.setAttribute('marker-end', p.dataset.marker); else p.removeAttribute('marker-end');
        });
        // Opacity only: the labels are centred with their own transform
        lab4g.style.opacity = prog(tt, T.s3 - 1.2, 0.5); labAlert.style.opacity = prog(tt, T.s7 - 0.6, 0.5); labLoop.style.opacity = prog(tt, T.loop + 0.4, 0.5);
        // 1: the fly comes in through a hole in the wall, down to the lure; the camera flashes
        const [tx, ty] = [STAGES[0].x, STAGES[0].y];
        const f = clamp((tt - T.fly) / 2.6);
        const fx = f < 0.8 ? tx - 220 + 180 * (f / 0.8) : tx - 40 + 30 * ((f - 0.8) / 0.2);
        const fy = f < 0.8 ? ty - 100 + 106 * (f / 0.8) + Math.sin(f * 14) * 22 * (1 - f) : ty + 6 + 32 * ((f - 0.8) / 0.2);
        fly.style.transform = `translate(${fx - 18}px, ${fy - 18}px) rotate(${f < 1 ? Math.sin(tt * 40) * 12 + 30 : 0}deg) scale(${1 - 0.25 * clamp((f - 0.8) / 0.2)})`;
        fly.style.opacity = prog(tt, T.fly - 0.4, 0.4);
        const flash = Math.max(0, 1 - Math.abs(tt - T.flash) / 0.35) + Math.max(0, 1 - Math.abs(tt - T.flash2) / 0.35);
        STAGES[0].svg.querySelector('.flash').setAttribute('opacity', 0.85 * flash);
        STAGES[0].svg.querySelector('.cone').setAttribute('opacity', clamp(flash * 2));
        // The photo leaves the lens and goes along the path; at the Lambda its flies get boxes and a count
        const [px, py] = tokenAt(tt);
        const born = prog(tt, T.flash, 0.6), gone = prog(tt, T.s7 + 0.1, 0.6);
        const [lx, ly] = [tx, ty - 42];
        const bx = tt < T.s2 - 0.8 ? lx + (px - lx) * born : px, by = tt < T.s2 - 0.8 ? ly + (py - ly) * born : py;
        tok.style.opacity = born * (1 - gone);
        tok.style.transform = `translate(${bx - 48}px, ${by - 33}px) scale(${(0.3 + 0.7 * born) * (1 - 0.6 * gone)})`;
        const n = Math.floor(clamp((tt - T.boxes) / 1.8) * TOKEN_FLIES.length + 0.001);
        TOKEN_FLIES.forEach((_, i) => tok.querySelector('.bx' + i).setAttribute('opacity', i < n ? 1 : 0));
        badge.textContent = n ? `${n} flies` : '';
        badge.style.opacity = n ? 1 : 0;
        // 2, 3: the radio and the server come alive as the photo passes
        const wave = tt > T.s2 - 0.8 && tt < T.s3 ? 0.5 + 0.5 * Math.sin(tt * 9) : 0;
        STAGES[1].svg.querySelector('.w1').setAttribute('opacity', 0.3 + 0.7 * wave);
        STAGES[1].svg.querySelector('.w2').setAttribute('opacity', 0.3 + 0.7 * (tt > T.s2 - 0.8 && tt < T.s3 ? 0.5 + 0.5 * Math.sin(tt * 9 - 1.5) : 0));
        STAGES[2].svg.querySelectorAll('.led').forEach((l, i) => l.setAttribute('opacity', tt < T.s3 ? 0.3 : 0.45 + 0.55 * (Math.sin(tt * 6 + i * 2) > 0 ? 1 : 0)));
        // 6: the agent ticks its rules and makes a proposal, which goes to the person
        [0, 1, 2].forEach(i => STAGES[5].svg.querySelector('.ck' + i).setAttribute('opacity', prog(tt, T.s6 + i * 0.3, 0.3)));
        const cp = prog(tt, T.chipGo, T.s8 - T.chipGo);
        // From above the agent to the arrow that ends at the person's phone
        chip.style.left = (STAGES[5].x + (510 - STAGES[5].x) * cp) + 'px';
        chip.style.top = (600 + 100 * cp) + 'px';
        chip.style.opacity = prog(tt, T.chip, 0.5) * (1 - prog(tt, T.ok + 0.2, 0.4));
        // 7: the count goes into the report's bars
        [30, 46, 38, 74].forEach((h, i) => {
            const v = h * prog(tt, i === 3 ? T.s7 : 0.6, i === 3 ? 1.2 : 0.8);
            const bar = STAGES[6].svg.querySelector('.bar' + i);
            bar.setAttribute('height', v); bar.setAttribute('y', 104 - v);
        });
        // 8: confirmed; the command goes back to the camera through AWS IoT Core, and the camera takes the next photo
        STAGES[7].svg.querySelector('.ok').setAttribute('opacity', prog(tt, T.ok, 0.3));
        STAGES[7].svg.querySelector('.btn').setAttribute('opacity', 0.5 + 0.5 * prog(tt, T.ok - 0.2, 0.2));
        STAGES[0].ic.style.filter = tt > T.flash2 - 0.3 ? `drop-shadow(0 0 ${24 * Math.max(0, 1 - Math.abs(tt - T.flash2) / 1.5)}px rgba(245, 184, 61, 0.9))` : STAGES[0].ic.style.filter;
    };
}

// ---------------------------------------------------------------- wiring animation (4G build)
// Modules and pins follow camos-esp32-trap docs/WIRING.md (25 Oct 2026), the hanging trap's wiring: the panel and the
// LiPo on the charger, a 5 V boost board on the board's 5V pin (the board makes its own 3.3 V), the modem from the cell
// through its power switch on GPIO47, the GPS also from the cell with its ground switched on GPIO21 and its UART on
// GPIO14 / GPIO3, a divider on GPIO1. Only the wiring is
// shown.
function wiringView(s) {
    const STEPS = [
        [0, '1', 'Cell, charger and solar panel'],
        [6.6, '2', '5 V boost converter → board 5V'],
        [12.4, '3', '4G modem: from the cell through its switch, UART on GPIO41 / 42'],
        [18.0, '4', 'GPS: from the cell, UART on GPIO14 / GPIO3 · battery divider → GPIO1']
    ];
    const step = place(el('div', 'step', '<i></i><span></span>', s), 90, 34);
    const mods = {};
    const mod = (key, x, y, w, h, name, sub, pic, at) => {
        const m = place(el('div', 'mod', '', s), x, y, w, h);
        const p = place(el('div', 'pic', '', m), 0, 0, w, h - 74);
        if (pic === 'boost') crop(p, FIRST, FW, FH, BOOST, w, h - 74);
        else if (pic === 'photo') crop(p, BUILD, UW, UH, ON_BUILD[key === 'esp32' ? 'esp32cam' : key], w, h - 74);
        else p.innerHTML = pic;
        el('div', 'name', `${name}<small>${sub}</small>`, m);
        mods[key] = { m, at };
    };
    const panelSvg = `<svg width="300" height="96"><rect x="20" y="12" width="260" height="72" rx="6" fill="#1b3358" stroke="#6eaaff" stroke-width="2"/>${[...Array(5)].map((_, i) => `<line x1="${20 + (i + 1) * 43}" y1="12" x2="${20 + (i + 1) * 43}" y2="84" stroke="#6eaaff" stroke-width="1"/>`).join('')}<line x1="20" y1="48" x2="280" y2="48" stroke="#6eaaff" stroke-width="1"/></svg>`;
    const cellSvg = `<svg width="300" height="76"><rect x="40" y="16" width="200" height="48" rx="10" fill="#2f7d4f" stroke="#9fe3bd" stroke-width="2"/><rect x="240" y="30" width="14" height="20" rx="3" fill="#9fe3bd"/><text x="140" y="48" font-size="22" font-weight="800" fill="#eafff3" text-anchor="middle" font-family="Be Vietnam Pro">LiPo</text></svg>`;
    mod('solar', 90, 150, 300, 170, 'Solar panel 6 V 2 W', 'optional', panelSvg, 0.6);
    mod('charger', 90, 400, 300, 200, 'TP4056 charger', 'with DW01 protection', 'photo', 0.2);
    mod('cell', 90, 700, 300, 150, 'LiPo cell', '3.7 – 4.2 V, flat', cellSvg, 0.2);
    mod('boost', 520, 400, 270, 200, '5 V boost', 'set to 5.0 – 5.2 V', 'boost', 6.8);
    mod('esp32', 920, 250, 400, 600, 'ESP32-S3 CAM', 'N16R8 · OV5640 wide-angle', 'photo', 6.8);
    mod('modem', 1460, 160, 380, 300, '4G A7680C', 'TDM2309 · nano SIM', 'photo', 12.6);
    mod('gps', 1460, 560, 380, 260, 'GPS ATGM336H', 'patch antenna faces up', 'photo', 18.2);

    // Pins: [label, x, y, side]
    const pins = [
        ['IN+', 150, 400, 'b', 0.6], ['IN−', 330, 400, 'b', 0.6], ['B+', 150, 600, 'u', 0.2], ['B−', 330, 600, 'u', 0.2], ['OUT+', 390, 450, 'r', 0.2], ['OUT−', 390, 500, 'r', 0.2],
        ['IN+', 520, 450, 'l', 6.8], ['IN−', 520, 500, 'l', 6.8], ['OUT+', 790, 450, 'r', 6.8], ['OUT−', 790, 500, 'r', 6.8],
        ['5V', 920, 330, 'l', 6.8], ['GND', 920, 390, 'l', 6.8], ['GPIO1', 920, 760, 'l', 18.2],
        ['GPIO47', 1320, 270, 'r', 12.6], ['GPIO41', 1320, 320, 'r', 12.6], ['GPIO42', 1320, 370, 'r', 12.6], ['GPIO14', 1320, 668, 'r', 18.2], ['GPIO3', 1320, 704, 'r', 18.2], ['GPIO21', 1320, 814, 'r', 18.2],
        ['VCC', 1460, 210, 'l', 12.6], ['GND', 1460, 260, 'l', 12.6], ['RXD', 1460, 320, 'l', 12.6], ['TXD', 1460, 370, 'l', 12.6],
        ['VCC', 1840, 600, 'r', 18.2], ['TX', 1460, 668, 'l', 18.2], ['RX', 1460, 704, 'l', 18.2], ['GND', 1460, 740, 'l', 18.2]
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
        ['sense', [[1320, 270], [1360, 270], [1360, 170], [1190, 170], [1190, 146]], 14.2, 0.8, true],
        ['uart', [[1320, 320], [1460, 320]], 15.0, 0.7], ['uart', [[1460, 370], [1320, 370]], 15.6, 0.7],
        ['bat', [[1410, 120], [1880, 120], [1880, 600], [1840, 600]], 18.6, 1.0], ['gps', [[1460, 668], [1320, 668]], 19.2, 0.7], ['gps', [[1320, 704], [1460, 704]], 19.5, 0.7],
        ['gnd', [[1460, 740], [1420, 740], [1420, 866]], 19.8, 0.5], ['sense', [[1320, 814], [1336, 814], [1336, 890], [1350, 890]], 20.2, 0.5, true],
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
        ${[[680, 792], [1420, 290], [1435, 922]].map(([x, y]) => `<g stroke="var(--w-gnd)" stroke-width="4"><line x1="${x}" y1="${y}" x2="${x}" y2="${y + 2}"/><line x1="${x - 16}" y1="${y + 4}" x2="${x + 16}" y2="${y + 4}"/><line x1="${x - 10}" y1="${y + 11}" x2="${x + 10}" y2="${y + 11}"/><line x1="${x - 4}" y1="${y + 18}" x2="${x + 4}" y2="${y + 18}"/></g>`).join('')}
        </svg>`, s), 0, 0, W, H);
    extras.style.pointerEvents = 'none';
    // The two power switches: a P-MOSFET in the 4G supply, a C1815 in the GPS ground
    const switches = [
        [13.0, 1060, 96, 260, '4G switch · GPIO47', 'AO3401A + C1815'],
        [19.8, 1350, 866, 170, 'C1815', 'GPS ground']
    ].map(([at, x, y, w, h, sub]) => ({ b: place(el('div', 'note', `${h}<br><span style="font-size:16px;font-weight:500">${sub}</span>`, s), x, y, w), at }));
    switches.forEach(({ b }) => { b.style.padding = '4px 12px'; b.style.fontSize = '18px'; b.style.background = '#0f1c17'; b.style.textAlign = 'center'; });
    const notes = [
        [7.4, 9, 'Set the boost to 5 V (pads A/B to 0/0) and measure 5.0 – 5.2 V before it touches the board', 470, 640, 400],
        [13.0, 7, 'Modem VCC from the cell (3.7 – 4.2 V), never 5 V or 3.3 V; 1000 µF + 100 nF at VCC', 930, 880, 900],
        [22.6, 3.4, 'All grounds common · wire it as drawn', 470, 880, 860]
    ].map(([at, len, text, x, y, w]) => ({ n: place(el('div', 'note', text, s), x, y, w), at, len }));
    const legend = place(el('div', 'abs source', 'Drawn by function, not by position on the board · camos-esp32-trap docs/WIRING.md (25 Oct 2026)', s), 162, 98, 1300);
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
        switches.forEach(({ b, at }) => { b.style.opacity = prog(tt, at, 0.5); });
        notes.forEach(({ n, at, len }) => { n.style.opacity = clamp((tt - at) / 0.4) * clamp((at + len - tt) / 0.4); });
        legend.style.opacity = prog(tt, 1, 0.8) * 0.9;
    };
}

// ---------------------------------------------------------------- the orchard clip
// The owner's clip: media/footage/real-trap.mp4 (or footage.json { "file", "from" } or { "file", "segments": [[from, to], ...] }).
// ?footage=placeholder (render-film.mjs --footage placeholder) is the only way to show the internal stand-in instead:
// media/vendor/footage.json { "file", "segments" }, always labelled as a placeholder in the corner.
// Without either, the slot shows a placeholder card.
const FOOTAGE_SOURCE = q.get('footage') === 'placeholder' ? 'placeholder' : 'owner';
const PLACEHOLDER_LABEL = 'Placeholder: seller footage, to be replaced';
let footage = null;
async function loadFootage() {
    if (FOOTAGE_SOURCE === 'placeholder') {
        const r = await fetch(M + 'vendor/footage.json');
        if (!r.ok) throw new Error('media/vendor/footage.json is missing');
        const f = await r.json();
        return { file: M + 'vendor/' + f.file, segments: f.segments || [[f.from || 0, Infinity]], label: PLACEHOLDER_LABEL };
    }
    try {
        const r = await fetch(M + 'footage/footage.json');
        if (r.ok) { const f = await r.json(); return { file: M + 'footage/' + f.file, segments: f.segments || [[f.from || 0, Infinity]], label: null }; }
    } catch { /* none */ }
    for (const name of ['real-trap.mp4', 'real-trap.webm', 'real-trap.mov']) {
        if (await exists(M + 'footage/' + name)) return { file: M + 'footage/' + name, segments: [[0, Infinity]], label: null };
    }
    return null;
}
// Second tt of the slot -> second of the clip, through the segments in order (the last frame holds at the end)
function clipTime(segments, tt, duration) {
    let rest = tt;
    for (const [from, to] of segments) {
        const len = Math.min(to, duration) - from;
        if (rest < len) return from + rest;
        rest -= len;
    }
    const [from, to] = segments[segments.length - 1];
    return Math.max(from, Math.min(to, duration) - 0.05);
}
function fieldView(s) {
    const video = place(el('video', 'abs', undefined, s), 0, 0, W, H);
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.style.objectFit = 'cover'; video.style.display = 'none';
    const real = place(el('div', 'abs', '<span class="chip">In the orchard · real footage</span>', s), 60, 50);
    const stand = place(el('div', 'abs', `<span class="chip ph" style="font-size:24px">${PLACEHOLDER_LABEL}</span>`, s), 60, 50);
    const ph = place(el('div', 'abs', '', s), 0, 0, W, H);
    ph.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;background:repeating-linear-gradient(45deg,#0f1a15,#0f1a15 26px,#0c1511 26px,#0c1511 52px)">
        <div><span class="chip ph">Placeholder · 30 s</span>
        <div class="title" style="margin-top:28px">The wired trap in the orchard</div>
        <div class="sub" style="margin-top:16px">Real footage from the team goes here</div>
        <div class="source mono" style="margin-top:26px;font-size:22px">tools/media/film/media/footage/real-trap.mp4</div></div></div>`;
    return async (tt) => {
        real.style.display = footage && !footage.label ? 'block' : 'none';
        stand.style.display = footage && footage.label ? 'block' : 'none';
        if (!footage) { ph.style.display = 'block'; video.style.display = 'none'; return; }
        ph.style.display = 'none';
        video.style.display = 'block';
        if (video.dataset.src !== footage.file) { video.dataset.src = footage.file; video.src = footage.file; await new Promise(r => { video.onloadeddata = r; video.onerror = r; }); }
        const want = clipTime(footage.segments, tt, video.duration || 0);
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
    footage = await loadFootage();
    DURATION = buildTimeline();
    for (const sc of TIMELINE) {
        const s = el('div', 'scene', '', stage);
        s.dataset.id = sc.id;
        const draw = sc.rec ? recView(s, sc.id) : VIEWS[sc.id](s);
        views.push({ sc, s, draw });
    }
    for (const sc of TIMELINE) if (sc.rec) for (const c of EDIT[sc.id].clips) await loadRec(c.shot);
    await document.fonts.ready;
    window.FILM = { duration: DURATION, width: W, height: H, fps: 30, cues: CUES, scenes: TIMELINE.map(s => ({ id: s.id, start: s.start, len: s.len })), footage: footage ? FOOTAGE_SOURCE : null, maxSeconds: MAX_SECONDS };
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
