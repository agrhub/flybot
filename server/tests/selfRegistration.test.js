const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Must be set before config/env loads (dbHelpers loads it)
process.env.AI_PROVIDER = 'opencv-lambda';
process.env.PHOTOS_BY_REFERENCE = 'true';
process.env.S3_BUCKET_NAME = 'flybot-photos-test';
process.env.VISION_LAMBDA_URL = 'http://127.0.0.1:9/invoke';
process.env.IOT_ENDPOINT = 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com';
process.env.APP_BASE_URL = 'https://flybot.example.test';
process.env.IOT_THING_TYPE = 'camos-camera';
process.env.IOT_POLICY_NAME = 'camos-camera';
process.env.REGISTER_MAX_PER_IP_HOUR = '3';
process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, json } = require('./dbHelpers');
const env = require('../src/config/env');
const aws = require('../src/platforms/aws');
const { s3Client } = require('../src/config/s3');
const registration = require('../src/services/registrationService');
const timezoneService = require('../src/services/timezoneService');
const visionLambda = require('../src/services/visionLambda');

// ---------- Fakes: AWS IoT (control + data plane), KVS, the vision Lambda, S3 deletes ----------
let iotCalls;
let iotFail; // command name -> error to throw
let shadowUpdates;
let kvsCalls;
let lambdaCalls;
let s3Deletes;
let certSeq;

const awsErr = (name) => Object.assign(new Error(name), { name });
const fakeIot = {
    send: async (command) => {
        const name = aws.commandName(command);
        iotCalls.push({ name, input: command.input });
        if (iotFail[name]) throw iotFail[name];
        if (name === 'CreateCertificateFromCsrCommand') {
            const id = `c${String(++certSeq).padStart(63, '0')}`;
            return { certificateArn: `arn:aws:iot:ap-southeast-2:123456789012:cert/${id}`, certificateId: id, certificatePem: `-----BEGIN CERTIFICATE-----\nCERT${certSeq}\n-----END CERTIFICATE-----\n` };
        }
        if (name === 'DescribeThingCommand') return { thingName: command.input.thingName, attributes: iotFail.describeAttributes || {} };
        return {};
    }
};
const fakeIotData = {
    send: async (command) => {
        const name = aws.commandName(command);
        if (name === 'UpdateThingShadowCommand') shadowUpdates.push({ thingName: command.input.thingName, desired: JSON.parse(Buffer.from(command.input.payload).toString()).state.desired });
        return {};
    }
};
const fakeKvs = {
    send: async (command) => {
        const name = aws.commandName(command);
        kvsCalls.push({ name, input: command.input });
        if (name === 'DescribeSignalingChannelCommand') throw awsErr('ResourceNotFoundException');
        if (name === 'CreateSignalingChannelCommand') return { ChannelARN: `arn:aws:kinesisvideo:ap-southeast-2:123456789012:channel/${command.input.ChannelName}/1` };
        return {};
    }
};

let stub;
function stubHandler(req, res) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = JSON.parse(raw);
        lambdaCalls.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            v: 1, traceId: `tr_${lambdaCalls.length}`, model: { name: 'yolo26n', version: 't', engine: 'opencv-5' },
            counts: { total: 4, byClass: { fruit_fly: 4 } }, boxes: [], quality: { ok: true, flags: [] },
            proposals: [{ id: 'p1', action: 'capture_now', params: {}, reason: 'test', confidence: 0.9 }],
            trace: { planner: 'rule', steps: [], ms: 5 }, evidence: {}, timings: { totalMs: 5 }
        }));
    });
}

const originalS3Send = s3Client.send;
before(async () => {
    await startDb();
    stub = http.createServer(stubHandler);
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    env.VISION_LAMBDA_URL = `http://127.0.0.1:${stub.address().port}/invoke`;
    visionLambda.setRetryDelay(60000);
    aws.setClient('iot', fakeIot);
    aws.setClient('iotData', fakeIotData);
    aws.setClient('kinesisVideo', fakeKvs);
    s3Client.send = async (command) => {
        if (aws.commandName(command) === 'DeleteObjectCommand') s3Deletes.push(command.input.Key);
        return originalS3Send(command);
    };
});
after(async () => {
    aws.setClient('iot', null);
    aws.setClient('iotData', null);
    aws.setClient('kinesisVideo', null);
    s3Client.send = originalS3Send;
    await new Promise(resolve => stub.close(resolve));
    await stopDb();
});
beforeEach(async () => {
    await clearDb();
    iotCalls = [];
    iotFail = {};
    shadowUpdates = [];
    kvsCalls = [];
    lambdaCalls = [];
    s3Deletes = [];
    certSeq = 0;
    registration.resetClaimLocks();
    env.DEMO_MAX_UNCLAIMED = 200;
    env.SELF_REGISTRATION = true;
    require('../src/services/planService').clearCache();
});

// ---------- Helpers ----------

const CSR = (seed = 'a') => `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.concat([Buffer.from([0x30, 0x82, 0x01, 0x00]), Buffer.alloc(120, seed)]).toString('base64')}\n-----END CERTIFICATE REQUEST-----`;
let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq % 250}`;
const body = (extra = {}) => ({ v: 1, serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY', model: 'AIC-FREENOVE-S3CAM', fw: '0.3.0', csr: CSR(), ...extra });
const register = (b = body(), ip = freshIp()) => request('/api/device/register', { method: 'POST', body: b, headers: { 'X-Forwarded-For': ip } }).then(json);

const JPEG = (size = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7), Buffer.from([0xff, 0xd9])]);
function multipart(image, meta) {
    const boundary = 'ESP32Boundary7MA4YWxkTrZu0gW';
    const parts = [Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="s.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), image, Buffer.from('\r\n')])];
    if (meta) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n`));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}
async function upload(serial, token, meta = { v: 1, trigger: 'schedule' }) {
    const { body: raw, headers } = multipart(JPEG(), meta);
    return json(await request('/api/device/snapshot', { method: 'POST', body: raw, headers: { ...headers, 'X-Device-Serial': serial, 'X-Device-Token': token } }));
}
const settle = () => new Promise(r => setTimeout(r, 150));
/** Background work (analysis, shadow writes) on a busy machine: wait until it shows. */
async function waitFor(check, ms = 5000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await check()) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}
const claim = (as, b) => request('/api/cameras/claim', { method: 'POST', as, body: b }).then(json);

// ---------- Register ----------

test('register: signs the CSR, makes thing + policy + principal + channel, returns the contract body once', async () => {
    const res = await register();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const b = res.body;
    assert.equal(b.ok, true);
    assert.match(b.certificatePem, /BEGIN CERTIFICATE/);
    assert.match(b.deviceToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(b.iot, { endpoint: 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com', thingName: 'ESPF85B1B92877C' });
    assert.deepEqual(b.kvs, { region: 'ap-southeast-2', channelName: 'cam-ESPF85B1B92877C' });
    assert.equal(b.claimUrl, `${env.APP_BASE_URL}/claim?sn=ESPF85B1B92877C`);
    assert.equal(b.claimed, false);
    assert.ok(!/PRIVATE KEY/.test(JSON.stringify(b)), 'no private key ever');

    const names = iotCalls.map(c => c.name);
    assert.deepEqual(names, ['CreateThingCommand', 'CreateCertificateFromCsrCommand', 'AttachPolicyCommand', 'AttachThingPrincipalCommand']);
    assert.equal(iotCalls[0].input.thingTypeName, 'camos-camera');
    assert.equal(iotCalls[1].input.setAsActive, true);
    assert.equal(iotCalls[1].input.certificateSigningRequest.trim(), CSR());
    assert.equal(iotCalls[2].input.policyName, 'camos-camera');
    assert.ok(kvsCalls.some(c => c.name === 'CreateSignalingChannelCommand' && c.input.ChannelName === 'cam-ESPF85B1B92877C'));

    const cam = await models.Camera.findOne({ deviceSerial: 'ESPF85B1B92877C' }).lean();
    assert.equal(cam.selfRegistered, true);
    assert.equal(cam.unclaimed, true);
    assert.equal(cam.userId, null);
    assert.equal(cam.platform, 'camos');
    assert.equal(cam.device.tokenHash, require('../src/services/deviceService').sha256(b.deviceToken));
    assert.ok(!JSON.stringify(cam).includes(b.deviceToken), 'the token itself is never stored');
    assert.ok(cam.device.certificateArn && cam.device.kvsChannelArn);
});

test('register: idempotent before the first connect (same certificate), 409 after it or with another code', async () => {
    const first = await register();
    const again = await register();
    assert.equal(again.status, 201);
    assert.equal(again.body.certificatePem, first.body.certificatePem, 'same certificate');
    assert.equal(iotCalls.filter(c => c.name === 'CreateCertificateFromCsrCommand').length, 1);
    // The newest token is the valid one
    assert.equal((await upload('ESPF85B1B92877C', first.body.deviceToken)).status, 401);

    const other = await register(body({ verifyCode: 'ABCDEF' }));
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'serial_taken');

    // First MQTT connection: no more re-registration
    await require('../src/platforms/camos').handleMessage('$aws/events/presence/connected/ESPF85B1B92877C', { clientId: 'ESPF85B1B92877C' });
    const late = await register();
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'serial_taken');
});

test('register: a serial an owner already has, or a thing that is not ours, is taken', async () => {
    const owner = await createUser({ role: 'manager' });
    await models.Camera.create({ deviceSerial: 'ESP0123456789AB', userId: owner._id, platform: 'camos', validateCode: '9WBYWY' });
    assert.equal((await register(body({ serial: 'ESP0123456789AB' }))).body.error, 'serial_taken');

    iotFail.CreateThingCommand = awsErr('ResourceAlreadyExistsException');
    const res = await register(body({ serial: 'ESPAAAAAAAAAAAA' }));
    assert.equal(res.status, 409);
    assert.equal(iotCalls.filter(c => c.name === 'CreateCertificateFromCsrCommand').length, 0, 'no certificate for a foreign thing');
    assert.equal(await models.Camera.countDocuments({ deviceSerial: 'ESPAAAAAAAAAAAA' }), 0);
});

test('register: bad input 400, capacity 503, AWS failure rolls back (certificate deleted, no camera)', async () => {
    for (const bad of [body({ serial: 'BE4089629' }), body({ serial: 'ESPF85B1B92877' }), body({ verifyCode: 'ILOU12' }), body({ csr: 'nope' }), body({ csr: `${CSR()}\n-----BEGIN EC PRIVATE KEY-----` }), body({ v: 2 })]) {
        assert.equal((await register(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    env.DEMO_MAX_UNCLAIMED = 0;
    const full = await register();
    assert.equal(full.status, 503);
    assert.equal(full.body.error, 'capacity');
    env.DEMO_MAX_UNCLAIMED = 200;

    iotFail.AttachThingPrincipalCommand = awsErr('AccessDeniedException');
    const failed = await register();
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'aws_failed');
    assert.equal(await models.Camera.countDocuments({}), 0);
    const names = iotCalls.map(c => c.name);
    assert.ok(names.includes('UpdateCertificateCommand') && names.includes('DeleteCertificateCommand'), names.join(','));
    assert.ok(names.includes('DeleteThingCommand'));

    env.SELF_REGISTRATION = false;
    assert.equal((await register()).status, 503);
});

test('register: rate limited per client IP', async () => {
    const ip = '198.51.100.7';
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await register(body({ serial: `ESP00000000000${i}` }), ip)).status);
    assert.deepEqual(statuses, [201, 201, 201, 429]);
});

// ---------- Unclaimed mode ----------

test('unclaimed: 1 photo an hour, rule planner only, no cards, hidden from every account; time and nextWakeAt', async () => {
    const reg = await register();
    const token = reg.body.deviceToken;
    const first = await upload('ESPF85B1B92877C', token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(new Date(first.body.nextWakeAt) - Date.now() > 55 * 60 * 1000, 'next wake in an hour');
    await settle();
    const second = await upload('ESPF85B1B92877C', token);
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'rate_limited');
    assert.ok(second.body.nextWakeAt);

    assert.ok(await waitFor(() => lambdaCalls.length >= 1), 'the photo was analyzed');
    assert.equal(lambdaCalls.length, 1);
    assert.equal(lambdaCalls[0].camera.claimed, false);
    assert.deepEqual(lambdaCalls[0].options, { planner: 'rule', llm: false });
    assert.equal(await models.SentinelProposal.countDocuments({}), 0, 'no confirm cards without an owner');
    const photo = await models.Snapshot.findOne({ deviceSerial: 'ESPF85B1B92877C' }).lean();
    assert.equal(photo.unclaimed, true);
    assert.ok(new Date(photo.expiresAt) - Date.now() > 23 * 3600 * 1000);

    const admin = await createUser({ role: 'admin' });
    const list = await json(await request('/api/user/cameras', { as: admin }));
    assert.ok(!JSON.stringify(list.body).includes('ESPF85B1B92877C'), 'not even an admin sees it');
    assert.equal((await request('/api/cameras/ESPF85B1B92877C/status', { as: admin })).status, 404);

    // Deep analysis needs a claimed camera
    const cam = await models.Camera.findOne({ deviceSerial: 'ESPF85B1B92877C' }).lean();
    await assert.rejects(() => visionLambda.deepAnalyze(photo, cam, { question: 'why?' }), /claimed camera/);
});

// ---------- Claim ----------

test('claim: moves the camera to the person, shadow claimed + interval, preview photo; 404 for anyone else after', async () => {
    const reg = await register();
    await upload('ESPF85B1B92877C', reg.body.deviceToken);
    await waitFor(() => lambdaCalls.length >= 1);
    const person = await createUser({ role: 'user', email: 'grower@example.test' });
    const res = await claim(person, { serial: 'espf85b1b92877c', verifyCode: '9wbywy', trapKind: 'sticky', captureIntervalMinutes: 60 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.camera.deviceSerial, 'ESPF85B1B92877C');
    assert.equal(res.body.camera.trapKind, 'sticky');
    assert.ok(res.body.preview?.snapshotId, 'the first preview photo');
    assert.ok(shadowUpdates.some(u => u.thingName === 'ESPF85B1B92877C' && u.desired.claimed === true && u.desired.capture?.intervalMin === 60));

    const cam = await models.Camera.findOne({ deviceSerial: 'ESPF85B1B92877C' }).lean();
    assert.equal(String(cam.userId), String(person._id));
    assert.equal(cam.unclaimed, false);
    const personal = await models.Organization.findOne({ kind: 'personal', 'members.userId': person._id }).lean();
    assert.equal(String(cam.orgId), String(personal._id), 'in the claimer\'s personal workspace');
    const photo = await models.Snapshot.findOne({ deviceSerial: 'ESPF85B1B92877C' }).lean();
    assert.equal(photo.unclaimed, undefined, 'the photo is kept');
    assert.equal(photo.expiresAt, undefined);
    // The claimer sees and runs it, even with the role "user"
    const mine = await json(await request('/api/user/cameras', { as: person }));
    assert.ok(JSON.stringify(mine.body).includes('ESPF85B1B92877C'));
    const { canManageCamera } = require('../src/utils/ownership');
    assert.equal(canManageCamera({ id: String(person._id), role: 'user' }, cam), true);

    const other = await createUser({ role: 'manager' });
    assert.equal((await claim(other, { serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY' })).status, 404);
    assert.equal((await claim(person, { serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY' })).body.alreadyClaimed, true);
    const audit = await models.AuditLog.findOne({ action: 'camera.claimed' }).lean();
    assert.ok(audit);
});

test('claim: wrong code = the same 404 as an unknown serial; 5 failures lock the serial for an hour', async () => {
    await register();
    const person = await createUser({ role: 'user' });
    const wrong = await claim(person, { serial: 'ESPF85B1B92877C', verifyCode: 'ZZZZZZ' });
    const unknown = await claim(person, { serial: 'ESP999999999999', verifyCode: 'ZZZZZZ' });
    assert.equal(wrong.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(wrong.body, unknown.body, 'nothing tells them apart');
    for (let i = 0; i < 4; i++) assert.equal((await claim(person, { serial: 'ESPF85B1B92877C', verifyCode: 'ZZZZZZ' })).status, 404);
    const locked = await claim(person, { serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.code, 'LOCKED');
    // An unknown serial locks the same way (no hint either)
    for (let i = 0; i < 4; i++) await claim(person, { serial: 'ESP999999999999', verifyCode: 'ZZZZZZ' });
    assert.equal((await claim(person, { serial: 'ESP999999999999', verifyCode: 'ZZZZZZ' })).body.code, 'LOCKED');
    registration.resetClaimLocks();
    assert.equal((await claim(person, { serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY' })).status, 200);
});

test('claim through "Add camera": a CamOS serial that registered itself is claimed by the same dialog', async () => {
    await register();
    const person = await createUser({ role: 'user', email: 'adder@example.test' });
    const add = (b) => request('/api/user/add-camera', { method: 'POST', as: person, body: b }).then(json);
    const wrong = await add({ platform: 'camos', deviceSerial: 'ESPF85B1B92877C', validateCode: 'ZZZZZZ', trapKind: 'lure' });
    assert.equal(wrong.status, 404, 'a wrong code is the claim 404, not a new pre-provisioned camera');
    assert.equal(await models.Camera.countDocuments({ deviceSerial: 'ESPF85B1B92877C' }), 1);
    const res = await add({ platform: 'camos', deviceSerial: 'espf85b1b92877c', validateCode: '9wbywy', trapKind: 'sticky' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.camera.deviceSerial, 'ESPF85B1B92877C');
    assert.equal(res.body.provisioning, undefined, 'no provisioning token for a self-registered camera');
    const cam = await models.Camera.findOne({ deviceSerial: 'ESPF85B1B92877C' }).lean();
    assert.equal(String(cam.userId), String(person._id));
    assert.equal(cam.unclaimed, false);
    assert.equal(cam.trapKind, 'sticky');
    assert.ok(await models.AuditLog.findOne({ action: 'camera.claimed' }).lean());
});

/** Set the FREE plan's numbers as the admin would (Admin > Plans). */
async function freePlan(values) {
    const planService = require('../src/services/planService');
    await planService.ensureSeeded();
    await models.Plan.updateOne({ code: 'free' }, { $set: values });
    planService.clearCache();
}

test('plan limits: cameras per workspace, photos per day, live minutes; admins are exempt', async () => {
    await freePlan({ maxCameras: 1, snapshotsPerDay: 2 });
    const a = await register(body({ serial: 'ESP000000000001' }));
    await register(body({ serial: 'ESP000000000002' }));
    const person = await createUser({ role: 'user' });
    assert.equal((await claim(person, { serial: 'ESP000000000001', verifyCode: '9WBYWY' })).status, 200);
    const over = await claim(person, { serial: 'ESP000000000002', verifyCode: '9WBYWY' });
    assert.equal(over.status, 403);
    assert.equal(over.body.code, 'UPGRADE_REQUIRED');
    assert.equal(over.body.limit, 'cameras');
    assert.equal(over.body.max, 1);
    const admin = await createUser({ role: 'admin' });
    assert.equal((await claim(admin, { serial: 'ESP000000000002', verifyCode: '9WBYWY' })).status, 200);

    // Photos a day (claimed camera of a non-exempt owner)
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await upload('ESP000000000001', a.body.deviceToken)).status);
    assert.deepEqual(statuses, [200, 200, 429]);
    await settle();

    // Live view: the plan's minutes per request (FREE: 5), more for an admin
    const cam = await models.Camera.findOne({ deviceSerial: 'ESP000000000001' }).lean();
    assert.equal(await registration.liveMinutes(cam, { id: String(person._id), role: 'user' }, 20), 5);
    assert.equal(await registration.liveMinutes(cam, admin, 20), 20);
    const live = await json(await request('/api/cameras/ESP000000000001/live/request', { method: 'POST', as: person, body: { minutes: 20 } }));
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.ok(shadowUpdates.some(u => u.thingName === 'ESP000000000001' && u.desired.live?.minutes === 5));
});

// ---------- Cleanup ----------

test('cleanup: unclaimed photos after 24 h; never-claimed cameras after 7 days (AWS, photos, row); claimed ones stay', async () => {
    const reg = await register(body({ serial: 'ESP0000000000AA' }));
    await upload('ESP0000000000AA', reg.body.deviceToken);
    await register(body({ serial: 'ESP0000000000BB' }));
    await settle();
    const person = await createUser({ role: 'user' });
    assert.equal((await claim(person, { serial: 'ESP0000000000BB', verifyCode: '9WBYWY' })).status, 200);

    // A day later: the unclaimed photo goes, the camera stays
    let result = await registration.cleanupSelfRegistered({ now: new Date(Date.now() + 25 * 3600 * 1000) });
    assert.equal(result.photos, 1);
    assert.equal(result.cameras, 0);
    assert.ok(s3Deletes.some(k => k.startsWith('snapshots/ESP0000000000AA/')));
    assert.equal(await models.Snapshot.countDocuments({ deviceSerial: 'ESP0000000000AA' }), 0);

    // A week later: the never-claimed camera is removed everywhere; the claimed one stays
    iotCalls = [];
    kvsCalls = [];
    result = await registration.cleanupSelfRegistered({ now: new Date(Date.now() + 8 * 24 * 3600 * 1000) });
    assert.equal(result.cameras, 1);
    assert.equal(await models.Camera.countDocuments({ deviceSerial: 'ESP0000000000AA' }), 0);
    assert.equal(await models.Camera.countDocuments({ deviceSerial: 'ESP0000000000BB' }), 1);
    assert.deepEqual(iotCalls.map(c => c.name), ['DetachThingPrincipalCommand', 'DetachPolicyCommand', 'UpdateCertificateCommand', 'DeleteCertificateCommand', 'DeleteThingCommand']);
    assert.equal(iotCalls[2].input.newStatus, 'INACTIVE');
    assert.ok(kvsCalls.some(c => c.name === 'DeleteSignalingChannelCommand'));

    // AWS refuses a step: the row stays for the next run
    await register(body({ serial: 'ESP0000000000CC' }));
    iotFail.DeleteThingCommand = awsErr('AccessDeniedException');
    result = await registration.cleanupSelfRegistered({ now: new Date(Date.now() + 8 * 24 * 3600 * 1000) });
    assert.equal(result.failed, 1);
    assert.match((await models.Camera.findOne({ deviceSerial: 'ESP0000000000CC' }).lean()).device.cleanupError, /DeleteThing/);
});

test('owner reset: deleting a claimed self-registered camera frees the serial to register again', async () => {
    await register();
    const person = await createUser({ role: 'user' });
    await claim(person, { serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY' });
    await require('../src/platforms/camos').handleMessage('$aws/events/presence/connected/ESPF85B1B92877C', {});
    assert.equal((await register()).status, 409);
    const del = await json(await request('/api/user/delete-camera', { method: 'DELETE', as: person, body: { deviceSerial: 'ESPF85B1B92877C' } }));
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(iotCalls.some(c => c.name === 'DeleteCertificateCommand'));
    assert.equal((await register()).status, 201);
});

// ---------- Time and timezone ----------

test('time: farm > GPS > IP > default, POSIX string, public IP echoed; shadow tz follows farm and GPS changes', async () => {
    const reg = await register();
    const token = reg.body.deviceToken;
    const headers = { 'X-Device-Serial': 'ESPF85B1B92877C', 'X-Device-Token': token };
    const time = async (extra = {}, ip = '10.0.0.5') => json(await request('/api/device/time', { headers: { 'X-Forwarded-For': ip, ...extra } }));

    // default (private address, nothing known)
    let t = await time();
    assert.equal(t.status, 200);
    assert.equal(t.body.timezone, 'Asia/Ho_Chi_Minh');
    assert.equal(t.body.posix, '<+07>-7');
    assert.equal(t.body.tzSource, 'default');
    assert.equal(t.body.publicIp, null);
    assert.ok(Math.abs(t.body.epoch * 1000 - Date.now()) < 5000);

    // ip: a public address (offline country lookup), echoed back
    t = await time({}, '8.8.8.8');
    assert.equal(t.body.tzSource, 'ip');
    assert.equal(t.body.timezone, 'America/New_York');
    assert.equal(t.body.publicIp, '8.8.8.8');
    assert.equal(t.body.posix, '<-05>5<-04>,M3.2.0/2,M11.1.0/2');

    // gps: the camera reported a fix in Sydney (needs its token)
    await upload('ESPF85B1B92877C', token, { v: 1, location: { lat: -33.87, lng: 151.21 } });
    await waitFor(() => shadowUpdates.some(u => u.desired.tz?.iana === 'Australia/Sydney'));
    t = await time(headers, '8.8.8.8');
    assert.equal(t.body.tzSource, 'gps');
    assert.equal(t.body.timezone, 'Australia/Sydney');
    assert.equal(t.body.posix, '<+10>-10<+11>,M10.1.0/2,M4.1.0/3');
    assert.ok(shadowUpdates.some(u => u.desired.tz?.iana === 'Australia/Sydney' && u.desired.tz.posix === t.body.posix), 'GPS fix -> shadow tz');
    // Without the token the camera is not looked up
    assert.equal((await time({ 'X-Device-Serial': 'ESPF85B1B92877C' }, '8.8.8.8')).body.tzSource, 'ip');

    // farm: claimed into a farm with a timezone
    const owner = await createUser({ role: 'manager' });
    const farm = await models.Farm.create({ ownerId: owner._id, name: 'Lô Tokyo', timezone: 'Asia/Tokyo' });
    shadowUpdates = [];
    assert.equal((await claim(owner, { serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY', farmId: String(farm._id) })).status, 200);
    t = await time(headers, '8.8.8.8');
    assert.equal(t.body.tzSource, 'farm');
    assert.equal(t.body.timezone, 'Asia/Tokyo');
    assert.equal(t.body.posix, '<+09>-9');
    assert.ok(shadowUpdates.some(u => u.desired.tz?.iana === 'Asia/Tokyo'), 'claim -> shadow tz');

    // Farm edit: the camera follows
    shadowUpdates = [];
    const edit = await json(await request(`/api/farms/${farm._id}`, { method: 'PUT', as: owner, body: { timezone: 'Asia/Bangkok' } }));
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    await waitFor(() => shadowUpdates.some(u => u.desired.tz?.iana === 'Asia/Bangkok'));
    assert.ok(shadowUpdates.some(u => u.desired.tz?.iana === 'Asia/Bangkok'), 'farm edit -> shadow tz');
    assert.equal((await json(await request(`/api/farms/${farm._id}`, { method: 'PUT', as: owner, body: { timezone: 'Mars/Olympus' } }))).status, 400);
    // No change, nothing sent
    shadowUpdates = [];
    assert.equal((await timezoneService.syncCamera('ESPF85B1B92877C')).changed, false);
    assert.equal(shadowUpdates.length, 0);
});

test('timezone helpers: POSIX table and computed strings, private addresses, country zones', () => {
    assert.equal(timezoneService.posixOf('Asia/Ho_Chi_Minh'), '<+07>-7');
    assert.equal(timezoneService.posixOf('Asia/Kolkata'), '<+0530>-5:30');
    assert.equal(timezoneService.posixOf('Europe/Berlin'), '<+01>-1<+02>,M3.5.0/2,M10.5.0/3');
    assert.equal(timezoneService.computePosix('America/St_Johns'), '<-0330>3:30<-0230>,M3.2.0/2,M11.1.0/2');
    assert.equal(timezoneService.computePosix('Not/AZone'), null);
    for (const ip of ['10.1.2.3', '192.168.1.1', '172.16.0.1', '127.0.0.1', '::1', '100.64.0.1', '']) assert.equal(timezoneService.publicIpOf(ip), null, ip);
    assert.equal(timezoneService.publicIpOf('::ffff:115.72.212.239'), '115.72.212.239');
    assert.equal(timezoneService.zoneOfCountry('VN'), 'Asia/Ho_Chi_Minh');
    assert.equal(timezoneService.zoneOfCountry('JP'), 'Asia/Tokyo');
    assert.equal(timezoneService.zoneOfLocation({ lat: 10.8, lng: 106.7 }), 'Asia/Ho_Chi_Minh');
    assert.equal(timezoneService.zoneOfLocation({ lat: 0, lng: 0 }), null);
});

test('entitlements: plan values + add-ons, expired paid plan falls back to FREE, operators unlimited', async () => {
    const { getEntitlements, systemLimits, capped } = require('../src/services/entitlements');
    const person = await createUser({ role: 'user', email: 'a@example.test' });
    const ws = await models.Organization.create({ name: 'A', kind: 'personal', members: [{ userId: person._id, email: person.email, role: 'owner' }], plan: { code: 'free' } });
    const free = await getEntitlements(person, ws);
    assert.equal(free.plan, 'free');
    assert.equal(free.maxCameras, 3, 'seeded from DEMO_MAX_CAMERAS_PER_USER');
    assert.equal(free.snapshotsPerDay, 48);
    assert.equal(free.liveMinutes, 5);
    assert.equal(free.deepAnalysisPerMonth, 20);
    assert.equal(free.features.apiAndWebhooks, false);

    await models.Organization.updateOne({ _id: ws._id }, { $set: { plan: { code: 'pro', addonCameras: 4, expiresAt: new Date(Date.now() + 86400000) } } });
    const pro = await getEntitlements(person, ws._id);
    assert.equal(pro.plan, 'pro');
    assert.equal(pro.maxCameras, 14, 'PRO 10 + 4 add-ons');
    assert.equal(pro.features.apiAndWebhooks, true);

    await models.Organization.updateOne({ _id: ws._id }, { $set: { 'plan.expiresAt': new Date(Date.now() - 1000) } });
    const lapsed = await getEntitlements(person, ws._id);
    assert.equal(lapsed.plan, 'free');
    assert.equal(lapsed.expired, true);
    assert.equal(lapsed.maxCameras, 3, 'no add-ons once expired');

    const admin = await createUser({ role: 'admin' });
    const op = await getEntitlements(admin, ws._id);
    assert.equal(op.plan, 'unlimited');
    assert.equal(op.maxCameras, null);
    env.DEMO_EXEMPT_EMAILS.push('owner@example.test');
    assert.equal((await getEntitlements({ role: 'user', email: 'Owner@example.test' }, ws._id)).plan, 'unlimited');
    env.DEMO_EXEMPT_EMAILS.pop();
    assert.equal((await getEntitlements(person, null)).maxCameras, 0, 'no workspace, no cameras');
    assert.equal(systemLimits().maxUnclaimed, 200);
    assert.equal(capped(20, 5), 5);
    assert.equal(capped(20, null), 20);
});
