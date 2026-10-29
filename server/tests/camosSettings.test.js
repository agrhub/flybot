const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IOT_ENDPOINT = 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const aws = require('../src/platforms/aws');
const settings = require('../src/services/camosSettings');

before(startDb);
after(stopDb);
beforeEach(clearDb);

/** A fake IoT data-plane client: records every command, answers the shadow update with an empty state. */
function fakeIot() {
    const calls = [];
    return {
        calls,
        async send(command) {
            calls.push({ name: command?.constructor?.name, input: command.input });
            return { payload: Buffer.from(JSON.stringify({ state: { desired: {} }, version: 9 })) };
        }
    };
}

test('camosSettings: values are checked against the firmware key list', () => {
    const ok = settings.toDesired({ 'capture.intervalMin': 30, 'motion.enabled': true, 'video.image.whiteBalance': 'cloudy', 'capture.window': { from: '06:00', to: '18:00' }, 'motion.area': [10, 10, 50, 40], 'power.mode': null });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.desired, { capture: { intervalMin: 30, window: { from: '06:00', to: '18:00' } }, motion: { enabled: true, area: [10, 10, 50, 40] }, video: { image: { whiteBalance: 'cloudy' } }, power: { mode: null } });
    const bad = settings.toDesired({ 'capture.intervalMin': 0, 'motion.enabled': 'yes', 'video.image.effect': 'neon', 'capture.window': { from: '25:00', to: '06:00' }, 'motion.area': [60, 0, 50, 10], 'net.ssid': 'x', 'capture.jpegQuality': 12.5 });
    assert.deepEqual(bad.errors.map(e => `${e.path}:${e.error}`).sort(), [
        'capture.intervalMin:out_of_range', 'capture.jpegQuality:not_integer', 'capture.window:bad_window', 'motion.area:bad_area',
        'motion.enabled:not_boolean', 'net.ssid:unknown_setting', 'video.image.effect:not_allowed'
    ]);
    assert.equal(settings.toDesired({}).errors[0].error, 'empty');
    // Night mode for live view (firmware 0.6.3, off by default): a boolean like the other switches
    assert.deepEqual(settings.toDesired({ 'video.image.nightMode': true }).desired, { video: { image: { nightMode: true } } });
    assert.equal(settings.toDesired({ 'video.image.nightMode': 'on' }).errors[0].error, 'not_boolean');
    // The network to use (0.9.2-rc.16) and the GPS satellites: choices, no credentials
    assert.deepEqual(settings.toDesired({ 'network.prefer': '4g', 'gps.systems': 'gps+bds' }).desired, { network: { prefer: '4g' }, gps: { systems: 'gps+bds' } });
    assert.equal(settings.toDesired({ 'network.prefer': 'lte' }).errors[0].error, 'not_allowed');
    assert.equal(settings.toDesired({ 'network.ssid': 'x' }).errors[0].error, 'unknown_setting');
    // Night sleep: a switch and a window across midnight that cannot be "all day"
    assert.deepEqual(settings.toDesired({ 'power.nightSleep': false, 'power.nightWindow': { from: '19:00', to: '05:30' } }).desired,
        { power: { nightSleep: false, nightWindow: { from: '19:00', to: '05:30' } } });
    assert.equal(settings.toDesired({ 'power.nightWindow': null }).errors[0].error, 'not_nullable');
    assert.equal(settings.toDesired({ 'power.nightWindow': { from: '18:00', to: '18:00' } }).errors[0].error, 'bad_window');
    assert.deepEqual(settings.FIELDS.find(f => f.path === 'power.nightWindow').default, { from: '18:00', to: '06:00' });
    // Adaptive interval: a switch; the interval in use comes back from the camera
    assert.deepEqual(settings.toDesired({ 'power.adaptive': false }).desired, { power: { adaptive: false } });
    assert.equal(settings.toDesired({ 'power.adaptive': 'on' }).errors[0].error, 'not_boolean');
    const v = settings.view({ device: { shadow: { reported: { capture: { intervalMin: 30, effectiveIntervalMin: 120 }, power: { adaptive: true } } } } });
    assert.equal(v.info.effectiveIntervalMin, 120);
    assert.equal(v.values['power.adaptive'].reported, true);
    assert.equal(settings.view({}).info.effectiveIntervalMin, null, 'older firmware: not reported');
});

test('device settings: the owner reads applied and pending values and changes them; others and other cameras cannot', async () => {
    const owner = await createUser({ role: 'user', email: 'settings-owner@example.test' });
    const stranger = await createUser({ role: 'user', email: 'settings-other@example.test' });
    await createCamera(owner, {
        deviceSerial: 'ESP0A1B2C3D4E5F', platform: 'camos', status: 1, captureIntervalMinutes: 60,
        device: { thingName: 'ESP0A1B2C3D4E5F', fw: '0.5.0', shadow: { reported: { capture: { intervalMin: 60 }, motion: { enabled: false }, errors: [] }, desired: { capture: { intervalMin: 60 } } } }
    });
    await createCamera(owner, { deviceSerial: 'BE4111159', platform: 'ezviz', status: 1 });
    const iot = fakeIot();
    aws.setClient('iotData', iot);
    try {
        const read = await json(await request('/api/cameras/ESP0A1B2C3D4E5F/device-settings', { as: owner }));
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert.ok(read.body.fields.some(f => f.path === 'motion.sensitivity'));
        assert.deepEqual(read.body.values['capture.intervalMin'], { reported: 60, desired: 60, pending: false });
        assert.equal(read.body.values['motion.enabled'].reported, false);

        const put = (as, changes) => request('/api/cameras/ESP0A1B2C3D4E5F/device-settings', { method: 'PUT', as, body: { changes } }).then(json);
        const bad = await put(owner, { 'capture.intervalMin': 5000 });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.code, 'BAD_SETTINGS');
        assert.equal(iot.calls.length, 0, 'nothing sent for a bad value');

        const done = await put(owner, { 'capture.intervalMin': 30, 'motion.enabled': true });
        assert.equal(done.status, 200, JSON.stringify(done.body));
        assert.deepEqual(done.body.values['capture.intervalMin'], { reported: 60, desired: 30, pending: true });
        const shadow = JSON.parse(iot.calls.find(c => c.name === 'UpdateThingShadowCommand').input.payload.toString()).state.desired;
        assert.deepEqual(shadow, { capture: { intervalMin: 30 }, motion: { enabled: true } });
        const toCamera = iot.calls.find(c => c.name === 'PublishCommand' && c.input.topic === 'camos/ESP0A1B2C3D4E5F/shadow/desired');
        assert.equal(JSON.parse(toCamera.input.payload.toString()).motion.enabled, true);
        const cam = await models.Camera.findOne({ deviceSerial: 'ESP0A1B2C3D4E5F' }).lean();
        assert.equal(cam.captureIntervalMinutes, 30, 'FlyBot schedule follows');

        assert.equal((await put(stranger, { 'motion.enabled': false })).status, 404);
        assert.equal((await json(await request('/api/cameras/BE4111159/device-settings', { as: owner }))).body.code, 'NOT_SUPPORTED');
    } finally {
        aws.setClient('iotData', null);
    }
});

test('camosSettings: photo sizes come from the camera; flip and mirror are settings', () => {
    const v = settings.view({ device: { shadow: { reported: { camera: { sensor: 'OV5640', maxW: 2592, maxH: 1944, photoSizes: [[640, 480], [2592, 1944]] } } } } });
    assert.deepEqual(v.fields.find(f => f.path === 'capture.resolution').values, ['max', '640x480', '2592x1944']);
    assert.deepEqual(v.camera, { sensor: 'OV5640', maxW: 2592, maxH: 1944 });
    assert.deepEqual(settings.view({}).fields.find(f => f.path === 'capture.resolution').values[0], 'max');
    const ok = settings.toDesired({ 'capture.resolution': '2592x1944', 'video.image.vflip': true, 'video.image.hmirror': false });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.desired, { capture: { resolution: '2592x1944' }, video: { image: { vflip: true, hmirror: false } } });
    assert.equal(settings.toDesired({ 'capture.resolution': 'huge' }).errors[0].error, 'not_allowed');
});

test('device actions: valid requests become RPCs; an offline camera and bad values are refused; errors only for form fields', async () => {
    const { deviceActionRequest } = require('../src/controllers/cameraController');
    assert.deepEqual(deviceActionRequest({ action: 'restart' }), { method: 'reboot', params: {} });
    assert.deepEqual(deviceActionRequest({ action: 'locate' }), { method: 'gps.fix', params: { timeoutS: 300 }, noWait: true });
    assert.deepEqual(deviceActionRequest({ action: 'apn', apn: ' m-wap ' }), { method: 'net.set', params: { cellular: { apn: 'm-wap' } } });
    assert.deepEqual(deviceActionRequest({ action: 'wifi', ssid: 'Farm', password: 'secret12' }), { method: 'net.set', params: { wifi: { ssid: 'Farm', password: 'secret12' } } });
    assert.equal(deviceActionRequest({ action: 'wifi', ssid: 'Farm', password: 'short' }).error, 'BAD_PASSWORD');
    assert.equal(deviceActionRequest({ action: 'apn', apn: 'bad apn!' }).error, 'BAD_APN');
    assert.equal(deviceActionRequest({ action: 'factory_reset' }).error, 'BAD_ACTION', 'no factory reset from FlyBot');

    const owner = await createUser({ role: 'user', email: 'action-owner@example.test' });
    await createCamera(owner, {
        deviceSerial: 'ESP0A1B2C3D4E60', platform: 'camos', status: 0,
        device: { thingName: 'ESP0A1B2C3D4E60', fw: '0.8.0', net: '4g', operator: 'MobiFone', shadow: { reported: { errors: [
            { path: 'video.image.wdr', code: 'NOT_SUPPORTED' }, { path: 'capture.requestNow', code: 'NOT_SUPPORTED' }, { path: 'video.image.brightness', code: 'BAD_VALUE' }
        ] } } }
    });
    const iot = fakeIot();
    aws.setClient('iotData', iot);
    try {
        const off = await json(await request('/api/cameras/ESP0A1B2C3D4E60/device-action', { method: 'POST', as: owner, body: { action: 'restart' } }));
        assert.equal(off.status, 409);
        assert.equal(off.body.code, 'OFFLINE');
        assert.equal(iot.calls.length, 0, 'nothing sent to an offline camera');
        // A GPS fix is kept for the camera's next connection instead, and sent once when it reports in
        const queued = await json(await request('/api/cameras/ESP0A1B2C3D4E60/device-action', { method: 'POST', as: owner, body: { action: 'locate' } }));
        assert.equal(queued.status, 202);
        assert.equal(queued.body.queued, true);
        assert.equal(iot.calls.length, 0, 'still nothing sent while it is away');
        assert.ok((await models.Camera.findOne({ deviceSerial: 'ESP0A1B2C3D4E60' }).lean()).device.locateRequestedAt);
        const camos = require('../src/platforms/camos');
        await camos.handleMessage('camos/ESP0A1B2C3D4E60/state', { v: 1, online: true, fw: '0.8.0' });
        await camos.handleMessage('camos/ESP0A1B2C3D4E60/state', { v: 1, online: true, fw: '0.8.0' });
        const fixes = iot.calls.filter(c => String(c.input?.topic || '').endsWith('/rpc/req') && JSON.parse(Buffer.from(c.input.payload).toString()).method === 'gps.fix');
        assert.equal(fixes.length, 1, 'sent once at the next state message');
        const cam = (await models.Camera.findOne({ deviceSerial: 'ESP0A1B2C3D4E60' }).lean()).device;
        assert.equal(cam.locateRequestedAt, undefined);
        assert.ok(new Date(cam.locatingUntil) > new Date(), 'and the camera is marked locating');
        await models.Camera.updateOne({ deviceSerial: 'ESP0A1B2C3D4E60' }, { $set: { status: 0 } });
        const read = await json(await request('/api/cameras/ESP0A1B2C3D4E60/device-settings', { as: owner }));
        assert.deepEqual(read.body.errors.map(e => e.path), ['video.image.brightness'], 'only the errors of form fields');
        assert.equal(read.body.info.net, '4g');
        assert.equal(read.body.info.operator, 'MobiFone');
    } finally {
        aws.setClient('iotData', null);
    }
});
