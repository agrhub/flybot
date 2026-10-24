const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IOT_ENDPOINT = 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com';

const { models, startDb, stopDb, clearDb, request, createUser, json } = require('./dbHelpers');
const aws = require('../src/platforms/aws');
const camos = require('../src/platforms/camos');
const sse = require('../src/realtime/sseHub');
const { sha256 } = require('../src/services/deviceService');
const logs = require('../src/services/cameraLogService');

// ---------- Fakes: the IoT data plane records what FlyBot publishes; SSE pushes are recorded ----------
let published;
const fakeIotData = {
    send: async (command) => {
        if (aws.commandName(command) === 'PublishCommand') {
            const message = JSON.parse(Buffer.from(command.input.payload).toString());
            published.push({ topic: command.input.topic, message });
            // The camera answers log.start with its log state
            const serial = command.input.topic.match(/^camos\/([^/]+)\/rpc\/req$/)?.[1];
            if (serial && message.method === 'log.start') {
                const until = new Date(Date.now() + message.params.minutes * 60000).toISOString();
                setImmediate(() => camos.handleMessage(`camos/${serial}/rpc/res`, { id: message.id, ok: true, result: { log: { on: true, level: message.params.level, until, sent: 0, session: 'a1b2c3d4' } } }));
            }
        }
        return {};
    }
};
let pushed;
const realSend = sse.sendToUser;

before(async () => {
    await startDb();
    aws.setClient('iotData', fakeIotData);
    sse.sendToUser = (userId, event, data) => { pushed.push({ userId: String(userId), event, data }); return 1; };
});
after(async () => {
    aws.setClient('iotData', null);
    sse.sendToUser = realSend;
    await stopDb();
});
beforeEach(async () => {
    await clearDb();
    published = [];
    pushed = [];
});

const SERIAL = 'ESP1234567890AB';
const TOKEN = 'device-token-'.padEnd(43, 'x');

async function camera(owner, extra = {}) {
    return models.Camera.create({
        userId: owner._id, deviceSerial: SERIAL, deviceName: 'Trap 90AB', platform: 'camos', model: 'AIC-FREENOVE-S3CAM',
        status: 1, device: { thingName: SERIAL, fw: '0.8.0', lastSeenAt: new Date(), tokenHash: sha256(TOKEN) }, ...extra
    });
}

test('parses esp_log lines; other text is info', () => {
    assert.deepEqual(logs.parseLine('W (165398) wifi: disconnected, retry in 880 ms'), { lvl: 2, ms: 165398, tag: 'wifi', msg: 'disconnected, retry in 880 ms' });
    assert.deepEqual(logs.parseLine('E (1250) sdmmc_common: sdmmc_init_ocr: send_op_cond (1) returned 0x107'), { lvl: 1, ms: 1250, tag: 'sdmmc_common', msg: 'sdmmc_init_ocr: send_op_cond (1) returned 0x107' });
    assert.equal(logs.parseLine('\u001b[0;32mI (5) boot: ok\u001b[0m').tag, 'boot');
    assert.deepEqual(logs.parseLine('Backtrace: 0x4037 0x4038'), { lvl: 3, ms: null, tag: '', msg: 'Backtrace: 0x4037 0x4038' });
});

test('owner turns the log on: shadow log {level, until} and RPC log.start for an awake camera; shared viewers cannot', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser();
    await camera(owner, { sharedWith: [{ userId: viewer._id, email: viewer.email }] });
    assert.equal((await request(`/api/cameras/${SERIAL}/log`, { as: viewer })).status, 404);
    assert.equal((await request(`/api/cameras/${SERIAL}/log/start`, { method: 'POST', as: viewer, body: {} })).status, 404);
    assert.equal((await json(await request(`/api/cameras/${SERIAL}/log/start`, { method: 'POST', as: owner, body: { minutes: 90 } }))).status, 400);

    const res = await json(await request(`/api/cameras/${SERIAL}/log/start`, { method: 'POST', as: owner, body: { level: 'warn', minutes: 20 } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sent, true);
    const desired = published.filter(p => p.topic === `camos/${SERIAL}/shadow/desired`).pop().message;
    assert.equal(desired.log.level, 'warn');
    assert.ok(new Date(desired.log.until) > new Date(Date.now() + 19 * 60 * 1000));
    const rpc = published.find(p => p.topic === `camos/${SERIAL}/rpc/req`).message;
    assert.equal(rpc.method, 'log.start');
    assert.deepEqual(rpc.params, { level: 'warn', minutes: 20, backlog: true });
    // On at once from the camera's answer, before any line or shadow report
    const state = (await json(await request(`/api/cameras/${SERIAL}/log`, { as: owner }))).body.state;
    assert.equal(state.on, true);
    assert.equal(state.level, 'warn');
    for (let i = 0; i < 50 && !(await models.AuditLog.exists({ action: 'camera.log_started' })); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(await models.AuditLog.exists({ action: 'camera.log_started' }));

    // A sleeping camera: only the shadow (it starts at its next wake)
    await models.Camera.updateOne({ deviceSerial: SERIAL }, { $set: { status: 0, 'device.sleeping': true } });
    published = [];
    const asleep = await json(await request(`/api/cameras/${SERIAL}/log/start`, { method: 'POST', as: owner, body: {} }));
    assert.equal(asleep.body.sent, false);
    assert.equal(published.filter(p => p.topic.endsWith('/rpc/req')).length, 0);

    const stopped = await json(await request(`/api/cameras/${SERIAL}/log/stop`, { method: 'POST', as: owner }));
    assert.equal(stopped.status, 200);
    assert.equal(published.filter(p => p.topic === `camos/${SERIAL}/shadow/desired`).pop().message.log, null);
});

test('log batches from MQTT are stored with their times, pushed to watchers, filtered and downloaded', async () => {
    const owner = await createUser({ role: 'manager' });
    const admin = await createUser({ role: 'admin' });
    await camera(owner);
    await json(await request(`/api/cameras/${SERIAL}/log/watch`, { method: 'POST', as: owner, body: {} }));
    const at = Date.parse('2026-10-19T14:00:10Z');
    const r = await camos.handleMessage(`camos/${SERIAL}/log`, {
        v: 1, session: 'a1b2c3d4', seq: 1, uptimeMs: 20000, at,
        lines: ['I (10000) proto: connected to mqtts://broker:8883', 'W (15000) wifi: disconnected, retry in 880 ms', 'E (19000) flybot: snapshot attempt 1: http 500', 'camos> info']
    });
    assert.equal(r.stored, 4);
    const rows = await models.CameraLog.find({ deviceSerial: SERIAL }).sort({ at: 1 }).lean();
    assert.equal(rows[0].at.toISOString(), '2026-10-19T14:00:00.000Z', 'uptime stamps become times');
    assert.deepEqual(rows.map(x => x.lvl), [3, 2, 1, 3]);
    const mine = pushed.filter(p => p.userId === String(owner._id));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].event, 'camera_log');
    assert.equal(mine[0].data.lines.length, 4);
    assert.equal((await models.Camera.findOne({ deviceSerial: SERIAL }).lean()).device.log.on, true);

    const errors = await json(await request(`/api/cameras/${SERIAL}/log?level=warn`, { as: owner }));
    assert.deepEqual(errors.body.lines.map(l => l.tag), ['wifi', 'flybot']);
    const found = await json(await request(`/api/cameras/${SERIAL}/log?q=MQTTS`, { as: admin }));
    assert.equal(found.body.lines.length, 1);
    const since = await json(await request(`/api/cameras/${SERIAL}/log?since=${encodeURIComponent('2026-10-19T14:00:06Z')}`, { as: owner }));
    assert.equal(since.body.lines.length, 2);

    const dl = await request(`/api/cameras/${SERIAL}/log/download`, { as: owner });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /ESP1234567890AB-log-/);
    const text = await dl.text();
    assert.match(text, /2026-10-19T14:00:05\.000Z W wifi: disconnected/);

    await camos.handleMessage(`camos/${SERIAL}/log`, { v: 1, session: 'a1b2c3d4', seq: 2, lines: [], end: true });
    assert.equal((await models.Camera.findOne({ deviceSerial: SERIAL }).lean()).device.log.on, false);
});

test('a crash report (MQTT event or HTTPS) is kept with its log tail and backtrace; the camera shows it', async () => {
    const owner = await createUser({ role: 'manager' });
    await camera(owner);
    await camos.handleMessage(`camos/${SERIAL}/event`, {
        v: 1, type: 'crash', reason: 'crash', detail: 'power_on', fw: '0.8.0',
        logTail: 'E (91000) console: crash test: abort() now\n',
        coredump: { task: 'console', pc: '0x4037a1b2', backtrace: ['0x4037a1b2', '0x42001234', 'bad'], corrupted: false, elfSha256: 'abcdef0123456789' }
    });
    const crashes = await json(await request(`/api/cameras/${SERIAL}/crashes`, { as: owner }));
    assert.equal(crashes.body.crashes.length, 1);
    const c = crashes.body.crashes[0];
    assert.equal(c.reason, 'crash');
    assert.match(c.logTail, /abort\(\) now/);
    assert.deepEqual(c.coredump.backtrace, ['0x4037a1b2', '0x42001234']);
    const cam = await models.Camera.findOne({ deviceSerial: SERIAL }).lean();
    assert.equal(cam.device.lastCrash.reason, 'crash');

    // No MQTT: the same over the device API, with the latest log lines
    const res = await json(await request('/api/device/logs', {
        method: 'POST', headers: { 'X-Device-Serial': SERIAL, 'X-Device-Token': TOKEN },
        body: { v: 1, kind: 'crash', fw: '0.8.0', uptimeMs: 130000, crash: { reason: 'task_watchdog', fw: '0.8.0', logTail: 'W (1) x: y\n' }, lines: ['E (120000) proto: transport error'] }
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.stored, 1);
    assert.equal((await models.CameraCrash.countDocuments({ deviceSerial: SERIAL, source: 'http' })), 1);
    assert.equal((await request('/api/device/logs', { method: 'POST', headers: { 'X-Device-Serial': SERIAL, 'X-Device-Token': 'wrong-token-'.padEnd(43, 'y') }, body: { kind: 'diag' } })).status, 401);
    assert.equal((await request('/api/device/logs', { method: 'POST', headers: { 'X-Device-Serial': SERIAL, 'X-Device-Token': TOKEN }, body: { kind: 'other' } })).status, 400);

    // The fleet page marks it
    const admin = await createUser({ role: 'admin' });
    const fleet = await json(await request('/api/admin/fleet', { as: admin }));
    assert.equal(fleet.body.cameras[0].lastCrash.reason, 'task_watchdog');
});

test('lines are capped per camera', async () => {
    const owner = await createUser({ role: 'manager' });
    await camera(owner);
    const { MAX_LINES_PER_CAMERA } = require('../src/models/CameraLog');
    const old = Array.from({ length: 50 }, (_, i) => ({ deviceSerial: SERIAL, at: new Date(Date.now() - 3600 * 1000 + i), lvl: 3, msg: `old ${i}` }));
    await models.CameraLog.insertMany(old);
    // Pretend the camera already has the maximum: the oldest go when the next batch arrives
    const filler = Array.from({ length: MAX_LINES_PER_CAMERA - 10 }, (_, i) => ({ deviceSerial: SERIAL, at: new Date(Date.now() - 1800 * 1000 + i), lvl: 3, msg: `f${i}` }));
    await models.CameraLog.insertMany(filler, { ordered: false });
    await camos.handleMessage(`camos/${SERIAL}/log`, { v: 1, session: 's', seq: 1, lines: ['I (1) a: b'] });
    for (let i = 0; i < 40 && (await models.CameraLog.countDocuments({ deviceSerial: SERIAL })) > MAX_LINES_PER_CAMERA; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok((await models.CameraLog.countDocuments({ deviceSerial: SERIAL })) <= MAX_LINES_PER_CAMERA);
    assert.equal(await models.CameraLog.exists({ deviceSerial: SERIAL, msg: 'old 0' }), null);
});
