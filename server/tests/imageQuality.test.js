const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jpeg = require('jpeg-js');
const { models, sentMails, startDb, stopDb, clearDb, createUser, createCamera, request, json } = require('./dbHelpers');
const { grayscale, metricsOf, coverageOf, assess, checkSnapshot, thumbnailOf, changeOf, jpegSize } = require('../src/services/imageQuality');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const W = 640;
const H = 480;

// A yellow sticky card with dark "insects" on a grid; `blur` smears it, `haze` washes it out
function photo({ blur = 0, haze = 0, light = 1 } = {}) {
    const lum = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const fly = (x % 40 < 8) && (y % 40 < 8);
            const line = x % 80 === 0 || y % 60 === 0;
            lum[y * W + x] = fly || line ? 40 : 210;
        }
    }
    let img = lum;
    for (let pass = 0; pass < blur; pass++) {
        const out = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let sum = 0;
                let n = 0;
                for (let d = -3; d <= 3; d++) {
                    const xx = Math.min(W - 1, Math.max(0, x + d));
                    const yy = Math.min(H - 1, Math.max(0, y + d));
                    sum += img[y * W + xx] + img[yy * W + x];
                    n += 2;
                }
                out[y * W + x] = sum / n;
            }
        }
        img = out;
    }
    const data = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const v = Math.max(0, Math.min(255, (img[i] * (1 - haze) + 160 * haze) * light));
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = Math.max(0, v - 120);
        data[i * 4 + 3] = 255;
    }
    return jpeg.encode({ data, width: W, height: H }, 90).data;
}

const metrics = (buffer) => metricsOf(grayscale(buffer));

test('measures: sharp vs blurred vs dark vs hazy', () => {
    const sharp = metrics(photo());
    const blurred = metrics(photo({ blur: 3 }));
    const dark = metrics(photo({ light: 0.1 }));
    const hazy = metrics(photo({ haze: 0.7 }));
    assert.ok(blurred.sharpness < sharp.sharpness * 0.35, `${blurred.sharpness} vs ${sharp.sharpness}`);
    assert.ok(dark.brightness < 35);
    assert.ok(hazy.contrast < sharp.contrast * 0.5);
    assert.equal(grayscale(Buffer.from('not a jpeg')), null);
});

test('assess against the camera\'s own baseline', () => {
    const baseline = metrics(photo());
    assert.deepEqual(assess({ ...baseline, coverage: 0.02 }, baseline), []);
    assert.deepEqual(assess({ ...metrics(photo({ blur: 3 })), coverage: null }, baseline), ['blurry']);
    assert.deepEqual(assess({ ...metrics(photo({ haze: 0.7 })), coverage: null }, baseline), ['low_contrast']);
    assert.deepEqual(assess({ ...metrics(photo({ light: 0.1 })), coverage: null }, baseline), ['dark']);
    // No baseline yet: only the absolute checks
    assert.deepEqual(assess({ ...metrics(photo({ blur: 3 })), coverage: null }, null), []);
    assert.deepEqual(assess({ ...baseline, coverage: 0.3 }, baseline), ['card_full']);
    assert.deepEqual(assess({ ...baseline, coverage: null }, baseline, 320), ['card_full']);
});

test('a camera whose every photo is out of focus is blurry whatever its baseline', () => {
    // Measured on the field: a focused EZVIZ trap and an out-of-focus OV5640 board (its own baseline is as soft)
    const ezviz = { brightness: 124, contrast: 47, sharpness: 433, clipped: 0, coverage: null };
    const soft = { brightness: 159, contrast: 52, sharpness: 33, clipped: 0.01, coverage: null };
    assert.deepEqual(assess(ezviz, null), []);
    assert.deepEqual(assess(soft, null), ['blurry']);
    assert.deepEqual(assess(soft, soft), ['blurry']);
    // Too little contrast for the ratio to say anything (a blank card)
    assert.deepEqual(assess({ ...soft, contrast: 6, sharpness: 0.5 }, null), []);
});

test('coverage from pixel boxes; unknown when boxes are in another scale', () => {
    assert.equal(coverageOf([{ bbox: [0, 0, 64, 48] }, { bbox: [100, 100, 164, 148] }], 640, 480), 0.02);
    assert.equal(coverageOf([{ bbox: [0, 0, 900, 900] }], 640, 480), null);
    assert.equal(coverageOf([], 640, 480), 0);
});

test('a snapshot is checked, stored on the camera, and a repeated problem alerts', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'Q1', deviceName: 'Trap Q' });
    const snap = (extra = {}) => models.Snapshot.create({ deviceSerial: 'Q1', imageUrl: 'x', s3Key: 'x', aiProcessed: true, ...extra });

    // Baseline: five good photos
    for (let i = 0; i < 5; i++) {
        const s = await snap({ createdAt: new Date(Date.now() - (10 - i) * 60000) });
        const q = await checkSnapshot(s, photo());
        assert.deepEqual(q.issues, []);
    }
    const first = await snap({ createdAt: new Date(Date.now() - 2 * 60000) });
    assert.deepEqual((await checkSnapshot(first, photo({ blur: 3 }))).issues, ['blurry']);
    assert.equal(await models.Notification.countDocuments({ type: 'image_quality' }), 0, 'one bad photo is not enough');

    const second = await snap();
    await checkSnapshot(second, photo({ blur: 3 }));
    const alerts = await models.Notification.find({ type: 'image_quality' }).lean();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].params.issue, 'blurry');
    assert.match(sentMails.at(-1).subject, /Trap Q: (bị mờ|blurry)/);

    const stored = await models.Snapshot.findById(second._id).lean();
    assert.deepEqual(stored.quality.issues, ['blurry']);
    const health = await json(await request('/api/user/cameras/health', { as: owner }));
    assert.deepEqual(health.body.health.find(h => h.deviceSerial === 'Q1').imageIssues, ['blurry']);
});

test('change: the same scene is about 0, an object in front is most of the frame, a brightness shift is ignored', () => {
    const base = thumbnailOf(grayscale(photo()));
    assert.equal(base.length, 1200);
    assert.equal(changeOf(base, null), null, 'no previous photo');
    assert.equal(changeOf(thumbnailOf(grayscale(photo())), base), 0);
    assert.ok(changeOf(thumbnailOf(grayscale(photo({ light: 0.85 }))), base) < 50, 'darker light, same scene');
    // Something covering the left two thirds
    const covered = Uint8Array.from(base, (v, i) => (i % 40 < 27 ? 20 : v));
    assert.ok(changeOf(covered, base) > 500, String(changeOf(covered, base)));
    assert.deepEqual(jpegSize(photo()), { width: 640, height: 480 });
    assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
});

test('a CamOS photo with meta.quality is not decoded; other photos get change from the previous thumbnail', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ESPQ', platform: 'camos', trapKind: 'lure' });
    await createCamera(owner, { deviceSerial: 'EZQ' });
    // The camera's numbers win: a blurry reading on a sharp picture is what gets stored
    const cam = await models.Snapshot.create({ deviceSerial: 'ESPQ', imageUrl: 'x', s3Key: 'x', meta: { quality: { brightness: 190, contrast: 24.2, sharpness: 9, edgeRatio: 0.015, clipped: 0, change: 3 } } });
    const q = await checkSnapshot(cam, photo());
    assert.equal(q.source, 'camera');
    assert.equal(q.sharpness, 9);
    assert.equal(q.change, 3);
    assert.deepEqual(q.issues, ['blurry']);

    const first = await checkSnapshot(await models.Snapshot.create({ deviceSerial: 'EZQ', imageUrl: 'x', s3Key: 'x' }), photo());
    assert.equal(first.source, 'server');
    assert.equal(first.change, undefined, 'first photo: nothing to compare with');
    const second = await checkSnapshot(await models.Snapshot.create({ deviceSerial: 'EZQ', imageUrl: 'x', s3Key: 'x' }), photo());
    assert.equal(second.change, 0);
    // The thumbnail stays on the server
    const list = await json(await request('/api/user/cameras', { as: owner }));
    assert.ok(!JSON.stringify(list.body).includes('qualityThumb'));
});
