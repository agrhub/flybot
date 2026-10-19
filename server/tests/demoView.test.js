const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Must be set before config/env loads (dbHelpers loads it): the Sentinel console is on
process.env.AI_PROVIDER = 'opencv-lambda';
process.env.VISION_LAMBDA_URL = 'http://127.0.0.1:9/invoke';
process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const settingsService = require('../src/services/settingsService');
const sentinelService = require('../src/services/sentinelService');
const { buildWeeklyReport } = require('../src/services/reportService');
const { accessFor } = require('../src/services/demoView');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    settingsService.clearCache();
});

const DAY = 24 * 3600 * 1000;

/** The operator's two demo traps (one EZVIZ, one CamOS), another private camera, and a visitor. */
async function demoFarm({ visitorCreatedAt } = {}) {
    const admin = await createUser({ role: 'admin', email: 'admin@example.test' });
    const operator = await createUser({ role: 'manager', name: 'Orchard Operator', email: 'operator@example.test' });
    const ezviz = await createCamera(operator, { deviceSerial: 'DEMO1', deviceName: 'Lô A', status: 1, validateCode: 'ABCDEF' });
    const camos = await createCamera(operator, { deviceSerial: 'DEMO2', deviceName: 'Lô B', platform: 'camos', status: 1 });
    await createCamera(operator, { deviceSerial: 'PRIVATE1', deviceName: 'Lô C' });
    const visitor = await createUser({ name: 'Judge', email: 'judge@example.test', ...(visitorCreatedAt ? { createdAt: visitorCreatedAt } : {}) });
    return { admin, operator, ezviz, camos, visitor };
}

const enable = (patch = {}) => settingsService.updateSettings({ demoViewEnabled: true, demoViewCameras: ['DEMO1', 'DEMO2'], ...patch }, null);
const camerasOf = async (user) => (await json(await request('/api/user/cameras', { as: user }))).body.cameras;

// ---------- Rules ----------

test('accessFor: off, empty, admins and accounts older than the date get nothing', () => {
    const user = { role: 'user', createdAt: new Date('2026-10-25T00:00:00Z') };
    const on = { demoViewEnabled: true, demoViewCameras: ['A'], demoViewSince: null, demoViewLive: false };
    assert.deepEqual(accessFor(user, on), { serials: ['A'], live: false });
    assert.deepEqual(accessFor(user, { ...on, demoViewEnabled: false }).serials, []);
    assert.deepEqual(accessFor(user, { ...on, demoViewCameras: [] }).serials, []);
    assert.deepEqual(accessFor({ ...user, role: 'admin' }, on).serials, []);
    assert.deepEqual(accessFor(user, { ...on, demoViewSince: '2026-10-26T00:00:00.000Z' }).serials, []);
    assert.deepEqual(accessFor(user, { ...on, demoViewSince: '2026-10-25T00:00:00.000Z' }).serials, ['A']);
    assert.deepEqual(accessFor({ role: 'user' }, { ...on, demoViewSince: '2026-10-25T00:00:00.000Z' }).serials, [], 'no creation date: no access');
    assert.equal(accessFor(user, { ...on, demoViewLive: true }).live, true);
});

test('off by default: a new account sees no demo camera', async () => {
    const { visitor } = await demoFarm();
    assert.deepEqual(await camerasOf(visitor), []);
    const config = await json(await request('/api/auth/config'));
    assert.equal(config.body.demoView, false);
});

// ---------- What a visitor sees ----------

test('on: a new account views the demo cameras read-only, without the owner, and nothing else', async () => {
    const { visitor } = await demoFarm();
    await enable();
    const cameras = await camerasOf(visitor);
    assert.deepEqual(cameras.map(c => c.deviceSerial).sort(), ['DEMO1', 'DEMO2']);
    for (const c of cameras) {
        assert.equal(c.access, 'demo');
        assert.equal(c.canManage, false);
        assert.equal(c.owner, null, 'the owner is not shown');
        assert.equal(c.validateCode, undefined);
        assert.equal(c.sharedWith, undefined);
        assert.equal(c.liveOpen, false);
    }
    const config = await json(await request('/api/auth/config'));
    assert.equal(config.body.demoView, true);
    const me = await json(await request('/api/auth/me', { as: visitor }));
    assert.deepEqual(me.body.user.demoView, { cameras: 2, live: false });
});

test('on: photos of demo cameras load, other cameras stay private', async () => {
    const { visitor } = await demoFarm();
    await enable();
    assert.equal((await request('/api/s3/snapshots/DEMO1/DEMO1_1700000000000.jpg', { as: visitor })).status, 200);
    assert.equal((await request('/api/s3/snapshots/PRIVATE1/PRIVATE1_1700000000000.jpg', { as: visitor })).status, 404);
});

test('the owner, people it is shared with and admins keep their own access', async () => {
    const { operator, admin } = await demoFarm();
    const friend = await createUser({ email: 'friend@example.test' });
    await models.Camera.updateOne({ deviceSerial: 'DEMO1' }, { $push: { sharedWith: { userId: friend._id, email: friend.email } } });
    await enable();
    const mine = await camerasOf(operator);
    assert.ok(mine.filter(c => c.deviceSerial.startsWith('DEMO')).every(c => c.access === 'owner' && c.canManage));
    const shared = (await camerasOf(friend)).find(c => c.deviceSerial === 'DEMO1');
    assert.equal(shared.access, 'shared');
    assert.equal(shared.owner.email, 'operator@example.test');
    assert.equal(shared.liveOpen, undefined);
    assert.ok((await camerasOf(admin)).every(c => c.access !== 'demo'));
});

test('DEMO_VIEW_SINCE: only accounts created on or after the date', async () => {
    const { visitor } = await demoFarm({ visitorCreatedAt: new Date(Date.now() - 10 * DAY) });
    const newcomer = await createUser({ email: 'newcomer@example.test' });
    await enable({ demoViewSince: new Date(Date.now() - DAY).toISOString().slice(0, 10) });
    assert.deepEqual(await camerasOf(visitor), []);
    assert.equal((await camerasOf(newcomer)).length, 2);
    // The sign-up hint only while an account made now would get it
    assert.equal((await json(await request('/api/auth/config'))).body.demoView, true);
    await enable({ demoViewSince: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10) });
    assert.equal((await json(await request('/api/auth/config'))).body.demoView, false);
});

test('turning it off removes the access at once', async () => {
    const { visitor } = await demoFarm();
    await enable();
    assert.equal((await camerasOf(visitor)).length, 2);
    await settingsService.updateSettings({ demoViewEnabled: false }, null);
    assert.deepEqual(await camerasOf(visitor), []);
    assert.equal((await request('/api/s3/snapshots/DEMO1/DEMO1_1700000000000.jpg', { as: visitor })).status, 404);
});

// ---------- What a visitor cannot do ----------

test('a visitor cannot change, capture, share, delete or maintain a demo camera', async () => {
    const { visitor } = await demoFarm();
    await enable();
    const attempts = [
        ['PUT', '/api/user/camera', { deviceSerial: 'DEMO1', deviceName: 'Mine now' }],
        ['PUT', '/api/user/camera/location', { deviceSerial: 'DEMO1', latitude: 10, longitude: 106 }],
        ['POST', '/api/user/update-camera-code', { deviceSerial: 'DEMO1', validateCode: 'XXXXXX' }],
        ['POST', '/api/user/camera/capture', { deviceSerial: 'DEMO1' }],
        ['POST', '/api/user/camera/share', { deviceSerial: 'DEMO1', email: 'friend@example.test' }],
        ['DELETE', '/api/user/delete-camera', { deviceSerial: 'DEMO1' }],
        ['POST', '/api/user/camera/maintenance', { deviceSerial: 'DEMO1', type: 'card_replaced' }],
        ['POST', '/api/user/camera/provision', { deviceSerial: 'DEMO2' }],
        ['PUT', '/api/cameras/DEMO2/device-settings', { desired: { interval: 15 } }],
        ['GET', '/api/cameras/DEMO2/device-settings', undefined]
    ];
    for (const [method, path, body] of attempts) {
        const res = await request(path, { method, as: visitor, body });
        assert.ok([403, 404].includes(res.status), `${method} ${path}: ${res.status}`);
    }
    const camera = await models.Camera.findOne({ deviceSerial: 'DEMO1' }).lean();
    assert.equal(camera.deviceName, 'Lô A');
    assert.equal(camera.validateCode, 'ABCDEF');
    assert.deepEqual(camera.sharedWith, []);
});

test('live view and SD playback stay closed unless the admin opens them', async () => {
    const { visitor } = await demoFarm();
    await enable();
    for (const path of ['/api/live', '/api/records', '/api/playback']) {
        const res = await json(await request(path, { method: 'POST', as: visitor, body: { deviceSerial: 'DEMO1' } }));
        assert.equal(res.status, 403, path);
        assert.equal(res.body.msg, 'Live view of this demo camera is not open to visitors.');
    }
    for (const [method, path] of [['GET', '/api/cameras/DEMO1/live'], ['GET', '/api/cameras/DEMO2/live'], ['POST', '/api/cameras/DEMO2/live/request'], ['GET', '/api/cameras/DEMO1/playback']]) {
        const res = await json(await request(path, { method, as: visitor, body: method === 'POST' ? {} : undefined }));
        assert.equal(res.status, 403, path);
        assert.equal(res.body.code, 'DEMO_READ_ONLY');
    }
    // Vietnamese for the app
    const vi = await json(await request('/api/cameras/DEMO1/live', { as: visitor, headers: { 'X-Language': 'vi' } }));
    assert.equal(vi.body.message, 'Camera trình diễn này chưa mở xem trực tiếp cho khách.');

    await enable({ demoViewLive: true });
    const live = await json(await request('/api/live', { method: 'POST', as: visitor, body: { deviceSerial: 'DEMO1' } }));
    assert.equal(live.status, 200);
    assert.equal((await camerasOf(visitor)).find(c => c.deviceSerial === 'DEMO1').liveOpen, true);
});

// ---------- Sentinel console ----------

test('Sentinel: a visitor reads the demo traces and proposals but cannot decide them', async () => {
    const { visitor, camos } = await demoFarm();
    await enable();
    const snap = await models.Snapshot.create({
        deviceSerial: 'DEMO2', imageUrl: 'x', s3Key: 'snapshots/DEMO2/a.jpg', aiProcessed: true, aiProvider: 'opencv-lambda', aiResults: { summary: { fruit_fly: 12 } },
        lambda: { status: 'ok', traceId: 'tr_demo', analyzedAt: new Date(), counts: { total: 12 }, proposals: [{ id: 'p1', action: 'set_interval', params: { minutes: 15 }, reason: 'Count doubled', confidence: 0.8 }] }
    });
    await sentinelService.createLambdaProposals({ snapshot: snap, camera: camos.toObject(), proposals: snap.lambda.proposals, traceId: 'tr_demo' });

    const traces = await json(await request('/api/sentinel/ui/traces', { as: visitor }));
    assert.equal(traces.status, 200);
    assert.equal(traces.body.items.length, 1);
    const approvals = await json(await request('/api/sentinel/ui/approvals', { as: visitor }));
    assert.equal(approvals.body.items.length, 1);
    assert.equal(approvals.body.items[0].can_decide, false);
    const decide = await request(`/api/sentinel/ui/approvals/${approvals.body.items[0].approval_id}/decide`, { method: 'POST', as: visitor, body: { decision: 'approve' } });
    assert.equal(decide.status, 403);
    assert.equal((await models.SentinelProposal.findById(approvals.body.items[0].approval_id).lean()).state, 'pending');
});

// ---------- Background jobs ----------

test('reports built for the account itself never include demo cameras', async () => {
    const { visitor } = await demoFarm();
    await enable();
    assert.equal(await buildWeeklyReport(await models.User.findById(visitor._id)), null);
});

// ---------- Admin settings ----------

test('admin settings: validated, saved, and "every account" (null) does not fall back to the environment', async () => {
    const { admin, visitor } = await demoFarm();
    const put = async (body) => json(await request('/api/admin/settings', { method: 'PUT', as: admin, body }));
    for (const bad of [{ demoViewCameras: ['bad serial!'] }, { demoViewCameras: 'DEMO1' }, { demoViewSince: 'yesterday' }, { demoViewLive: 'yes' }, { demoViewCameras: Array.from({ length: 21 }, (_, i) => `C${i}`) }]) {
        assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
    const saved = await put({ demoViewEnabled: true, demoViewCameras: ['DEMO1', 'DEMO1', 'DEMO2'], demoViewSince: '2026-10-20', demoViewLive: false });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.settings.demoViewCameras, ['DEMO1', 'DEMO2']);
    assert.equal(saved.body.settings.demoViewSince, '2026-10-20T00:00:00.000Z');
    const cleared = await put({ demoViewSince: null });
    assert.equal(cleared.body.settings.demoViewSince, null);
    assert.equal((await put({ demoViewEnabled: true })).status, 200);
    // Not for anyone else
    assert.equal((await request('/api/admin/settings', { method: 'PUT', as: visitor, body: { demoViewEnabled: false } })).status, 403);
});
