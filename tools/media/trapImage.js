// Synthetic sticky-trap photo for screenshots: a yellow grid card with fruit flies (and a few
// moths) at fixed positions, so the AI boxes stored with a snapshot match what is drawn.
const jpeg = require(require.resolve('jpeg-js', { paths: [require('path').resolve(__dirname, '../../server')] }));

const W = 960;
const H = 720;
const CARD = { x0: 48, y0: 36, x1: 912, y1: 684 };

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

// Positions of up to `n` insects on a card, never overlapping much
function layout(seed, n) {
    const r = rng(seed);
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 200) {
        const x = CARD.x0 + 30 + r() * (CARD.x1 - CARD.x0 - 60);
        const y = CARD.y0 + 30 + r() * (CARD.y1 - CARD.y0 - 60);
        if (out.some(p => (p.x - x) ** 2 + (p.y - y) ** 2 < 34 * 34)) continue;
        out.push({ x, y, angle: r() * Math.PI * 2, scale: 0.85 + r() * 0.35 });
    }
    return out;
}

function makeCanvas() {
    const data = Buffer.alloc(W * H * 4);
    const set = (x, y, c, a = 1) => {
        x |= 0; y |= 0;
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const i = (y * W + x) * 4;
        data[i] = data[i] * (1 - a) + c[0] * a;
        data[i + 1] = data[i + 1] * (1 - a) + c[1] * a;
        data[i + 2] = data[i + 2] * (1 - a) + c[2] * a;
        data[i + 3] = 255;
    };
    // Filled rotated ellipse
    const ellipse = (cx, cy, rx, ry, angle, c, a = 1) => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const R = Math.ceil(Math.max(rx, ry)) + 1;
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                const u = (dx * cos + dy * sin) / rx;
                const v = (-dx * sin + dy * cos) / ry;
                const d = u * u + v * v;
                if (d <= 1) set(cx + dx, cy + dy, c, a * (d > 0.8 ? (1 - d) * 5 : 1));
            }
        }
    };
    return { data, set, ellipse };
}

function background(cv, seed) {
    const r = rng(seed ^ 0x9e3779b9);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const inCard = x >= CARD.x0 && x < CARD.x1 && y >= CARD.y0 && y < CARD.y1;
            const n = (r() - 0.5) * 14;
            let c;
            if (inCard) {
                const shade = 1 - (y - CARD.y0) / (CARD.y1 - CARD.y0) * 0.08 - Math.abs(x - W / 2) / W * 0.06;
                c = [238 * shade + n, 206 * shade + n, 46 * shade + n * 0.5];
                const gx = (x - CARD.x0) % 72;
                const gy = (y - CARD.y0) % 72;
                if (gx < 2 || gy < 2) c = [c[0] * 0.82, c[1] * 0.82, c[2] * 0.8];
            } else {
                // Leaves behind the card
                const leaf = Math.sin(x / 37 + Math.sin(y / 23)) * 18;
                c = [42 + leaf * 0.4 + n, 78 + leaf + n, 38 + n];
            }
            cv.set(x, y, c.map(v => Math.max(0, Math.min(255, v))));
        }
    }
}

function drawFly(cv, p) {
    const s = 1.4 * p.scale;
    const a = p.angle;
    const along = (d) => [p.x + Math.cos(a) * d, p.y + Math.sin(a) * d];
    // Wings
    for (const side of [-1, 1]) {
        const wa = a + side * 0.55;
        const [wx, wy] = [p.x + Math.cos(wa) * 6 * s - Math.cos(a) * 2 * s, p.y + Math.sin(wa) * 6 * s - Math.sin(a) * 2 * s];
        cv.ellipse(wx, wy, 9 * s, 3.6 * s, wa, [200, 205, 210], 0.55);
    }
    // Abdomen with yellow bands, thorax, head and red eyes
    const [ax, ay] = along(-4 * s);
    cv.ellipse(ax, ay, 6 * s, 3.6 * s, a, [70, 45, 25]);
    cv.ellipse(...along(-5 * s), 1.4 * s, 3.2 * s, a, [215, 170, 40], 0.9);
    const [tx, ty] = along(2 * s);
    cv.ellipse(tx, ty, 4.2 * s, 3.4 * s, a, [55, 38, 22]);
    const [hx, hy] = along(6.4 * s);
    cv.ellipse(hx, hy, 2.6 * s, 3 * s, a, [150, 45, 30]);
}

function drawMoth(cv, p) {
    const s = 1.6 * p.scale;
    cv.ellipse(p.x, p.y, 14 * s, 8 * s, p.angle, [120, 98, 72], 0.95);
    cv.ellipse(p.x, p.y, 9 * s, 2.6 * s, p.angle, [70, 55, 40]);
}

/**
 * @returns {{ jpeg: Buffer, insects: Array<{name, confidence, bbox}> }}
 */
function render({ seed, flies, moths = 0 }) {
    const cv = makeCanvas();
    background(cv, seed);
    const spots = layout(seed, flies + moths);
    const r = rng(seed * 7 + 3);
    const insects = [];
    spots.forEach((p, i) => {
        const isMoth = i >= flies;
        if (isMoth) drawMoth(cv, p); else drawFly(cv, p);
        const half = isMoth ? 22 * p.scale : 14 * p.scale;
        insects.push({
            name: isMoth ? 'moth' : 'fruit_fly',
            confidence: Math.round((0.84 + r() * 0.14) * 100) / 100,
            bbox: [Math.round(p.x - half), Math.round(p.y - half), Math.round(p.x + half), Math.round(p.y + half)]
        });
    });
    return { jpeg: jpeg.encode({ data: cv.data, width: W, height: H }, 82).data, insects };
}

function boxes(seed, flies, moths = 0) {
    const spots = layout(seed, flies + moths);
    const r = rng(seed * 7 + 3);
    return spots.map((p, i) => {
        const isMoth = i >= flies;
        const half = isMoth ? 22 * p.scale : 14 * p.scale;
        return {
            name: isMoth ? 'moth' : 'fruit_fly',
            confidence: Math.round((0.84 + r() * 0.14) * 100) / 100,
            bbox: [Math.round(p.x - half), Math.round(p.y - half), Math.round(p.x + half), Math.round(p.y + half)]
        };
    });
}

module.exports = { render, boxes, W, H };
