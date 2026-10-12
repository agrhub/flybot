// CamOS cameras: a fake CamOS Open API on localhost stands in for the real platform.
// Set before config/env is loaded (dotenv never overrides variables already set).
const FAKE_CAMOS_PORT = 47391;
process.env.CAMOS_API_URL = `http://127.0.0.1:${FAKE_CAMOS_PORT}/openapi/v1`;
process.env.CAMOS_APP_ID = 'app_test';
process.env.CAMOS_SECRET_KEY = 'sk_test';
process.env.CAMOS_WEBHOOK_SECRET = 'whsec_test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { models, startDb, stopDb, clearDb, request, json, createUser, createCamera } = require('./dbHelpers');
const aiService = require('../src/services/aiService');
const notificationService = require('../src/services/notificationService');
const camosService = require('../src/services/camosService');
const camosWebhook = require('../src/services/camosWebhook');
const { captureAndSaveSnapshot } = require('../src/cron/captureJob');

// ---------- Fake CamOS ----------

const fake = {
    calls: [],
    tokens: 0,
    // Tokens the fake accepts; clearing it makes the next call answer 401
    validTokens: new Set(),
    routes: new Map()
};
const IMAGE = Buffer.from('JPEGDATA');
const imageUrl = (name = 'snap.jpg') => `http://127.0.0.1:${FAKE_CAMOS_PORT}/files/${name}`;

function resetFake() {
    fake.calls.length = 0;
    fake.routes = new Map([
        ['POST /openapi/v1/devices/activate', (body) => {
            if (body.verifyCode !== 'GOOD01') return [400, { error: { code: 'VERIFY_CODE_INVALID', message: 'Wrong code' } }];
            if (body.serial === 'TAKEN1') return [409, { error: { code: 'ALREADY_ACTIVATED', message: 'Other tenant' } }];
            return [200, { data: { serial: body.serial, model: 'AIC-AMB82-K306P', status: 'activated', online: false, provisionToken: `pt_${fake.calls.length}`, provisionExpiresAt: 1760256600000, mqttHost: 'mqtt.camos.test' } }];
        }],
        ['POST /openapi/v1/devices/AIC1/capture', () => [200, { data: { imageUrl: imageUrl(), expiresAt: Date.now() + 3600000 } }]],
        ['POST /openapi/v1/devices/AIC1/live', () => [200, { data: { streamId: `s${fake.calls.length}`, playToken: 'play_1', webrtc: { websocketUrl: 'wss://ams.test/websocket', streamId: 'AIC1' }, hls: { url: 'https://ams.test/AIC1.m3u8' }, expiresAt: Date.now() + 600000 } }]]
    ]);
}

const fakeServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        const path = req.url.split('?')[0];
        if (path.startsWith('/files/')) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            return res.end(IMAGE);
        }
        const body = raw ? JSON.parse(raw) : {};
        const send = (status, payload) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        if (path === '/openapi/v1/token') {
            if (body.appId !== 'app_test' || body.secretKey !== 'sk_test') return send(401, { error: { code: 'UNAUTHORIZED' } });
            const token = `at_${++fake.tokens}`;
            fake.validTokens.add(token);
            return send(200, { data: { accessToken: token, expiresAt: Date.now() + 7 * 24 * 3600000 } });
        }
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!fake.validTokens.has(token)) return send(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired' } });
        const key = `${req.method} ${path}`;
        fake.calls.push({ key, body });
        const handler = fake.routes.get(key);
        if (!handler) return send(200, { data: {} });
        const [status, payload] = handler(body);
        send(status, payload);
    });
});

before(async () => {
    await new Promise(resolve => fakeServer.listen(FAKE_CAMOS_PORT, '127.0.0.1', resolve));
    await startDb();
});
after(async () => {
    await stopDb();
    await new Promise(resolve => fakeServer.close(resolve));
});
beforeEach(async () => {
    await clearDb();
    resetFake();
});

// The AI is not called for photos the camera counted; for the others it is stubbed
async function withStubbedAi(fn) {
    const original = aiService.analyzeSnapshot;
    const seen = [];
    aiService.analyzeSnapshot = async (base64, id, url) => {
        seen.push({ id: String(id), url });
        await models.Snapshot.updateOne({ _id: id }, { $set: { aiProcessed: true, aiProvider: 'roboflow', pestCount: 3, aiResults: { summary: { fruit_fly: 3 } } } });
        return true;
    };
    try {
        return await fn(seen);
    } finally {
        aiService.analyzeSnapshot = original;
    }
}

function signedWebhook(event, { secret = 'whsec_test', timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const raw = JSON.stringify(event);
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    return {
        method: 'POST',
        body: Buffer.from(raw),
        headers: { 'Content-Type': 'application/json', 'X-CamOS-Timestamp': String(timestamp), 'X-CamOS-Signature': signature, 'X-CamOS-Event': event.event }
    };
}

const detection = (overrides = {}) => ({
    id: '01JA2Z8Q4M7Y3V6N8K2D5F1H9C',
    event: 'app_detection',
    ts: Date.now() - 60 * 1000,
    serial: 'AIC1',
    data: {
        detectionId: 'trap-count', app: 'fruit-fly-sticky', model: 'yolo11n-fruitfly-v3',
        n: 37, truncated: true, labels: ['fruit_fly'],
        boxes: [[0.1, 0.2, 0.15, 0.25, 0, 0.91], [0.5, 0.5, 0.52, 0.53, 0, 0.8]],
        image: { url: imageUrl(), w: 2560, h: 1440 }
    },
    ...overrides
});

// ---------- Open API client ----------

test('the CamOS token is fetched once, and renewed when CamOS refuses it', async () => {
    await camosService.getDevice('AIC1');
    await camosService.getDevice('AIC1');
    assert.equal(fake.tokens, 1);

    fake.validTokens.clear();
    await camosService.getDevice('AIC1');
    assert.equal(fake.tokens, 2, 'a 401 gets a new token and the call is made again');
    assert.equal(fake.calls.filter(c => c.key === 'GET /openapi/v1/devices/AIC1').length, 3);
});

test('CamOS errors keep their code and status', async () => {
    await assert.rejects(
        camosService.activateDevice({ serial: 'AIC9', verifyCode: 'WRONG' }),
        (err) => err.name === 'CamosError' && err.code === 'VERIFY_CODE_INVALID' && err.status === 400
    );
});

// ---------- Adding and removing a camera ----------

test('adding an AI camera activates it on CamOS and returns the network setup token', async () => {
    const owner = await createUser({ role: 'manager' });
    const res = await json(await request('/api/user/add-camera', {
        method: 'POST', as: owner,
        body: { provider: 'camos', deviceSerial: 'AIC1', validateCode: 'GOOD01', deviceName: 'Lot A trap 3', trapKind: 'sticky' }
    }));
    assert.equal(res.status, 200);
    assert.equal(res.body.camera.provider, 'camos');
    assert.equal(res.body.camera.deviceName, 'Lot A trap 3');
    assert.match(res.body.provision.token, /^pt_/);
    assert.equal(res.body.provision.mqttHost, 'mqtt.camos.test');
    assert.deepEqual(fake.calls[0], { key: 'POST /openapi/v1/devices/activate', body: { serial: 'AIC1', verifyCode: 'GOOD01', name: 'Lot A trap 3' } });

    const camera = await models.Camera.findOne({ deviceSerial: 'AIC1' }).lean();
    assert.equal(camera.provider, 'camos');
    assert.equal(camera.model, 'AIC-AMB82-K306P');

    // Again (to set up the Wi-Fi again): a fresh token, still one camera
    const again = await json(await request('/api/user/add-camera', {
        method: 'POST', as: owner, body: { provider: 'camos', deviceSerial: 'AIC1', validateCode: 'GOOD01' }
    }));
    assert.equal(again.status, 200);
    assert.notEqual(again.body.provision.token, res.body.provision.token);
    assert.equal(await models.Camera.countDocuments({ deviceSerial: 'AIC1' }), 1);
});

test('a wrong code, or a camera of another CamOS app, is refused', async () => {
    const owner = await createUser({ role: 'manager' });
    const wrong = await json(await request('/api/user/add-camera', {
        method: 'POST', as: owner, body: { provider: 'camos', deviceSerial: 'AIC1', validateCode: 'NOPE00' }
    }));
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.message, 'Invalid serial number or verification code.');

    const taken = await json(await request('/api/user/add-camera', {
        method: 'POST', as: owner, body: { provider: 'camos', deviceSerial: 'TAKEN1', validateCode: 'GOOD01' }
    }));
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'CAMERA_TAKEN');
    assert.equal(await models.Camera.countDocuments({}), 0);

    const badProvider = await json(await request('/api/user/add-camera', {
        method: 'POST', as: owner, body: { provider: 'other', deviceSerial: 'AIC1', validateCode: 'GOOD01' }
    }));
    assert.equal(badProvider.status, 400);
});

test('removing an AI camera gives it back to CamOS', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos' });
    const res = await request('/api/user/delete-camera', { method: 'DELETE', as: owner, body: { deviceSerial: 'AIC1' } });
    assert.equal(res.status, 200);
    // Sent after the answer
    for (let i = 0; i < 50 && !fake.calls.length; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(fake.calls.map(c => c.key), ['POST /openapi/v1/devices/AIC1/deactivate']);
});

// ---------- Capture and live ----------

test('a scheduled capture of an AI camera goes through CamOS and FlyBot\'s AI', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos' });
    await withStubbedAi(async (seen) => {
        const saved = await captureAndSaveSnapshot('AIC1');
        assert.ok(saved);
        assert.deepEqual(fake.calls.map(c => c.key), ['POST /openapi/v1/devices/AIC1/capture']);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, imageUrl(), 'Roboflow can fetch the photo from CamOS');
        const snap = await models.Snapshot.findById(saved._id).lean();
        assert.equal(snap.aiProvider, 'roboflow');
        assert.equal(snap.pestCount, 3);
    });
});

test('an offline AI camera gives no photo', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos' });
    fake.routes.set('POST /openapi/v1/devices/AIC1/capture', () => [409, { error: { code: 'DEVICE_OFFLINE' } }]);
    assert.equal(await captureAndSaveSnapshot('AIC1'), null);
    assert.equal(await models.Snapshot.countDocuments({}), 0);
});

test('live view of an AI camera returns the CamOS player data and closes the viewer\'s previous stream', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos' });
    const first = await json(await request('/api/live', { method: 'POST', as: owner, body: { deviceSerial: 'AIC1' } }));
    assert.equal(first.status, 200);
    assert.equal(first.body.data.provider, 'camos');
    assert.equal(first.body.data.playToken, 'play_1');
    const streamId = first.body.data.streamId;

    await request('/api/live', { method: 'POST', as: owner, body: { deviceSerial: 'AIC1' } });
    assert.ok(fake.calls.some(c => c.key === `DELETE /openapi/v1/devices/AIC1/live/${streamId}`));

    fake.routes.set('POST /openapi/v1/devices/AIC1/live', () => [409, { error: { code: 'DEVICE_OFFLINE' } }]);
    const offline = await json(await request('/api/live', { method: 'POST', as: owner, body: { deviceSerial: 'AIC1' } }));
    assert.equal(offline.status, 409);
    assert.equal(offline.body.msg, 'The camera is offline.');
});

// ---------- Webhook ----------

test('webhook signatures: wrong secret, old timestamp and missing signature are refused', async () => {
    for (const init of [
        signedWebhook(detection(), { secret: 'whsec_other' }),
        signedWebhook(detection(), { timestamp: Math.floor(Date.now() / 1000) - 600 }),
        { ...signedWebhook(detection()), headers: { 'Content-Type': 'application/json' } }
    ]) {
        const res = await request('/api/camos/webhook', init);
        assert.equal(res.status, 401);
    }
});

test('a detection on the camera is stored in the history once, with the camera\'s count', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos' });
    const event = detection();
    await withStubbedAi(async (seen) => {
        const first = await json(await request('/api/camos/webhook', signedWebhook(event)));
        assert.equal(first.status, 200);
        assert.equal(first.body.result, 'stored');
        const again = await json(await request('/api/camos/webhook', signedWebhook(event)));
        assert.equal(again.body.result, 'duplicate');
        assert.equal(seen.length, 0, 'the camera counted: no AI call');
    });

    const snaps = await models.Snapshot.find({ deviceSerial: 'AIC1' }).lean();
    assert.equal(snaps.length, 1);
    const snap = snaps[0];
    assert.equal(snap.aiProvider, 'device');
    assert.equal(snap.aiProcessed, true);
    assert.equal(snap.deviceEventId, event.id);
    assert.equal(snap.pestCount, 37, 'the real count, not only the boxes sent');
    assert.equal(snap.createdAt.getTime(), event.ts);
    assert.deepEqual(snap.aiResults.insects[0].bbox, [256, 288, 384, 360], 'boxes in pixels');
});

test('status events update the camera and alert on a change', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos', status: 1 });
    const original = notificationService.cameraStatusChanged;
    const alerts = [];
    notificationService.cameraStatusChanged = async (serial, status) => { alerts.push([serial, status]); };
    try {
        const offline = { id: '01JA2Z8Q4M7Y3V6N8K2D5F1H9D', event: 'device.offline', ts: Date.now(), serial: 'AIC1', data: {} };
        assert.equal((await request('/api/camos/webhook', signedWebhook(offline))).status, 200);
        assert.equal((await request('/api/camos/webhook', signedWebhook({ ...offline, id: '01JA2Z8Q4M7Y3V6N8K2D5F1H9E' }))).status, 200);
        assert.equal((await models.Camera.findOne({ deviceSerial: 'AIC1' }).lean()).status, 0);
        assert.deepEqual(alerts, [['AIC1', 0]], 'one alert for one change');
    } finally {
        notificationService.cameraStatusChanged = original;
    }
});

test('events for unknown or EZVIZ cameras, and photos FlyBot asked for, are ignored', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'EZ1' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos' });
    const results = [];
    for (const event of [
        detection({ serial: 'NOPE1' }),
        detection({ serial: 'EZ1', id: '01JA2Z8Q4M7Y3V6N8K2D5F1H9F' }),
        { id: '01JA2Z8Q4M7Y3V6N8K2D5F1H9G', event: 'capture', ts: Date.now(), serial: 'AIC1', data: { trigger: 'rpc', image: { url: imageUrl() } } }
    ]) {
        results.push((await json(await request('/api/camos/webhook', signedWebhook(event)))).body.result);
    }
    assert.deepEqual(results, ['ignored', 'ignored', 'ignored']);
    assert.equal(await models.Snapshot.countDocuments({}), 0);
});

test('a detection delivered late keeps its time and raises no alert', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AIC1', provider: 'camos' });
    await models.Snapshot.create({ deviceSerial: 'AIC1', imageUrl: 'x', s3Key: 'k', aiProcessed: true, aiResults: { summary: { fruit_fly: 1 } } });
    const original = notificationService.checkPestThreshold;
    let checked = 0;
    notificationService.checkPestThreshold = async () => { checked++; };
    try {
        const late = detection({ ts: Date.now() - 6 * 3600 * 1000 });
        assert.equal((await json(await request('/api/camos/webhook', signedWebhook(late)))).body.result, 'stored');
        assert.equal(checked, 0);
    } finally {
        notificationService.checkPestThreshold = original;
    }
});

test('camera boxes become FlyBot results; several labels are counted per label', () => {
    const single = camosWebhook.toAiResults({ n: 5, labels: ['ruoi_vang'], boxes: [[0, 0, 0.5, 0.5, 0, 0.9]] }, { width: 100, height: 200 });
    assert.deepEqual(single.summary, { fruit_fly: 5 });
    assert.deepEqual(single.insects[0], { name: 'fruit_fly', confidence: 0.9, bbox: [0, 0, 50, 100] });

    const several = camosWebhook.toAiResults({ n: 3, labels: ['person', 'dog'], boxes: [[0, 0, 1, 1, 0, 0.7], [0, 0, 1, 1, 1, 0.6], [0, 0, 1, 1, 0, 0.5]] }, { width: 10, height: 10 });
    assert.deepEqual(several.summary, { person: 2, dog: 1 });
});
