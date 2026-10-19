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
