const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IOT_ENDPOINT = 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com';
process.env.IOT_RULE_SECRET = 'rule-secret-'.padEnd(40, 'r');
process.env.DEVICE_API_BASE_URL = 'https://flybot.example.test';
process.env.DEVICE_OTA_FW = '0.2.0';
process.env.DEVICE_OTA_URL = 'https://flybot.example.test/fw/0.2.0.bin';
process.env.DEVICE_OTA_SHA256 = 'a'.repeat(64);

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const aiService = require('../src/services/aiService');
// No cloud model in these tests: the photos are stored without an AI result
aiService.analyzeSnapshot = async () => false;
const deviceService = require('../src/services/deviceService');
const { parseMultipart } = require('../src/utils/multipart');
const aws = require('../src/platforms/aws');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const JPEG = (size = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7), Buffer.from([0xff, 0xd9])]);
/** A real (decodable) JPEG, for the photo that goes through the quality check. */
function realJpeg(width = 64, height = 48) {
    const jpeg = require('jpeg-js');
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = 60 + ((i * 37) % 140);
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    return jpeg.encode({ data, width, height }, 80).data;
}

/** A multipart body like the ESP32 sends: part image (image/jpeg) and part meta (application/json). */
function multipart(image, meta, { boundary = 'ESP32Boundary7MA4YWxkTrZu0gW', imageType = 'image/jpeg' } = {}) {
    const parts = [];
    if (image) parts.push(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="snap.jpg"\r\nContent-Type: ${imageType}\r\n\r\n`), image, Buffer.from('\r\n')]));
    if (meta !== undefined) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${typeof meta === 'string' ? meta : JSON.stringify(meta)}\r\n`));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

async function pairedCamera(owner, serial = 'ESP32S3-0001') {
    const camera = await createCamera(owner, { deviceSerial: serial, platform: 'camos', validateCode: 'K7P4QX', deviceName: 'Trap ESP' });
    const { provisionToken } = await deviceService.issueProvisionToken(camera);
    const res = await json(await request('/api/device/pair', { method: 'POST', body: { serial, verifyCode: 'k7p4qx', provisionToken } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { camera, token: res.body.deviceToken, pair: res.body };
}
const deviceHeaders = (serial, token, extra = {}) => ({ 'X-Device-Serial': serial, 'X-Device-Token': token, ...extra });

test('multipart parser: two parts, binary data kept byte for byte', () => {
    const image = JPEG(100);
    const { body, headers } = multipart(image, { v: 1 });
    const parts = parseMultipart(body, headers['Content-Type']);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].name, 'image');
    assert.equal(parts[0].filename, 'snap.jpg');
    assert.equal(parts[0].contentType, 'image/jpeg');
    assert.ok(parts[0].data.equals(image));
    assert.equal(parts[1].name, 'meta');
    assert.equal(parts[1].data.toString(), '{"v":1}');
    assert.throws(() => parseMultipart(body, 'multipart/form-data'), /boundary/);
    assert.throws(() => parseMultipart(Buffer.from('nothing'), headers['Content-Type']), /boundary/);
});

test('pair: the camera gets its own token once; the token is stored hashed; wrong code or stale token = 401', async () => {
    const owner = await createUser({ role: 'manager' });
    const camera = await createCamera(owner, { deviceSerial: 'ESP32S3-0001', platform: 'camos', validateCode: 'K7P4QX' });
    const issued = await deviceService.issueProvisionToken(camera);
    assert.match(issued.pairUrl, /^https:\/\/flybot\.example\.test\/api\/device\/pair$/);
    const stored = await models.Camera.findOne({ deviceSerial: 'ESP32S3-0001' }).lean();
    assert.equal(stored.device.provisionTokenHash, deviceService.sha256(issued.provisionToken));
    assert.ok(!JSON.stringify(stored).includes(issued.provisionToken), 'the token itself is never stored');

    const bad = await json(await request('/api/device/pair', { method: 'POST', body: { serial: 'ESP32S3-0001', verifyCode: 'WRONG', provisionToken: issued.provisionToken } }));
    assert.equal(bad.status, 401);
    assert.equal((await json(await request('/api/device/pair', { method: 'POST', body: { serial: 'ESP32S3-0001', verifyCode: 'K7P4QX', provisionToken: 'x'.repeat(20) } }))).status, 401);
    assert.equal((await json(await request('/api/device/pair', { method: 'POST', body: { serial: 'ESP32S3-0001' } }))).status, 400);

    const res = await json(await request('/api/device/pair', { method: 'POST', body: { serial: 'ESP32S3-0001', verifyCode: 'K7P4QX', provisionToken: issued.provisionToken } }));
    assert.equal(res.status, 200);
    assert.match(res.body.deviceToken, /^[A-Za-z0-9_-]{32,}$/);
    assert.deepEqual(res.body.iot, { endpoint: 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com', thingName: 'ESP32S3-0001' });
    assert.deepEqual(res.body.kvs, { region: 'ap-southeast-2', channelName: 'cam-ESP32S3-0001' });
    const paired = await models.Camera.findOne({ deviceSerial: 'ESP32S3-0001' }).lean();
    assert.equal(paired.device.tokenHash, deviceService.sha256(res.body.deviceToken));
    assert.equal(paired.device.provisionTokenHash, undefined, 'provisioning token used up');
    assert.ok(paired.device.pairedAt);
    // Used up: the same provisioning token does not pair again
    assert.equal((await json(await request('/api/device/pair', { method: 'POST', body: { serial: 'ESP32S3-0001', verifyCode: 'K7P4QX', provisionToken: issued.provisionToken } }))).status, 401);
    // An EZVIZ camera never pairs
    const ez = await createCamera(owner, { deviceSerial: 'EZ1', validateCode: 'ABCDEF' });
    assert.equal((await json(await request('/api/device/pair', { method: 'POST', body: { serial: 'EZ1', verifyCode: 'ABCDEF', provisionToken: 'y'.repeat(20) } }))).status, 401);
    assert.equal(ez.platform, 'ezviz');
});

test('snapshot: the photo enters the snapshot pipeline with the camera meta; limits 2 MB, JPEG only, token required', async () => {
    const owner = await createUser({ role: 'manager' });
    const { token } = await pairedCamera(owner);
    const headers = deviceHeaders('ESP32S3-0001', token);

    const image = realJpeg(160, 120);
    const capturedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const meta = { v: 1, serial: 'ESP32S3-0001', capturedAt, trigger: 'schedule', battery: { mv: 3900, pct: 72, charging: true }, net: '4g', rssi: -61, location: { lat: 10.97, lng: 106.49, fixAt: capturedAt }, fw: '0.1.0' };
    const { body, headers: mp } = multipart(image, meta);
    const res = await json(await request('/api/device/snapshot', { method: 'POST', body, headers: { ...headers, ...mp } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.ok(new Date(res.body.nextWakeAt) > new Date());
    const snap = await models.Snapshot.findById(res.body.snapshotId).lean();
    assert.equal(snap.deviceSerial, 'ESP32S3-0001');
    assert.equal(snap.trigger, 'schedule');
    assert.equal(snap.createdAt.toISOString(), capturedAt);
    assert.match(snap.s3Key, /^snapshots\/ESP32S3-0001\//);
    assert.equal(snap.meta.battery.pct, 72);
    assert.equal(snap.meta.net, '4g');
    assert.equal(snap.meta.fw, '0.1.0');
    const cam = await models.Camera.findOne({ deviceSerial: 'ESP32S3-0001' }).lean();
    assert.equal(cam.status, 1);
    assert.equal(cam.device.fw, '0.1.0');
    assert.equal(cam.device.rssi, -61);
    assert.deepEqual(cam.device.battery, { mv: 3900, pct: 72, charging: true });
    assert.equal(cam.device.location.lat, 10.97);
    assert.equal(cam.latitude, 10.97, 'the camera gets its position from the first fix');
    assert.equal(cam.thumbnailUrl, snap.imageUrl);
    assert.ok(cam.lastCaptureAt);
    // The background processing ran: the quality check stored its result
    let done;
    for (let i = 0; i < 50 && !done?.quality?.checkedAt; i++) {
        await new Promise(r => setTimeout(r, 100));
        done = await models.Snapshot.findById(res.body.snapshotId).lean();
    }
    assert.ok(done.quality?.checkedAt, 'quality check ran in the background');

    // Without meta is fine too; a far-off camera clock does not move the photo
    const r2 = await json(await request('/api/device/snapshot', { method: 'POST', ...multipart(JPEG(512)), headers: { ...headers, ...multipart(JPEG(512)).headers } }));
    assert.equal(r2.status, 200);
    const r3body = multipart(JPEG(512), { capturedAt: '2000-01-01T00:00:00Z' });
    const r3 = await json(await request('/api/device/snapshot', { method: 'POST', body: r3body.body, headers: { ...headers, ...r3body.headers } }));
    assert.ok(new Date((await models.Snapshot.findById(r3.body.snapshotId).lean()).createdAt) > new Date('2026-01-01'));

    // Limits and errors
    const big = multipart(JPEG(2 * 1024 * 1024 + 10), { v: 1 });
    assert.equal((await request('/api/device/snapshot', { method: 'POST', body: big.body, headers: { ...headers, ...big.headers } })).status, 413);
    const png = multipart(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]), { v: 1 }, { imageType: 'image/png' });
    assert.equal((await request('/api/device/snapshot', { method: 'POST', body: png.body, headers: { ...headers, ...png.headers } })).status, 415);
    const badMeta = multipart(JPEG(100), '{not json');
    assert.equal((await request('/api/device/snapshot', { method: 'POST', body: badMeta.body, headers: { ...headers, ...badMeta.headers } })).status, 400);
    const noImage = multipart(null, { v: 1 });
    assert.equal((await request('/api/device/snapshot', { method: 'POST', body: noImage.body, headers: { ...headers, ...noImage.headers } })).status, 400);
    assert.equal((await request('/api/device/snapshot', { method: 'POST', body: { v: 1 }, headers })).status, 415, 'JSON is not a photo');
    const good = multipart(JPEG(100), { v: 1 });
    assert.equal((await request('/api/device/snapshot', { method: 'POST', body: good.body, headers: { ...deviceHeaders('ESP32S3-0001', 'wrong-token-wrong-token'), ...good.headers } })).status, 401);
    assert.equal((await request('/api/device/snapshot', { method: 'POST', body: good.body, headers: good.headers })).status, 401, 'no headers');
    assert.equal((await models.Snapshot.countDocuments({ deviceSerial: 'ESP32S3-0001' })), 3);
});

test('snapshot: a photo a camera uploads answers a pending snapshot.now; the per-camera rate limit holds', async () => {
    const owner = await createUser({ role: 'manager' });
    const { token } = await pairedCamera(owner, 'ESP32S3-0002');
    await models.Camera.updateOne({ deviceSerial: 'ESP32S3-0002' }, { $set: { status: 1, 'device.lastSeenAt': new Date() } });
    const iot = { calls: [], async send(command) { this.calls.push(aws.commandName(command)); return {}; } };
    aws.setClient('iotData', iot);
    try {
        const camos = require('../src/platforms/camos');
        const waiting = camos.snapshot('ESP32S3-0002', { timeoutMs: 5000 });
        for (let i = 0; i < 100 && !iot.calls.length; i++) await new Promise(r => setTimeout(r, 20));
        assert.deepEqual(iot.calls, ['PublishCommand']);
        const headers = deviceHeaders('ESP32S3-0002', token);
        const up = multipart(JPEG(300), { trigger: 'rpc' });
        const res = await json(await request('/api/device/snapshot', { method: 'POST', body: up.body, headers: { ...headers, ...up.headers } }));
        assert.equal(res.status, 200);
        const got = await waiting;
        assert.equal(String(got.snapshot._id), res.body.snapshotId);
        assert.equal(got.snapshot.trigger, 'rpc');

        // 12 photos a minute per camera
        let last;
        for (let i = 0; i < 12; i++) {
            const b = multipart(JPEG(300), { v: 1 });
            last = await request('/api/device/snapshot', { method: 'POST', body: b.body, headers: { ...headers, ...b.headers } });
        }
        assert.equal(last.status, 429);
    } finally {
        aws.setClient('iotData', null);
    }
});

test('time, ota and the IoT rule webhook', async () => {
    const owner = await createUser({ role: 'manager' });
    const { token } = await pairedCamera(owner, 'ESP32S3-0003');
    const headers = deviceHeaders('ESP32S3-0003', token);
    const time = await json(await request('/api/device/time', { headers }));
    assert.equal(time.status, 200);
    assert.ok(Math.abs(time.body.epoch * 1000 - Date.now()) < 5000);
    assert.equal(new Date(time.body.now).getTime() > 0, true);
    // No auth needed (works before registration): the default or IP timezone
    const anon = await json(await request('/api/device/time'));
    assert.equal(anon.status, 200);
    assert.equal(anon.body.timezone, 'Asia/Ho_Chi_Minh');
    assert.equal(anon.body.tzSource, 'default');

    const ota = await json(await request('/api/device/ota', { headers }));
    assert.equal(ota.status, 200);
    assert.deepEqual(ota.body, { fw: '0.2.0', url: 'https://flybot.example.test/fw/0.2.0.bin', sha256: 'a'.repeat(64) });
    await models.Camera.updateOne({ deviceSerial: 'ESP32S3-0003' }, { $set: { 'device.fw': '0.2.0' } });
    assert.equal((await request('/api/device/ota', { headers })).status, 204, 'already on that firmware');

    // IoT rule -> FlyBot: the same handling as the MQTT subscriber, behind the shared secret
    const wakeAt = Date.now() + 600 * 1000;
    const ev = await json(await request('/api/device/events', { method: 'POST', body: { topic: 'camos/ESP32S3-0003/event', payload: { v: 1, type: 'goodbye', sleeping: true, wakeAt } }, headers: { 'X-IoT-Rule-Secret': process.env.IOT_RULE_SECRET } }));
    assert.equal(ev.status, 200);
    assert.equal(ev.body.result.type, 'goodbye');
    assert.equal((await models.Camera.findOne({ deviceSerial: 'ESP32S3-0003' }).lean()).device.sleeping, true);
    assert.equal((await request('/api/device/events', { method: 'POST', body: { topic: 'camos/ESP32S3-0003/event', payload: {} }, headers: { 'X-IoT-Rule-Secret': 'nope' } })).status, 401);
    assert.equal((await request('/api/device/events', { method: 'POST', body: { payload: {} }, headers: { 'X-IoT-Rule-Secret': process.env.IOT_RULE_SECRET } })).status, 400);
});
