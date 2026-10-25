const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const settingsService = require('../src/services/settingsService');
const { aliasOf, accessFor } = require('../src/services/demoView');
const demoMask = require('../src/middlewares/demoMask');
const agent = require('../src/agent/agent');

// Recorded video on the EZVIZ trap's SD card (the live address is stubbed in dbHelpers)
const ezvizService = require('../src/services/ezvizService');
ezvizService.getLocalRecords = async () => ({ code: '200', data: [] });
ezvizService.getPlaybackAddress = async () => ({ responseData: { code: '200', data: { url: 'ezopen://open.example.test/rec', id: 'rec-1' } }, token: 't', areaDomain: 'https://open.example.test' });

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    settingsService.clearCache();
});

// The owner's CamOS trap at home (a 4G cell estimate) and an EZVIZ trap, both shared with visitors
const CAMOS = 'ESPA1B2C3D4E5F6';
const EZVIZ = 'BD1234567';
const OPEN = { live: true, playback: true, location: true, device: true, realSerial: true };
const CLOSED = { live: false, playback: false, location: false, device: false, realSerial: false };

async function setup({ camos = CLOSED, ezviz = OPEN, audience = 'guest' } = {}) {
    const admin = await createUser({ role: 'admin', email: 'admin@example.test' });
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    await createCamera(owner, {
        deviceSerial: CAMOS, deviceName: 'Vĩnh Long', platform: 'camos', status: 1,
        latitude: 10.25391, longitude: 105.97212, locationAddress: 'Near the owner\'s home',
        device: { fw: '0.9.4', net: '4g', rssi: -71, battery: { pct: 88, mv: 4012 }, location: { lat: 10.25391, lng: 105.97212, source: 'cell', accuracyM: 900 }, mac: 'A1:B2:C3:D4:E5:F6', imei: '860000000000001', kvsChannelName: `cam-${CAMOS}` }
    });
    await createCamera(owner, {
        deviceSerial: EZVIZ, deviceName: 'Bình Dương', status: 1, validateCode: 'ABCDEF',
        latitude: 11.1, longitude: 106.6, locationAddress: 'Bình Dương', deviceVersion: 'V5.3.0', model: 'CS-EB3'
    });
    for (const serial of [CAMOS, EZVIZ]) {
        await models.Snapshot.create({
            deviceSerial: serial, imageUrl: `snapshots/${serial}/${serial}_1700000000000.jpg`, s3Key: `snapshots/${serial}/${serial}_1700000000000.jpg`,
            aiProcessed: true, aiResults: { summary: { fruit_fly: 3 } }, meta: { battery: { pct: 80 }, rssi: -70, gps: { lat: 10.25391, lng: 105.97212 } }
        });
    }
    await settingsService.updateSettings({
        guestAccessEnabled: true, demoViewEnabled: true, demoViewAudience: audience,
        demoViewShares: [{ deviceSerial: CAMOS, ...camos }, { deviceSerial: EZVIZ, ...ezviz }]
    }, null);
    const { token } = (await json(await request('/api/auth/guest', { method: 'POST' }))).body;
    return { admin, owner, guest: { Authorization: `Bearer ${token}` } };
}

const get = async (path, headers) => {
    const res = await request(path, { headers });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
};
const camerasOf = async (headers) => (await get('/api/user/cameras', headers)).body.cameras;

// ---------- Settings ----------

test('settings: the old camera list becomes entries with its behaviour; saving entries keeps the list', async () => {
    await settingsService.updateSettings({ demoViewCameras: ['A1', 'B2'], demoViewLive: true }, null);
    let settings = await settingsService.getSettings();
    assert.deepEqual(settings.demoViewShares, [
        { deviceSerial: 'A1', live: true, playback: true, location: true, device: true, realSerial: true },
        { deviceSerial: 'B2', live: true, playback: true, location: true, device: true, realSerial: true }
    ]);
    // Never saved: the list as it was, with demoViewLive as each camera's live view
    await models.SystemSetting.updateOne({ key: 'global' }, { $unset: { demoViewShares: 1 }, $set: { demoViewLive: false } });
    settingsService.clearCache();
    assert.equal((await settingsService.getSettings()).demoViewShares[0].live, false);

    await settingsService.updateSettings({ demoViewShares: [{ deviceSerial: 'A1', live: true, realSerial: false }] }, null);
    settings = await settingsService.getSettings();
    assert.deepEqual(settings.demoViewCameras, ['A1']);
    assert.deepEqual(settings.demoViewShares, [{ deviceSerial: 'A1', live: true, playback: false, location: false, device: false, realSerial: false }]);
    // A list saved by an older page keeps each remaining camera's permissions
    await settingsService.updateSettings({ demoViewCameras: ['A1', 'C3'] }, null);
    settings = await settingsService.getSettings();
    assert.deepEqual(settings.demoViewShares.map(e => [e.deviceSerial, e.realSerial, e.location]), [['A1', false, false], ['C3', true, true]]);
});

test('settings: entries are validated', async () => {
    const admin = await createUser({ role: 'admin' });
    const put = async (body) => (await json(await request('/api/admin/settings', { method: 'PUT', as: admin, body }))).status;
    for (const bad of [
        [{ deviceSerial: 'bad serial!' }],
        [{ deviceSerial: 'A1', live: 'yes' }],
        [{ deviceSerial: 'A1', owner: true }],
        [{ deviceSerial: 'A1' }, { deviceSerial: 'A1' }],
        Array.from({ length: 21 }, (_, i) => ({ deviceSerial: `C${i}` })),
        'A1'
    ]) {
        assert.equal(await put({ demoViewShares: bad }), 400, JSON.stringify(bad));
    }
    assert.equal(await put({ demoViewShares: [{ deviceSerial: 'A1', live: true }] }), 200);
});

// ---------- What a guest sees ----------

test('everything closed: photos and counts, no live, playback, location, device details or serial', async () => {
    const { guest } = await setup();
    const alias = aliasOf(CAMOS);
    const list = await get('/api/user/cameras', guest);
    assert.ok(!list.text.includes(CAMOS), 'the real serial is in no answer');
    assert.ok(!list.text.includes('A1:B2:C3:D4:E5:F6') && !list.text.includes('860000000000001'));
    const cam = list.body.cameras.find(c => c.deviceName === 'Vĩnh Long');
    assert.equal(cam.deviceSerial, alias);
    assert.deepEqual(cam.demo, CLOSED);
    assert.equal(cam.liveOpen, false);
    assert.equal(cam.playbackOpen, false);
    assert.equal(cam.latitude ?? null, null);
    assert.equal(cam.longitude ?? null, null);
    assert.equal(cam.locationAddress ?? '', '');
    for (const key of ['fw', 'battery', 'rssi', 'net', 'location', 'kvsChannelName']) assert.equal(cam.device[key], undefined, key);
    assert.ok(!list.text.includes('10.25391'), 'no coordinates');

    // The alias reaches the camera: its photos, history, status
    assert.equal((await request(`/api/s3/snapshots/${alias}/${alias}_1700000000000.jpg`, { headers: guest })).status, 200);
    assert.equal((await request(`/api/s3/snapshots/${CAMOS}/${CAMOS}_1700000000000.jpg`, { headers: guest })).status, 200, 'the serial works too: the alias hides it, it is not the lock');
    const overview = await get('/api/ai/overview', guest);
    assert.equal(overview.status, 200);
    assert.ok(!overview.text.includes(CAMOS) && !overview.text.includes('10.25391') && !overview.text.includes('Near the owner'));
    const status = await get(`/api/cameras/${alias}/status`, guest);
    assert.equal(status.status, 200);
    assert.equal(status.body.status.battery, undefined);
    assert.equal(status.body.status.location, undefined);
    assert.equal(status.body.status.fw, undefined);
    assert.equal(typeof status.body.status.online, 'boolean');

    // Closed: firmware, log, live, live request
    assert.equal((await request(`/api/cameras/${alias}/firmware`, { headers: guest })).status, 404);
    assert.equal((await request(`/api/cameras/${alias}/log`, { headers: guest })).status, 404);
    assert.equal((await request(`/api/cameras/${alias}/crashes`, { headers: guest })).status, 404);
    const live = await json(await request(`/api/cameras/${alias}/live`, { headers: guest }));
    assert.equal(live.status, 403);
    assert.equal(live.body.code, 'DEMO_READ_ONLY');
    assert.equal((await request(`/api/cameras/${alias}/live/request`, { method: 'POST', headers: guest, body: {} })).status, 403);

    // Sentinel's device list
    const env = require('../src/config/env');
    const wasConsole = env.SENTINEL_CONSOLE;
    env.SENTINEL_CONSOLE = true;
    try {
        const devices = await get('/api/sentinel/ui/devices', guest);
        assert.equal(devices.status, 200);
        assert.ok(devices.text.includes(alias));
        assert.ok(!devices.text.includes(CAMOS) && !devices.text.includes('10.25391') && !devices.text.includes('"battery_percent":88'));
    } finally {
        env.SENTINEL_CONSOLE = wasConsole;
    }
});

test('everything open: the real serial, location, device details, firmware and log (read-only)', async () => {
    const { guest } = await setup({ camos: OPEN });
    const cam = (await camerasOf(guest)).find(c => c.deviceName === 'Vĩnh Long');
    assert.equal(cam.deviceSerial, CAMOS);
    assert.equal(cam.latitude, 10.25391);
    assert.equal(cam.locationAddress, 'Near the owner\'s home');
    assert.equal(cam.device.battery.pct, 88);
    assert.equal(cam.device.location.source, 'cell');
    assert.equal((await request(`/api/cameras/${CAMOS}/firmware`, { headers: guest })).status, 200);
    assert.equal((await request(`/api/cameras/${CAMOS}/log`, { headers: guest })).status, 200);
    // Reading only: the log is never started, stopped or watched by a visitor
    for (const path of ['log/start', 'log/stop', 'log/watch']) {
        assert.equal((await request(`/api/cameras/${CAMOS}/${path}`, { method: 'POST', headers: guest, body: {} })).status, 403, path);
    }
    const status = await get(`/api/cameras/${CAMOS}/status`, guest);
    assert.equal(status.body.status.battery.pct, 88);
});

test('each permission on its own', async () => {
    // Device details without the location: battery yes, GPS fix no
    let { guest } = await setup({ camos: { ...CLOSED, device: true } });
    let cam = (await camerasOf(guest)).find(c => c.deviceName === 'Vĩnh Long');
    assert.equal(cam.device.battery.pct, 88);
    assert.equal(cam.device.location, undefined);
    assert.equal(cam.latitude ?? null, null);
    const history = await get(`/api/cameras/${cam.deviceSerial}/status`, guest);
    assert.equal(history.body.status.location, undefined);
    assert.equal(history.body.status.battery.pct, 88);
    await models.CameraLog.create({ deviceSerial: CAMOS, at: new Date(), lvl: 3, tag: 'gps', msg: 'fix 10.253910,105.972120' });
    const log = await get(`/api/cameras/${cam.deviceSerial}/log`, guest);
    assert.equal(log.status, 200);
    assert.equal(log.body.lines.length, 1);
    assert.ok(!log.text.includes('10.253910'), 'no coordinates in the log either');
    assert.match(log.body.lines[0].msg, /fix …,…/);

    // The location without device details
    await clearDb();
    settingsService.clearCache();
    ({ guest } = await setup({ camos: { ...CLOSED, location: true, realSerial: true } }));
    cam = (await camerasOf(guest)).find(c => c.deviceName === 'Vĩnh Long');
    assert.equal(cam.deviceSerial, CAMOS);
    assert.equal(cam.latitude, 10.25391);
    assert.equal(cam.device.battery, undefined);
    assert.equal((await request(`/api/cameras/${CAMOS}/firmware`, { headers: guest })).status, 404);
});

test('live view and recorded video are opened per camera', async () => {
    const { guest } = await setup({ ezviz: { ...OPEN, playback: false } });
    const live = await json(await request('/api/live', { method: 'POST', headers: guest, body: { deviceSerial: EZVIZ } }));
    assert.equal(live.status, 200);
    const records = await json(await request('/api/records', { method: 'POST', headers: guest, body: { deviceSerial: EZVIZ } }));
    assert.equal(records.status, 403);
    assert.equal(records.body.msg, 'Recorded video of this demo camera is not open to visitors.');
    assert.equal((await request('/api/playback', { method: 'POST', headers: guest, body: { deviceSerial: EZVIZ } })).status, 403);
    const cam = (await camerasOf(guest)).find(c => c.deviceSerial === EZVIZ);
    assert.equal(cam.liveOpen, true);
    assert.equal(cam.playbackOpen, false);

    // Playback without live view
    await settingsService.updateSettings({ demoViewShares: [{ deviceSerial: EZVIZ, ...OPEN, live: false }] }, null);
    assert.equal((await request('/api/live', { method: 'POST', headers: guest, body: { deviceSerial: EZVIZ } })).status, 403);
    assert.equal((await request('/api/records', { method: 'POST', headers: guest, body: { deviceSerial: EZVIZ } })).status, 200);
    // Still read-only around it
    assert.equal((await request('/api/user/camera/capture', { method: 'POST', headers: guest, body: { deviceSerial: EZVIZ } })).status, 403);
});

test('a hidden serial: the alias works in links and requests, the stream keeps the real one for the player', async () => {
    const { guest } = await setup({ camos: CLOSED, ezviz: { ...OPEN, realSerial: false } });
    const alias = aliasOf(EZVIZ);
    const cam = (await camerasOf(guest)).find(c => c.deviceName === 'Bình Dương');
    assert.equal(cam.deviceSerial, alias);
    assert.equal(cam.locationAddress, 'Bình Dương', 'location stays open');
    // Requests that name the alias reach the camera
    assert.equal((await request('/api/live', { method: 'POST', headers: guest, body: { deviceSerial: alias } })).status, 200);
    assert.equal((await request('/api/records', { method: 'POST', headers: guest, body: { deviceSerial: alias } })).status, 200);
    // An alias of a camera that is not shared opens nothing
    assert.equal((await request(`/api/cameras/${aliasOf('PRIVATE9')}/status`, { headers: guest })).status, 404);
});

test('the owner, admins and people it is shared with see everything', async () => {
    const { owner, admin } = await setup();
    const friend = await createUser({ email: 'friend@example.test' });
    await models.Camera.updateOne({ deviceSerial: CAMOS }, { $push: { sharedWith: { userId: friend._id, email: friend.email } } });
    for (const user of [owner, admin, friend]) {
        const res = await get('/api/user/cameras', { Authorization: `Bearer ${require('jsonwebtoken').sign({ id: String(user._id), v: 0 }, require('../src/config/env').JWT_SECRET)}` });
        const cam = res.body.cameras.find(c => c.deviceName === 'Vĩnh Long');
        assert.equal(cam.deviceSerial, CAMOS, user.email);
        assert.equal(cam.latitude, 10.25391, user.email);
        assert.equal(cam.demo, undefined, user.email);
    }
});

test('demo audience: other accounts get the same limits', async () => {
    await setup({ audience: 'all' });
    const visitor = await createUser({ email: 'judge@example.test' });
    await createCamera(visitor, { deviceSerial: 'MINE1', latitude: 9.9, longitude: 105.1 });
    const res = await json(await request('/api/user/cameras', { as: visitor }));
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(CAMOS) && !text.includes('10.25391'));
    const mine = res.body.cameras.find(c => c.deviceSerial === 'MINE1');
    assert.equal(mine.latitude, 9.9, 'their own camera is untouched');
    assert.equal((await request(`/api/cameras/${aliasOf(CAMOS)}/firmware`, { as: visitor })).status, 404);
    assert.equal((await request(`/api/cameras/${aliasOf(CAMOS)}/live`, { as: visitor })).status, 403);
});

test('the assistant works with aliases: it never reads a hidden serial or location', async () => {
    await setup();
    const guestDoc = await models.User.findOne({ guest: true });
    const settings = await settingsService.getSettings();
    const access = accessFor(guestDoc, settings);
    const mask = await require('../src/services/demoView').maskFor(guestDoc, access);
    const seen = [];
    agent.setModelClient({
        stream: async (req) => {
            seen.push(JSON.stringify(req.contents));
            const chunk = (...parts) => ({ candidates: [{ content: { role: 'model', parts } }] });
            const turn = seen.length === 1
                ? [chunk({ functionCall: { name: 'get_cameras_status', args: { deviceSerial: aliasOf(CAMOS) } } })]
                : [chunk({ text: 'Done.' })];
            return (async function* () { for (const c of turn) yield c; })();
        }
    });
    const user = { id: String(guestDoc._id), role: 'user', guest: true, demoSerials: access.serials, demoShares: access.shares, demoOrgId: null };
    const result = await agent.chatWithAgent({ sessionId: 'g1', message: 'Which traps?', userId: String(guestDoc._id), user, demoMask: mask, uiContext: { deviceSerial: CAMOS } });
    assert.equal(result.reply, 'Done.');
    const all = seen.join('\n');
    assert.ok(all.includes(aliasOf(CAMOS)), 'the model knows the alias');
    assert.ok(!all.includes(CAMOS), 'never the serial');
    assert.ok(!all.includes('10.25391'));
});

test('mask helpers: fields by camera, aliases in text and back', () => {
    const perms = new Map([['S1', { ...CLOSED, live: true }]]);
    const mask = { aliases: new Map([['ESPA1B2C3D4E5F6', 'DEMO-0000000001']]), byAlias: new Map([['DEMO-0000000001', 'ESPA1B2C3D4E5F6']]), perms: new Map([['ESPA1B2C3D4E5F6', CLOSED], ...perms]) };
    const out = demoMask.scrub({ cameras: [{ deviceSerial: 'S1', latitude: 1, device: { battery: 1, sleeping: true } }, { deviceSerial: 'OTHER', latitude: 2 }] }, mask);
    assert.deepEqual(out.cameras[0], { deviceSerial: 'S1', device: { sleeping: true } });
    assert.equal(out.cameras[1].latitude, 2);
    assert.equal(demoMask.aliasText('mac a1:b2:c3:d4:e5:f6 sn ESPA1B2C3D4E5F6', mask), 'mac DEMO-0000000001 sn DEMO-0000000001');
    assert.deepEqual(demoMask.unaliasData({ deviceSerial: 'DEMO-0000000001', list: ['x DEMO-0000000001'] }, mask.byAlias), { deviceSerial: 'ESPA1B2C3D4E5F6', list: ['x ESPA1B2C3D4E5F6'] });
});
