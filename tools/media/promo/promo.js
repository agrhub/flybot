// FlyBot introduction film (Vietnamese): one timeline drawn with HTML and CSS, driven by a virtual clock, like the
// demo film (../film). window.renderAt(t) draws second t exactly (and resolves once every picture is decoded and every
// video has seeked), so render-promo.mjs can take frame after frame. ?t=<s> shows one moment; without ?render it plays.
// ?subs=none hides the subtitles.
import { SCENES } from './script.js';

const q = new URLSearchParams(location.search);
const SUBS = q.get('subs') !== 'none';
const stage = document.getElementById('stage');
const TVC = '/app/media/flybot-tvc-vi.mp4';
const FOOTAGE = '/media/footage/real-trap.mp4';
const VOICE = '/media/promo-voice/';
const BAR = 2.4;

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (k) => { k = clamp(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const prog = (t, t0, d) => ease((t - t0) / d);
const el = (tag, cls, html, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; if (parent) parent.appendChild(e); return e; };
const show = (e, p, dy = 30) => { e.style.opacity = p; e.style.transform = `translateY(${(1 - p) * dy}px)`; };
const decoded = new Set();
async function setSrc(img, src) {
    if (img.dataset.src === src) return;
    img.dataset.src = src;
    img.src = src;
    try { await img.decode(); } catch { /* missing picture: leave it blank */ }
    decoded.add(src);
}
function zoomAt(keys, t) {
    if (t <= keys[0][0]) return keys[0].slice(1);
    for (let i = 1; i < keys.length; i++) {
        if (t <= keys[i][0]) {
            const a = keys[i - 1], b = keys[i], k = ease((t - a[0]) / (b[0] - a[0] || 1));
            return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
        }
    }
    return keys[keys.length - 1].slice(1);
}
// A video element seeked to a time (a hair past the frame's start, so the frame itself is shown)
function videoAt(parent, src) {
    const v = el('video', '', undefined, parent);
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = src;
    const loaded = new Promise(r => { v.onloadeddata = r; v.onerror = r; });
    return async (time) => {
        await loaded;
        const want = Math.min(time + 0.004, (v.duration || time + 1) - 0.02);
        if (Math.abs(v.currentTime - want) < 0.001) return;
        await new Promise(r => { const done = () => { v.removeEventListener('seeked', done); r(); }; v.addEventListener('seeked', done); v.currentTime = want; setTimeout(done, 3000); });
    };
}
function textColumn(s, sc, x, y, w) {
    const col = el('div', 'col', '', s);
    Object.assign(col.style, { left: x + 'px', top: y + 'px', width: w + 'px' });
    const k = el('div', 'kicker', sc.kicker, col);
    const t = el('div', 'title', sc.title, col);
    const pts = (sc.points || []).map(p => el('div', 'point', `<i></i><span>${p}</span>`, col));
    const chips = sc.chips ? el('div', 'chips', sc.chips.map(c => `<span class="chip guest">${c}</span>`).join(''), col) : null;
    return (tt) => {
        show(k, prog(tt, 0.1, 0.6)); show(t, prog(tt, 0.3, 0.8));
        pts.forEach((p, i) => show(p, prog(tt, 1.0 + i * 0.5, 0.6), 20));
        if (chips) show(chips, prog(tt, 1.2 + pts.length * 0.5, 0.6), 20);
    };
}

// ---------------------------------------------------------------- the scenes
const VIEWS = {
    tvc(s, sc) {
        const seek = videoAt(el('div', 'full', '', s), TVC);
        return (tt) => seek(sc.from + tt);
    },
    footage(s, sc) {
        const seek = videoAt(el('div', 'full', '', s), FOOTAGE);
        el('div', 'shade', '', s);
        const k = el('div', 'kicker abs', sc.kicker, s); Object.assign(k.style, { left: '90px', top: '70px' });
        const t = el('div', 'title abs', sc.title, s); Object.assign(t.style, { left: '90px', top: '112px', width: '1200px', fontSize: '58px' });
        const segs = sc.segments;
        return async (tt) => {
            show(k, prog(tt, 0.2, 0.6)); show(t, prog(tt, 0.4, 0.8));
            let rest = tt, at = segs[0][0];
            for (const [from, to] of segs) { if (rest < to - from) { at = from + rest; break; } rest -= to - from; at = to; }
            await seek(at);
        };
    },
    photos(s, sc) {
        const text = textColumn(s, sc, 90, 250, 720);
        const cards = sc.photos.map(p => {
            const card = el('div', 'pcard', '', s);
            Object.assign(card.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px' });
            const cap = p.caption ? el('div', 'pcap', p.caption, card) : null;
            return { p, card, cap, img: el('img', '', undefined, card) };
        });
        return async (tt) => {
            text(tt);
            for (const { p, card, img } of cards) {
                await setSrc(img, p.src);
                show(card, prog(tt, p.at, 0.8), 40);
                const k = clamp((tt - p.at) / (sc.dur - p.at));
                const [cx, cy, z] = p.from.map((v, j) => v + (p.to[j] - v) * k);
                // Cover the card, then push in towards (cx, cy)
                const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
                const sc2 = Math.max(p.w / w, p.h / h) * z;
                const x = clamp(p.w / 2 - cx * w * sc2, p.w - w * sc2, 0), y = clamp(p.h / 2 - cy * h * sc2, p.h - h * sc2, 0);
                Object.assign(img.style, { width: w + 'px', height: h + 'px', transform: `translate(${x}px, ${y}px) scale(${sc2})` });
            }
        };
    },
    app(s, sc) {
        const text = textColumn(s, sc, 90, 220, 540);
        const win = el('div', 'win app', '<div class="bar"><i></i><i></i><i></i><span>flybot.agrhub.com</span></div>', s);
        const views = sc.shots.map(() => { const v = el('div', 'view', '', win); return { v, img: el('img', '', undefined, v) }; });
        const VW = 1160, VH = 725;
        return async (tt) => {
            text(tt);
            let start = 0;
            for (const [i, shot] of sc.shots.entries()) {
                const { v, img } = views[i];
                const len = shot.dur ?? Infinity;
                const local = tt - start;
                v.style.opacity = i === 0 ? 1 : prog(local, -0.25, 0.5);
                v.style.visibility = local > -0.3 && (i === sc.shots.length - 1 || local < len + 0.3) ? 'inherit' : 'hidden';
                if (v.style.visibility === 'inherit') {
                    await setSrc(img, shot.src.startsWith('/') ? shot.src : `/app/manual/vi/${shot.src}.webp`);
                    const w = shot.w || 1440, h = shot.h || 900;
                    const [cx, cy, z] = zoomAt(shot.zoom, Math.max(0, local));
                    const k = Math.min(VW / w, VH / h) * z;
                    const x = w * k > VW ? clamp(VW / 2 - cx * k, VW - w * k, 0) : (VW - w * k) / 2;
                    const y = h * k > VH ? clamp(VH / 2 - cy * k, VH - h * k, 0) : (VH - h * k) / 2;
                    Object.assign(img.style, { width: w + 'px', height: h + 'px', transform: `translate(${x}px, ${y}px) scale(${k})` });
                }
                start += len;
            }
            win.style.opacity = prog(tt, 0, 0.6);
            win.style.transform = `translateY(${(1 - prog(tt, 0, 0.8)) * 40}px)`;
        };
    },
    end(s, sc) {
        const box = el('div', 'endbox', `<img src="/app/logo.png" alt=""><div class="brand">FlyBot</div>
            <div class="head">${sc.head.map(l => `<div>${l}</div>`).join('')}</div>
            <div class="url">${sc.url}</div><div class="small">${sc.small}</div>`, s);
        const parts = [...box.children];
        return (tt) => parts.forEach((p, i) => show(p, prog(tt, 0.2 + i * 0.35, 0.8), 24));
    }
};

// ---------------------------------------------------------------- the timeline
let TIMELINE = [], CUES = [], views = [], DURATION = 0, lastScene = null;
async function loadVoice() {
    try { const r = await fetch(VOICE + 'manifest.json'); return r.ok ? await r.json() : {}; } catch { return {}; }
}
function buildTimeline(voice) {
    let at = 0;
    for (const sc of SCENES) {
        let end = sc.kind === 'tvc' ? sc.to - sc.from : sc.dur;
        sc.lines.forEach((l, i) => {
            const id = `${sc.id}-${i}`;
            // Reading time without a voice: about 14 characters a second, at least 2.5 s
            const len = voice[id] || Math.max(2.5, l.vi.length / 14);
            if (sc.kind !== 'tvc') end = Math.max(end, l.at + len + 0.7);
            CUES.push({ id, start: +(at + l.at).toFixed(3), end: +(at + l.at + len + 0.25).toFixed(3), vi: l.vi, voice: voice[id] ? `${VOICE.slice(1)}${id}.wav` : null });
        });
        TIMELINE.push({ ...sc, start: at, len: end });
        at += end;
    }
    // A subtitle ends before the next one starts
    CUES.forEach((c, i) => { if (CUES[i + 1]) c.end = Math.min(c.end, CUES[i + 1].start - 0.05); });
    return at;
}
// The music (../tvc/music.js, mixed by ../film/mix.html): the commercial's first 12 bars under its own pictures,
// then its app-demo groove under the screens, and the bright closing pad on the call to action
function arrangement(duration) {
    const bars = Math.ceil(duration / BAR) + 1;
    const open = ['Am', 'F', 'Am', 'Dm', 'F', 'E', 'C', 'G', 'C', 'G', 'Am', 'F'];
    const loop = ['C', 'G', 'Am', 'F'];
    const progression = [...Array(bars)].map((_, i) => i < open.length ? open[i] : loop[(i - open.length) % 4]);
    progression.splice(bars - 3, 3, 'C', 'F', 'C');
    return { progression, quietTo: 3, bassFrom: 3, halfKick: [3, 6], groove: [8, bars - 4], clapFrom: 12, brand: [6, 7], rise: 6, hits: [6, bars - 4], endFrom: bars - 4 };
}
const subs = el('div', '', '<div></div>', stage); subs.id = 'subs';

async function ready() {
    await document.fonts.ready;
    DURATION = buildTimeline(await loadVoice());
    for (const sc of TIMELINE) {
        const s = el('div', 'scene', '', stage);
        views.push({ sc, s, draw: VIEWS[sc.kind](s, sc) });
    }
    window.FILM = { duration: DURATION, width: 1920, height: 1080, fps: 30, cues: CUES, scenes: TIMELINE.map(s => ({ id: s.id, start: s.start, len: s.len })), arrangement: arrangement(DURATION) };
    return window.FILM;
}

async function renderAt(T) {
    const FADE = 0.35;
    let cur = views[views.length - 1];
    for (const v of views) if (T >= v.sc.start && T < v.sc.start + v.sc.len) { cur = v; break; }
    if (lastScene !== cur) { views.forEach(v => { v.s.style.visibility = v === cur ? 'visible' : 'hidden'; }); lastScene = cur; }
    const t = T - cur.sc.start;
    // Through black between scenes; the commercial's two parts follow each other without a dip inside them
    cur.s.style.opacity = Math.min(clamp(t / FADE), clamp((cur.sc.len - t) / FADE), cur === views[0] ? clamp(t / 0.8) : 1);
    await cur.draw(t, cur.sc.len);
    const cue = SUBS ? CUES.find(c => T >= c.start && T < c.end) : null;
    subs.firstChild.textContent = cue ? cue.vi : '';
}

window.ready = ready();
window.renderAt = renderAt;
if (!q.has('render')) {
    window.ready.then(async () => {
        if (q.has('t')) { await renderAt(Number(q.get('t'))); return; }
        const t0 = performance.now() - Number(q.get('from') || 0) * 1000;
        const loop = async () => { await renderAt(((performance.now() - t0) / 1000) % DURATION); requestAnimationFrame(loop); };
        loop();
    });
}
