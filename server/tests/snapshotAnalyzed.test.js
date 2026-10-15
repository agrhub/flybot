const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const axios = require('axios');
const jpeg = require('jpeg-js');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const ezvizService = require('../src/services/ezvizService');
const aiService = require('../src/services/aiService');
const snapshotEvents = require('../src/services/snapshotEvents');
const { captureAndSaveSnapshot, retryFailedAnalyses } = require('../src/cron/captureJob');

before(startDb);
after(stopDb);
beforeEach(clearDb);

// A small real JPEG, so the quality check and the size reader have something to measure
function testJpeg(width = 64, height = 48) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = 60 + ((i * 37) % 140);
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = 40; data[i * 4 + 3] = 255;
    }
    return jpeg.encode({ data, width, height }, 90).data;
}

const original = {
    post: axios.post,
    get: axios.get,
    capture: ezvizService.captureDevice,
    analyze: aiService.analyzeSnapshot
};
let posts;

beforeEach(() => {
    posts = [];
    axios.post = async (url, body, config) => {
        posts.push({ url, body, headers: config.headers });
        return { status: 200 };
    };
});
afterEach(() => {
    axios.post = original.post;
    axios.get = original.get;
    ezvizService.captureDevice = original.capture;
    aiService.analyzeSnapshot = original.analyze;
});

// The AI result each capture gets (stand-in for Vertex/Roboflow)
function fakeAi(result) {
    aiService.analyzeSnapshot = async (base64, snapshotId) => {
        const summary = result.summary;
        await models.Snapshot.findByIdAndUpdate(snapshotId, {
            aiProcessed: true,
            aiProvider: 'roboflow',
            pestCount: models.Snapshot.pestCountOf(summary),
            aiResults: { detected: true, insects: result.insects, summary }
        });
        return true;
    };
}

// The camera answers with a picture link, and the picture downloads
function fakeCamera(buffer) {
    ezvizService.captureDevice = async () => ({ code: '200', data: { picUrl: 'https://ezviz.example.test/pic.jpg' } });
    axios.get = async () => ({ data: buffer });
}

async function waitFor(predicate, ms = 3000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting for webhook deliveries');
        await new Promise(r => setTimeout(r, 20));
    }
}

const analyzedPosts = () => posts.filter(p => p.headers['X-FlyBot-Event'] === 'snapshot_analyzed');

async function hook(owner, events) {
    const res = await json(await request('/api/integrations/webhooks', { method: 'POST', as: owner, body: { url: `https://hooks.example.com/${events.join('-')}`, events } }));
    assert.equal(res.status, 201);
    return res.body.secret;
}

test('snapshot_analyzed is offered in settings and accepted for a webhook', async () => {
    const owner = await createUser({ role: 'manager' });
    const list = await json(await request('/api/integrations/webhooks', { as: owner }));
    assert.ok(list.body.events.includes('snapshot_analyzed'));
    await hook(owner, ['snapshot_analyzed']);
    assert.deepEqual((await models.Webhook.findOne().lean()).events, ['snapshot_analyzed']);
});

test('fires once per captured photo after AI and quality, signed, with the documented fields', async () => {
    const owner = await createUser({ role: 'manager', name: 'Alice Farmer' });
    const viewer = await createUser({ name: 'Victor Viewer' });
    const farmId = new mongoose.Types.ObjectId();
    const plotId = new mongoose.Types.ObjectId();
    const cardReplacedAt = new Date('2026-10-10T00:00:00Z');
    await createCamera(owner, {
        deviceSerial: 'SA1', deviceName: 'Mango Lot A', trapKind: 'sticky', farmId, plotId,
        latitude: 10.5, longitude: 106.7, alertThreshold: 12, cardReplacedAt,
        sharedWith: [{ userId: viewer._id, email: viewer.email }]
    });
    const secret = await hook(owner, ['snapshot_analyzed']);
    await hook(owner, ['camera_offline']);
    // A viewer cannot create one through the API; one left from an earlier role gets nothing
    await models.Webhook.create({ userId: viewer._id, url: 'https://viewer.example.com/in', secret: 'whsec_x', events: ['snapshot_analyzed'] });

    fakeCamera(testJpeg(64, 48));
    fakeAi({ summary: { 'fruit fly': 3, person: 1 }, insects: [
        { name: 'fruit fly', confidence: 0.91, bbox: [1, 2, 10, 12] },
        { name: 'fruit fly', confidence: 0.8, bbox: [20, 5, 30, 15] },
        { name: 'fruit fly', confidence: 0.7, bbox: [40, 30, 50, 40] },
        { name: 'person', confidence: 0.6, bbox: [0, 0, 64, 48] }
    ] });

    const first = await captureAndSaveSnapshot('SA1');
    assert.ok(first);
    await waitFor(() => analyzedPosts().length === 1);
    const second = await captureAndSaveSnapshot('SA1');
    await waitFor(() => analyzedPosts().length === 2);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(analyzedPosts().length, 2, 'once per photo');
    assert.ok(analyzedPosts().every(p => p.url === 'https://hooks.example.com/snapshot_analyzed'), 'only the subscribed owner webhook');

    const [call1, call2] = analyzedPosts();
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${call2.headers['X-FlyBot-Timestamp']}.${call2.body}`).digest('hex')}`;
    assert.equal(call2.headers['X-FlyBot-Signature'], expected);

    const body = JSON.parse(call2.body);
    assert.equal(body.event, 'snapshot_analyzed');
    assert.equal(body.id, `snap_${second._id}`);
    assert.equal(body.deviceSerial, 'SA1');
    assert.equal(body.severity, 'info');
    const p = body.params;
    assert.equal(p.snapshotId, String(second._id));
    assert.equal(p.deviceSerial, 'SA1');
    assert.equal(p.deviceName, 'Mango Lot A');
    assert.equal(p.provider, 'ezviz');
    assert.equal(p.trapKind, 'sticky');
    assert.equal(p.farmId, String(farmId));
    assert.equal(p.plotId, String(plotId));
    assert.equal(p.latitude, 10.5);
    assert.equal(p.longitude, 106.7);
    assert.equal(new Date(p.capturedAt).getTime(), new Date(second.createdAt).getTime());
    assert.match(p.imageUrl, /snapshots\/SA1\/SA1_\d+\.jpg\?/);
    assert.match(p.imageUrl, /X-Amz-Expires=3600/);
    assert.match(p.imageUrl, /X-Amz-Signature=/);
    assert.ok(Math.abs(new Date(p.imageUrlExpiresAt) - Date.now() - 3600 * 1000) < 60 * 1000);
    assert.equal(p.width, 64);
    assert.equal(p.height, 48);
    assert.equal(p.count, 3, 'people are not pests');
    assert.deepEqual(p.counts, { 'fruit fly': 3, person: 1 });
    assert.equal(p.aiSource, 'cloud');
    assert.equal(p.aiProvider, 'roboflow');
    assert.equal(p.boxFormat, 'xyxy_pixels');
    assert.equal(p.boxes.length, 4);
    assert.deepEqual(p.boxes[0], { label: 'fruit fly', confidence: 0.91, bbox: [1, 2, 10, 12] });
    assert.equal(p.boxesTotal, 4);
    assert.equal(p.truncated, false);
    // The quality check ran before the event: its stored result is in the payload
    const stored = await models.Snapshot.findById(second._id).lean();
    assert.ok(stored.quality.checkedAt);
    assert.deepEqual(p.quality, {
        brightness: stored.quality.brightness,
        contrast: stored.quality.contrast,
        sharpness: stored.quality.sharpness,
        clipped: stored.quality.clipped,
        coverage: stored.quality.coverage,
        issues: stored.quality.issues,
        checkedAt: stored.quality.checkedAt.toISOString()
    });
    assert.equal(p.previousSnapshotId, String(first._id));
    assert.equal(JSON.parse(call1.body).params.previousSnapshotId, null, 'first photo of the camera');
    assert.equal(p.cardReplacedAt, cardReplacedAt.toISOString());
    assert.equal(p.alertThreshold, 12);

    // No account data
    for (const call of analyzedPosts()) {
        for (const secretText of [owner.email, viewer.email, 'Alice Farmer', 'Victor Viewer', String(owner._id), String(viewer._id)]) {
            assert.ok(!call.body.includes(secretText), `payload must not contain ${secretText}`);
        }
        assert.ok(!/email/i.test(call.body));
    }
});

test('no AI result: no event; nobody subscribed: nothing is built or sent', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'SA2' });
    fakeCamera(testJpeg());
    aiService.analyzeSnapshot = async () => false;
    await hook(owner, ['snapshot_analyzed']);
    assert.ok(await captureAndSaveSnapshot('SA2'));
    await new Promise(r => setTimeout(r, 150));
    assert.equal(analyzedPosts().length, 0, 'AI failed: the retry path sends it later');

    await models.Webhook.deleteMany({});
    const snap = await models.Snapshot.create({ deviceSerial: 'SA2', imageUrl: '/x', s3Key: 'snapshots/SA2/x.jpg', aiProcessed: true, aiResults: { summary: { 'fruit fly': 1 } } });
    assert.equal(await snapshotEvents.emitAnalyzed(snap._id), 0);
    assert.equal(posts.length, 0);
});

test('retry path: sent when the late analysis succeeds; previousSnapshotId is by capture time', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'SA3', trapKind: 'lure' });
    await hook(owner, ['snapshot_analyzed']);
    const now = new Date();
    const ago = (min) => new Date(now.getTime() - min * 60 * 1000);
    const older = await models.Snapshot.create({ deviceSerial: 'SA3', imageUrl: '/a', s3Key: 'snapshots/SA3/a.jpg', createdAt: ago(60), aiProcessed: true, aiResults: { summary: { 'fruit fly': 2 } } });
    // Not analyzed: never anyone's "previous"
    await models.Snapshot.create({ deviceSerial: 'SA3', imageUrl: '/b', s3Key: 'snapshots/SA3/b.jpg', createdAt: ago(45), aiProcessed: false, aiRetries: 3 });
    const failed = await models.Snapshot.create({
        deviceSerial: 'SA3', imageUrl: '/c', s3Key: 'snapshots/SA3/c.jpg', createdAt: ago(30), aiProcessed: false,
        quality: { brightness: 120, contrast: 40, sharpness: 300, clipped: 0, coverage: 0, issues: ['blurry'], checkedAt: ago(30) }
    });
    // Analyzed and newer than the retried photo
    await models.Snapshot.create({ deviceSerial: 'SA3', imageUrl: '/d', s3Key: 'snapshots/SA3/d.jpg', createdAt: ago(15), aiProcessed: true, aiResults: { summary: { 'fruit fly': 4 } } });

    fakeAi({ summary: { 'fruit fly': 5 }, insects: [] });
    const result = await retryFailedAnalyses(now);
    assert.deepEqual(result, { retried: 1, succeeded: 1 });
    await waitFor(() => analyzedPosts().length === 1);
    const p = JSON.parse(analyzedPosts()[0].body).params;
    assert.equal(p.snapshotId, String(failed._id));
    assert.equal(p.previousSnapshotId, String(older._id));
    assert.equal(p.trapKind, 'lure');
    assert.equal(p.count, 5);
    assert.deepEqual(p.quality.issues, ['blurry']);
    assert.equal(p.quality.sharpness, 300);
    // The S3 stub returns bytes that are not an image: the size is unknown, not made up
    assert.equal(p.width, null);
    assert.equal(p.height, null);
    assert.deepEqual(p.boxes, []);
    assert.equal(p.truncated, false);
});

test('boxes are capped at 200, highest confidence kept, with truncated set', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'SA4' });
    const insects = Array.from({ length: 250 }, (_, i) => ({ name: 'fruit fly', confidence: Math.round((i / 250) * 1000) / 1000, bbox: [i, i, i + 5, i + 5] }));
    const snap = await models.Snapshot.create({ deviceSerial: 'SA4', imageUrl: '/x', s3Key: 'snapshots/SA4/x.jpg', aiProcessed: true, pestCount: 250, aiResults: { detected: true, insects, summary: { 'fruit fly': 250 } } });
    const payload = await snapshotEvents.buildPayload(await models.Snapshot.findById(snap._id).lean());
    const p = payload.params;
    assert.equal(p.boxes.length, 200);
    assert.equal(p.boxesTotal, 250);
    assert.equal(p.truncated, true);
    assert.equal(p.count, 250, 'the count is the full count');
    assert.equal(Math.min(...p.boxes.map(b => b.confidence)), insects[50].confidence);
    assert.equal(p.quality, null, 'not checked yet');
    assert.ok(JSON.stringify(payload).length < 64 * 1024);
});

test('photos counted on the camera (CamOS): aiSource device, provider camos', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'SA5' });
    await hook(owner, ['snapshot_analyzed']);
    const snap = await models.Snapshot.create({
        deviceSerial: 'SA5', imageUrl: '/x', s3Key: 'snapshots/SA5/x.jpg', aiProcessed: true, aiProvider: 'device',
        aiResults: { detected: true, insects: [{ name: 'fruit fly', confidence: 0.9, bbox: [10, 10, 20, 20] }], summary: { 'fruit fly': 7 } },
        quality: { brightness: 100, contrast: 30, sharpness: 200, clipped: 0, coverage: 0.01, issues: [], checkedAt: new Date() }
    });
    assert.equal(await snapshotEvents.emitAnalyzed(snap._id, { buffer: testJpeg(320, 240) }), 1);
    const p = JSON.parse(analyzedPosts()[0].body).params;
    assert.equal(p.aiSource, 'device');
    assert.equal(p.aiProvider, 'device');
    assert.equal(p.provider, 'camos');
    assert.equal(p.count, 7);
    assert.equal(p.width, 320);
    assert.equal(p.height, 240);
});
