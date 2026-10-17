const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.IOT_ENDPOINT = 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com';
process.env.KVS_VIEWER_ROLE_ARN = 'arn:aws:iam::123456789012:role/flybot-kvs-viewer';

const { models, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const env = require('../src/config/env');
const platforms = require('../src/platforms');
const aws = require('../src/platforms/aws');
const camos = require('../src/platforms/camos');
const kinesis = require('../src/platforms/kinesis');
const ezviz = require('../src/platforms/ezviz');
const ezvizService = require('../src/services/ezvizService');
const { captureAndSaveSnapshot, autoCaptureDueCameras } = require('../src/cron/captureJob');

before(startDb);
after(stopDb);
beforeEach(clearDb);

/** A fake AWS client: records every command and answers from `answers` by command name. */
function fakeClient(answers = {}) {
    const calls = [];
    return {
        calls,
        async send(command) {
            const name = aws.commandName(command);
            calls.push({ name, input: command.input });
            const answer = answers[name];
            if (answer instanceof Error) throw answer;
            return typeof answer === 'function' ? answer(command.input) : (answer ?? {});
        }
    };
}
const shadowPayload = (state) => ({ payload: Buffer.from(JSON.stringify({ state })) });
/** Wait until the fake client has seen at least n commands. */
async function untilCalls(client, n, ms = 3000) {
    const until = Date.now() + ms;
    while (client.calls.length < n && Date.now() < until) await new Promise(r => setTimeout(r, 10));
}

test('every platform implements the same interface, and cameras default to ezviz', () => {
    for (const name of platforms.PLATFORMS) {
        const adapter = platforms.get(name);
        for (const fn of platforms.INTERFACE) assert.equal(typeof adapter[fn], 'function', `${name}.${fn}`);
        assert.equal(adapter.PLATFORM, name);
    }
    assert.equal(platforms.platformOf({}), 'ezviz');
    assert.equal(platforms.platformOf({ platform: 'camos' }), 'camos');
    assert.equal(platforms.platformOf({ platform: 'nope' }), 'ezviz');
    assert.throws(() => platforms.get('nope'), /Unknown camera platform/);
});

test('ezviz: the adapter wraps the EZVIZ service as before (no image = null, schedule in FlyBot)', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'EZ1', status: 1 });
    assert.equal(await (await platforms.forSerial('EZ1')).PLATFORM, 'ezviz');
    assert.equal(await (await platforms.forSerial('UNKNOWN')).PLATFORM, 'ezviz', 'an unknown serial still goes to EZVIZ');
    // dbHelpers stubs captureDevice as "device offline"
    assert.equal(await ezviz.snapshot('EZ1'), null);
    assert.equal(await captureAndSaveSnapshot('EZ1'), null);
    const original = ezvizService.captureDevice;
    ezvizService.captureDevice = async () => ({ code: '200', data: { picUrl: 'http://127.0.0.1:9/pic.jpg' } });
    try {
        // The download is attempted from the pic link (refused here: nothing listens on port 9)
        await assert.rejects(ezviz.snapshot('EZ1'));
    } finally {
        ezvizService.captureDevice = original;
    }
    const schedule = await ezviz.setCaptureSchedule('EZ1', 60);
    assert.deepEqual(schedule, { platform: 'ezviz', minutes: 60, applied: 'flybot' });
    assert.equal((await models.Camera.findOne({ deviceSerial: 'EZ1' })).captureIntervalMinutes, 60);
    await assert.rejects(ezviz.setCaptureSchedule('EZ1', 7), /one of/);
    const status = await ezviz.getStatus('EZ1');
    assert.equal(status.online, true);
    assert.equal(status.power.mode, 'powered');
});

test('camos: shadow and RPC go through the IoT data plane; snapshot waits for the device upload', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ESP1', platform: 'camos', status: 1, device: { lastSeenAt: new Date(), tokenHash: 'x' } });
    const iot = fakeClient({
        GetThingShadowCommand: shadowPayload({ reported: { capture: { intervalMin: 30 }, power: { mode: 'battery' } } }),
        UpdateThingShadowCommand: (input) => shadowPayload(JSON.parse(input.payload.toString()).state)
    });
    aws.setClient('iotData', iot);
    try {
        const shadow = await camos.getShadow('ESP1');
        assert.equal(shadow.reported.power.mode, 'battery');
        assert.equal(iot.calls[0].input.thingName, 'ESP1');

        const schedule = await camos.setCaptureSchedule('ESP1', 60);
        assert.equal(schedule.applied, 'shadow');
        const update = iot.calls.find(c => c.name === 'UpdateThingShadowCommand');
        assert.deepEqual(JSON.parse(update.input.payload.toString()), { state: { desired: { capture: { intervalMin: 60 } } } });
        const cam = await models.Camera.findOne({ deviceSerial: 'ESP1' }).lean();
        assert.equal(cam.captureIntervalMinutes, 60);
        assert.deepEqual(cam.device.shadow.desired, { capture: { intervalMin: 60 } });

        // RPC without waiting: published on camos/<serial>/rpc/req
        const sent = await camos.rpc('ESP1', 'reboot');
        assert.equal(sent.sent, true);
        const publish = iot.calls.find(c => c.name === 'PublishCommand');
        assert.equal(publish.input.topic, 'camos/ESP1/rpc/req');
        const body = JSON.parse(publish.input.payload.toString());
        assert.equal(body.method, 'reboot');
        assert.equal(body.v, 1);

        // RPC with waiting: the answer on rpc/res resolves it
        const waiting = camos.rpc('ESP1', 'gps.fix', {}, { wait: true, timeoutMs: 2000 });
        const req = JSON.parse(iot.calls.at(-1).input.payload.toString());
        await camos.handleMessage('camos/ESP1/rpc/res', { v: 1, id: req.id, ok: true, result: { lat: 10.9 } });
        assert.deepEqual(await waiting, { ok: true, result: { lat: 10.9 }, error: null });
        await assert.rejects(camos.rpc('ESP1', 'reboot', {}, { wait: true, timeoutMs: 30 }), /did not answer/);

        // snapshot: snapshot.now is published, then the device API's upload resolves it
        const published = iot.calls.length;
        const shot = camos.snapshot('ESP1', { timeoutMs: 2000 });
        await untilCalls(iot, published + 1);
        const last = JSON.parse(iot.calls.at(-1).input.payload.toString());
        assert.equal(last.method, 'snapshot.now');
        const doc = { _id: 'fake', deviceSerial: 'ESP1' };
        assert.equal(camos.snapshotArrived('ESP1', doc), true);
        assert.deepEqual(await shot, { snapshot: doc });
        assert.equal(camos.snapshotArrived('ESP1', doc), false, 'nobody waiting');
        // Through the capture pipeline the stored snapshot is returned as is
        const n2 = iot.calls.length;
        const shot2 = captureAndSaveSnapshot('ESP1');
        await untilCalls(iot, n2 + 1);
        camos.snapshotArrived('ESP1', doc);
        assert.equal(await shot2, doc);

        // A sleeping camera: nothing published, the request is left in the shadow
        await models.Camera.updateOne({ deviceSerial: 'ESP1' }, { $set: { 'device.sleeping': true, 'device.wakeAt': new Date(Date.now() + 3600 * 1000) } });
        const before = iot.calls.length;
        assert.equal(await camos.snapshot('ESP1', { timeoutMs: 50 }), null);
        const desired = JSON.parse(iot.calls.at(-1).input.payload.toString()).state.desired;
        assert.ok(desired.capture.requestNow > 0);
        assert.equal(iot.calls.slice(before).some(c => c.name === 'PublishCommand'), false);
        const status = await camos.getStatus('ESP1');
        assert.equal(status.online, false);
        assert.equal(status.sleeping, true);
        assert.ok(status.nextWakeAt instanceof Date);
    } finally {
        aws.setClient('iotData', null);
    }
});

test('camos: messages from the camera update its status, power, battery and sleep (MQTT or IoT rule)', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ESP2', platform: 'camos', status: 0, device: { thingName: 'ESP2' } });
    const r1 = await camos.handleMessage('camos/ESP2/state', Buffer.from(JSON.stringify({ v: 1, online: true, fw: '0.1.0', net: { type: '4g', rssi: -70 }, gps: { lat: 10.97, lon: 106.49, fix: true }, battery: { mv: 3900, pct: 72, charging: true }, power: { mode: 'battery' } })));
    assert.equal(r1.online, true);
    let cam = await models.Camera.findOne({ deviceSerial: 'ESP2' }).lean();
    assert.equal(cam.status, 1);
    assert.equal(cam.device.fw, '0.1.0');
    assert.equal(cam.device.net, '4g');
    assert.equal(cam.device.rssi, -70);
    assert.deepEqual(cam.device.location, { lat: 10.97, lng: 106.49 });
    assert.deepEqual(cam.device.battery, { mv: 3900, pct: 72, charging: true });
    assert.equal(cam.device.power.mode, 'battery');
    assert.equal((await camos.getStatus('ESP2')).online, true);

    const wakeAt = Date.now() + 30 * 60 * 1000;
    const r2 = await camos.handleMessage('camos/ESP2/event', { v: 1, type: 'goodbye', sleeping: true, wakeAt });
    assert.equal(r2.type, 'goodbye');
    const status = await camos.getStatus('ESP2');
    assert.equal(status.sleeping, true);
    assert.equal(status.online, false);
    assert.equal(new Date(status.wakeAt).getTime(), wakeAt);
    assert.equal(new Date(status.nextWakeAt).getTime(), wakeAt);

    // Lifecycle events and the reported shadow
    await camos.handleMessage('$aws/events/presence/connected/ESP2', { clientId: 'ESP2' });
    cam = await models.Camera.findOne({ deviceSerial: 'ESP2' }).lean();
    assert.equal(cam.status, 1);
    assert.equal(cam.device.sleeping, false);
    const r3 = await camos.handleMessage('$aws/things/ESP2/shadow/update/accepted', { state: { reported: { capture: { intervalMin: 120 }, power: { mode: 'powered' }, live: { requested: false }, kvs: { channelName: 'cam-ESP2' } } } });
    assert.equal(r3.kind, 'shadow');
    cam = await models.Camera.findOne({ deviceSerial: 'ESP2' }).lean();
    assert.equal(cam.captureIntervalMinutes, 120);
    assert.equal(cam.device.power.mode, 'powered');
    assert.equal(cam.device.liveRequested, false);
    assert.equal(cam.device.shadow.reported.kvs.channelName, 'cam-ESP2');
    await camos.handleMessage('$aws/events/presence/disconnected/ESP2', {});
    assert.equal((await models.Camera.findOne({ deviceSerial: 'ESP2' }).lean()).status, 0);

    assert.equal(await camos.handleMessage('other/topic', {}), null);
    assert.equal((await camos.handleMessage('camos/NOPE/state', 'not json')).ignored, 'bad payload');
    assert.equal((await camos.handleMessage('$aws/events/presence/connected/UNKNOWN', {})).ignored, 'unknown camera');
    // EZVIZ cameras are never touched by IoT messages
    await createCamera(owner, { deviceSerial: 'EZ9', status: 1 });
    await camos.handleMessage('camos/EZ9/state', { online: false });
    assert.equal((await models.Camera.findOne({ deviceSerial: 'EZ9' }).lean()).status, 1);
});

test('camos: the snapshot timeline is its playback, and the capture cron leaves CamOS cameras alone', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ESP3', platform: 'camos', status: 1, lastCaptureAt: null });
    await createCamera(owner, { deviceSerial: 'EZ3', status: 1, lastCaptureAt: null });
    await models.Snapshot.create({ deviceSerial: 'ESP3', imageUrl: 'x', s3Key: 'snapshots/ESP3/a.jpg', aiProcessed: true, aiResults: { summary: { fruit_fly: 4 } }, trigger: 'schedule' });
    const timeline = await camos.playback('ESP3', {});
    assert.equal(timeline.kind, 'snapshots');
    assert.equal(timeline.items.length, 1);
    assert.equal(timeline.items[0].count, 4);
    assert.equal(timeline.items[0].imageKey, 'snapshots/ESP3/a.jpg');

    const run = await autoCaptureDueCameras();
    assert.equal(run.cameras, 1, 'only the EZVIZ camera was due');
    assert.equal((await models.Camera.findOne({ deviceSerial: 'ESP3' }).lean()).lastCaptureAt, null);
    assert.ok((await models.Camera.findOne({ deviceSerial: 'EZ3' }).lean()).lastCaptureAt);
});

test('kinesis: one channel per camera, viewer config with 15-minute credentials from the viewer role', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ESP4', platform: 'camos', status: 1, device: { lastSeenAt: new Date(), power: { mode: 'powered' } } });
    const notFound = Object.assign(new Error('no such channel'), { name: 'ResourceNotFoundException' });
    const kv = fakeClient({
        DescribeSignalingChannelCommand: notFound,
        CreateSignalingChannelCommand: { ChannelARN: 'arn:aws:kinesisvideo:ap-southeast-2:123:channel/cam-ESP4/1' },
        GetSignalingChannelEndpointCommand: { ResourceEndpointList: [{ Protocol: 'WSS', ResourceEndpoint: 'wss://v-abc.kinesisvideo.ap-southeast-2.amazonaws.com' }, { Protocol: 'HTTPS', ResourceEndpoint: 'https://r-abc.kinesisvideo.ap-southeast-2.amazonaws.com' }] }
    });
    const sts = fakeClient({
        AssumeRoleCommand: { Credentials: { AccessKeyId: 'ASIAXYZ', SecretAccessKey: 'secret', SessionToken: 'tok', Expiration: new Date(Date.now() + 900 * 1000) } }
    });
    const iot = fakeClient({ UpdateThingShadowCommand: shadowPayload({ desired: {} }) });
    aws.setClient('kinesisVideo', kv);
    aws.setClient('sts', sts);
    aws.setClient('iotData', iot);
    try {
        const channel = await kinesis.ensureChannel('ESP4');
        assert.deepEqual(channel, { channelName: 'cam-ESP4', channelArn: 'arn:aws:kinesisvideo:ap-southeast-2:123:channel/cam-ESP4/1', created: true });
        assert.equal(kv.calls.map(c => c.name).join(','), 'DescribeSignalingChannelCommand,CreateSignalingChannelCommand');
        // Stored on the camera: the next call does not ask KVS again
        assert.equal((await kinesis.ensureChannel('ESP4')).created, false);
        assert.equal(kv.calls.length, 2);

        const session = await camos.liveSession('ESP4', { user: { id: String(owner._id) }, minutes: 5 });
        assert.equal(session.platform, 'kinesis');
        assert.equal(session.channelName, 'cam-ESP4');
        assert.equal(session.region, env.AWS_REGION);
        assert.equal(session.signalingEndpoints.WSS, 'wss://v-abc.kinesisvideo.ap-southeast-2.amazonaws.com');
        assert.match(session.iceServers[0].urls, /^stun:stun\.kinesisvideo\./);
        assert.match(session.clientId, /^viewer-/);
        assert.equal(session.credentials.accessKeyId, 'ASIAXYZ');
        assert.ok(session.expiresAt);
        const assume = sts.calls.find(c => c.name === 'AssumeRoleCommand');
        assert.equal(assume.input.DurationSeconds, 900);
        assert.match(assume.input.Policy, /cam-ESP4/);
        // The camera is awake and powered: live.start was sent and live.requested written to the shadow
        assert.equal(session.live.sent, true);
        assert.equal(JSON.parse(iot.calls.find(c => c.name === 'PublishCommand').input.payload.toString()).method, 'live.start');
        assert.deepEqual(JSON.parse(iot.calls.find(c => c.name === 'UpdateThingShadowCommand').input.payload.toString()).state.desired.live, { requested: true, minutes: 5 });
        assert.equal((await models.Camera.findOne({ deviceSerial: 'ESP4' }).lean()).device.liveRequested, true);

        // Without the viewer role nothing is handed out
        const role = env.KVS_VIEWER_ROLE_ARN;
        env.KVS_VIEWER_ROLE_ARN = '';
        await assert.rejects(kinesis.liveSession('ESP4', {}), (err) => err.code === 'LIVE_NOT_CONFIGURED' && err.status === 503);
        env.KVS_VIEWER_ROLE_ARN = role;
    } finally {
        aws.setClient('kinesisVideo', null);
        aws.setClient('sts', null);
        aws.setClient('iotData', null);
    }
});

test('camos: a camera that reports no cloud live view gets no viewer session, and its local page when it has one', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, {
        deviceSerial: 'ESPF85B1000001', platform: 'camos', status: 1,
        device: { lastSeenAt: new Date(), fw: '0.4.2', power: { mode: 'powered' }, shadow: { reported: { live: { supported: false, requested: false } } } }
    });
    const kv = fakeClient({});
    const iot = fakeClient({});
    aws.setClient('kinesisVideo', kv);
    aws.setClient('iotData', iot);
    try {
        const session = await camos.liveSession('ESPF85B1000001', { user: { id: String(owner._id) }, minutes: 5 });
        assert.equal(session.supported, false);
        assert.equal(session.localUrl, 'http://flybot-000001.local/');
        assert.equal(session.credentials, undefined, 'no viewer credentials');
        assert.equal(kv.calls.length, 0, 'KVS not asked');
        assert.equal(iot.calls.length, 0, 'no live request to the camera');
        assert.equal((await camos.getStatus('ESPF85B1000001')).liveSupported, false);
    } finally {
        aws.setClient('kinesisVideo', null);
        aws.setClient('iotData', null);
    }

    // Cameras that never report live.supported keep live view (AMB82), and only ESP firmware 0.4.1+ has a local name
    await createCamera(owner, { deviceSerial: 'AIC54F2000001', platform: 'camos', status: 1, device: { fw: '1.2.0' } });
    assert.equal((await camos.getStatus('AIC54F2000001')).liveSupported, true);
    assert.equal(camos.localConsoleUrl('AIC54F2000001', '1.2.0'), null);
    assert.equal(camos.localConsoleUrl('ESP32S3-0A1B2C', '0.4.0'), null);
    assert.equal(camos.localConsoleUrl('ESP32S3-0A1B2C', '0.4.1'), 'http://flybot-0a1b2c.local/');
    assert.equal(camos.localConsoleUrl('ESP32S3-0A1B2C', '0.10.0'), 'http://flybot-0a1b2c.local/');
    assert.equal(camos.localConsoleUrl('ESP32S3-0A1B2C', null), null);
});

test('camos: a camera without live credentials gets the credential provider and role alias once, through the shadow', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ESPLIVE00001', platform: 'camos', status: 1, device: { thingName: 'ESPLIVE00001', kvsChannelName: 'cam-ESPLIVE00001' } });
    const iot = fakeClient({ UpdateThingShadowCommand: shadowPayload({ desired: {} }) });
    aws.setClient('iotData', iot);
    const saved = { host: env.IOT_CREDENTIALS_ENDPOINT, alias: env.IOT_ROLE_ALIAS };
    try {
        env.IOT_CREDENTIALS_ENDPOINT = '';
        env.IOT_ROLE_ALIAS = '';
        await camos.handleMessage('camos/ESPLIVE00001/shadow/reported', { live: { supported: false } });
        assert.equal(iot.calls.filter(c => c.name === 'UpdateThingShadowCommand').length, 0, 'nothing to offer without them');
        assert.equal(camos.liveCredentials(), null);

        env.IOT_CREDENTIALS_ENDPOINT = 'abc.credentials.iot.ap-southeast-2.amazonaws.com';
        env.IOT_ROLE_ALIAS = 'flybot-camera-kvs-test';
        assert.deepEqual(camos.liveCredentials(), { credentialsEndpoint: 'abc.credentials.iot.ap-southeast-2.amazonaws.com', roleAlias: 'flybot-camera-kvs-test' });
        await camos.handleMessage('camos/ESPLIVE00001/shadow/reported', { live: { supported: false } });
        const updates = iot.calls.filter(c => c.name === 'UpdateThingShadowCommand');
        assert.equal(updates.length, 1);
        assert.deepEqual(JSON.parse(updates[0].input.payload.toString()).state.desired.kvs, {
            region: env.AWS_REGION, channelName: 'cam-ESPLIVE00001',
            credentialsEndpoint: 'abc.credentials.iot.ap-southeast-2.amazonaws.com', roleAlias: 'flybot-camera-kvs-test'
        });
        // Once per alias, and never to a camera that already streams
        await camos.handleMessage('camos/ESPLIVE00001/shadow/reported', { live: { supported: false } });
        await camos.handleMessage('$aws/things/ESPLIVE00001/shadow/update/accepted', { state: { reported: { live: { supported: true } } } });
        assert.equal(iot.calls.filter(c => c.name === 'UpdateThingShadowCommand').length, 1);
    } finally {
        env.IOT_CREDENTIALS_ENDPOINT = saved.host;
        env.IOT_ROLE_ALIAS = saved.alias;
        aws.setClient('iotData', null);
    }
});

test('iotEvents: the WebSocket URL is SigV4-signed for iotdevicegateway, with the session token after the signature', async () => {
    const iotEvents = require('../src/platforms/iotEvents');
    const url = await iotEvents.presignUrl({
        endpoint: 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com',
        region: 'ap-southeast-2',
        credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret', sessionToken: 'session-token' },
        now: new Date('2026-10-16T08:00:00Z')
    });
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'wss:');
    assert.equal(parsed.host, 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com');
    assert.equal(parsed.pathname, '/mqtt');
    assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(parsed.searchParams.get('X-Amz-Credential'), 'AKIATEST/20261016/ap-southeast-2/iotdevicegateway/aws4_request');
    assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.match(parsed.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
    assert.ok(url.endsWith('&X-Amz-Security-Token=session-token'), 'token appended last, unsigned');
    assert.equal(iotEvents.isEnabled(), true);
    const creds = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' };
    assert.equal(await iotEvents.start({ mqttModule: { connect: () => { throw new Error('not in tests'); } }, credentials: creds }).catch(e => e.message), 'not in tests', 'start connects once the URL is signed');
    iotEvents.stop();
});
