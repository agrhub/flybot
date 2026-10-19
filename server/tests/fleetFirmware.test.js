const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

process.env.IOT_ENDPOINT = 'a38gtest-ats.iot.ap-southeast-2.amazonaws.com';
process.env.APP_BASE_URL = 'https://flybot.example.test';
process.env.IOT_THING_TYPE = 'camos-camera';
process.env.IOT_POLICY_NAME = 'camos-camera';

const { models, startDb, stopDb, clearDb, request, createUser, json } = require('./dbHelpers');
const env = require('../src/config/env');
const aws = require('../src/platforms/aws');
const camos = require('../src/platforms/camos');
const { s3Client } = require('../src/config/s3');
const { sha256 } = require('../src/services/deviceService');
const registration = require('../src/services/registrationService');
const firmwareService = require('../src/services/firmwareService');
const settingsService = require('../src/services/settingsService');

// ---------- Fakes: IoT data plane (shadow, publish; the camera answers RPCs), IoT, KVS, S3 ----------
let published;
let rpcAnswer; // (serial, request) -> rpc/res body, or null for no answer
const files = new Map();

const fakeIotData = {
    send: async (command) => {
        const name = aws.commandName(command);
        if (name === 'PublishCommand') {
            const message = JSON.parse(Buffer.from(command.input.payload).toString());
            published.push({ topic: command.input.topic, message });
            const m = command.input.topic.match(/^camos\/([^/]+)\/rpc\/req$/);
            const answer = m && rpcAnswer ? rpcAnswer(m[1], message) : null;
            if (answer) setImmediate(() => camos.handleMessage(`camos/${m[1]}/rpc/res`, { v: 1, id: message.id, ...answer }));
        }
        return {};
    }
};
const awsErr = (name) => Object.assign(new Error(name), { name });
const fakeIot = {
    send: async (command) => {
        const name = aws.commandName(command);
        if (name === 'CreateCertificateFromCsrCommand') return { certificateArn: 'arn:aws:iot:x:1:cert/c1', certificateId: 'c'.repeat(64), certificatePem: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n' };
        if (name === 'DescribeThingCommand') return { attributes: {} };
        return {};
    }
};
const fakeKvs = {
    send: async (command) => {
        const name = aws.commandName(command);
        if (name === 'DescribeSignalingChannelCommand') throw awsErr('ResourceNotFoundException');
        if (name === 'CreateSignalingChannelCommand') return { ChannelARN: `arn:kvs:${command.input.ChannelName}` };
        return {};
    }
};

const originalS3Send = s3Client.send;
before(async () => {
    await startDb();
    aws.setClient('iotData', fakeIotData);
    aws.setClient('iot', fakeIot);
    aws.setClient('kinesisVideo', fakeKvs);
    s3Client.send = async (command) => {
        const name = aws.commandName(command);
        if (name === 'PutObjectCommand') { files.set(command.input.Key, Buffer.from(command.input.Body)); return {}; }
        if (name === 'DeleteObjectCommand') { files.delete(command.input.Key); return {}; }
        if (name === 'GetObjectCommand' && files.has(command.input.Key)) return { Body: Readable.from([files.get(command.input.Key)]) };
        return originalS3Send(command);
    };
});
after(async () => {
    aws.setClient('iotData', null);
    aws.setClient('iot', null);
    aws.setClient('kinesisVideo', null);
    s3Client.send = originalS3Send;
    await stopDb();
});
beforeEach(async () => {
    await clearDb();
    published = [];
    rpcAnswer = null;
    files.clear();
    registration.resetClaimLocks();
    settingsService.clearCache?.();
    env.SELF_REGISTRATION = true;
    env.DEVICE_OTA_FW = '';
    firmwareService.setFetcher(async (url) => { throw new Error(`unexpected fetch ${url}`); });
});

// ---------- Helpers ----------

const SERIAL = 'ESP1234567890AB';
const CODE = 'K7Q2MX';
const TOKEN = 'device-token-'.padEnd(43, 'x');
const MODEL = 'AIC-FREENOVE-S3CAM';
const deviceHeaders = (serial = SERIAL, token = TOKEN) => ({ 'X-Device-Serial': serial, 'X-Device-Token': token });

function image(size = 100 * 1024, fill = 1) {
    const b = Buffer.alloc(size, fill);
    b[0] = 0xE9;
    return b;
}

async function camosCamera(owner, serial = SERIAL, extra = {}) {
    const { device, ...rest } = extra;
    return models.Camera.create({
        userId: owner ? owner._id : null,
        deviceSerial: serial,
        deviceName: `Trap ${serial.slice(-4)}`,
        platform: 'camos',
        model: MODEL,
        validateCode: CODE,
        status: 1,
        device: { thingName: serial, fw: '0.6.3', lastSeenAt: new Date(), tokenHash: sha256(TOKEN), ...(device || {}) },
        ...rest
    });
}

function multipart(fields, file) {
    const boundary = 'FlyBotBoundary9x';
    const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (file) parts.push(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.data, Buffer.from('\r\n')]));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

async function uploadFirmware(admin, { version = '0.7.0', model = MODEL, data = image(), sha } = {}) {
    const { body, headers } = multipart({ model, version, notesEn: 'Battery guard', notesVi: 'Bảo vệ pin', ...(sha ? { sha256: sha } : {}) }, { name: `camos-esp32-trap-freenove-v${version}-update.bin`, data });
    return json(await request('/api/admin/firmware', { method: 'POST', as: admin, body, headers }));
}

async function waitFor(check, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const value = await check();
        if (value) return value;
        await new Promise(r => setTimeout(r, 25));
    }
    return null;
}

const openUpdate = (serial = SERIAL) => models.FirmwareUpdate.findOne({ deviceSerial: serial }).sort({ createdAt: -1 }).lean();

// ---------- Registry ----------

test('registry: add, list with masked codes, reveal (audited), update, delete', async () => {
    const admin = await createUser({ role: 'admin' });
    const added = await json(await request('/api/admin/registry', { method: 'POST', as: admin, body: { serial: SERIAL.toLowerCase(), verifyCode: CODE.toLowerCase(), model: MODEL, batch: 'B1' } }));
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((await json(await request('/api/admin/registry', { method: 'POST', as: admin, body: { serial: SERIAL, verifyCode: CODE } }))).status, 409);
    assert.equal((await json(await request('/api/admin/registry', { method: 'POST', as: admin, body: { serial: 'ESP0000000000AA', verifyCode: 'IIIIII' } }))).status, 400, 'I is not Crockford');

    const list = await json(await request('/api/admin/registry', { as: admin }));
    assert.equal(list.body.entries.length, 1);
    assert.equal(list.body.entries[0].verifyCodeMasked, 'K7••••');
    assert.ok(!JSON.stringify(list.body).includes(CODE), 'the code is never listed');
    assert.equal(list.body.entries[0].status, 'available');
    assert.deepEqual(list.body.batches, ['B1']);

    const support = await createUser({ role: 'support' });
    assert.equal((await request(`/api/admin/registry/${SERIAL}/reveal-code`, { method: 'POST', as: support })).status, 403, 'support reads, never reveals');
    const shown = await json(await request(`/api/admin/registry/${SERIAL}/reveal-code`, { method: 'POST', as: admin }));
    assert.equal(shown.body.verifyCode, CODE);
    assert.ok(await waitFor(() => models.AuditLog.exists({ action: 'registry.verify_code_revealed' })));

    const blocked = await json(await request(`/api/admin/registry/${SERIAL}`, { method: 'PUT', as: admin, body: { disabled: true, disabledReason: 'stolen' } }));
    assert.equal(blocked.status, 200);
    assert.ok(blocked.body.changed.includes('disabled'));
    assert.equal((await json(await request(`/api/admin/registry/${SERIAL}`, { method: 'DELETE', as: admin }))).status, 200);
    assert.equal(await models.DeviceRegistry.countDocuments(), 0);
});

test('registry: CSV import with header, label QR lines, row errors and a dry run', async () => {
    const admin = await createUser({ role: 'admin' });
    const csv = [
        'serial,verifyCode,model,hwVersion,batch,note',
        'ESP0000000000A1,AAAAA1,AIC-FREENOVE-S3CAM,1.2,,first',
        '"ESP0000000000A2",BBBBB2,AIC-FREENOVE-S3CAM,1.2,,"with, comma"',
        'ESP0000000000A3,ILLEGL,AIC-FREENOVE-S3CAM,,,bad code',
        'ESP0000000000A1,AAAAA1,,,,duplicate',
        'CAMOS:1;SN:ESP0000000000A4;VC:CCCCC3;M:AIC-FREENOVE-S3CAM;;'
    ].join('\r\n');
    const dry = await json(await request('/api/admin/registry/import', { method: 'POST', as: admin, body: { csv, dryRun: true, batch: 'LOT-7' } }));
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.created, 3);
    assert.deepEqual(dry.body.errors.map(e => e.error).sort(), ['bad_code', 'duplicate']);
    assert.equal(await models.DeviceRegistry.countDocuments(), 0, 'a dry run writes nothing');

    const real = await json(await request('/api/admin/registry/import', { method: 'POST', as: admin, body: { csv, batch: 'LOT-7' } }));
    assert.equal(real.body.created, 3);
    const a2 = await models.DeviceRegistry.findOne({ serial: 'ESP0000000000A2' }).lean();
    assert.equal(a2.note, 'with, comma');
    assert.equal(a2.batch, 'LOT-7');
    assert.equal((await models.DeviceRegistry.findOne({ serial: 'ESP0000000000A4' }).lean()).verifyCode, 'CCCCC3');
    const again = await json(await request('/api/admin/registry/import', { method: 'POST', as: admin, body: { csv } }));
    assert.equal(again.body.created, 0);
    assert.equal(again.body.skipped, 3);
});

test('registry: open mode lets unknown serials in; strict refuses them; a registered serial needs its code; a blocked one is refused', async () => {
    const owner = await createUser({ role: 'manager' });
    const admin = await createUser({ role: 'admin' });
    const add = async (serial, code) => json(await request('/api/user/add-camera', { method: 'POST', as: owner, body: { platform: 'camos', deviceSerial: serial, validateCode: code } }));

    // Open (default): an unregistered ESP serial is added as before
    assert.equal((await add('ESP0000000000B1', 'AAAAA1')).status, 200);

    await request('/api/admin/registry', { method: 'POST', as: admin, body: { serial: 'ESP0000000000B2', verifyCode: 'BBBBB2' } });
    const wrong = await add('ESP0000000000B2', 'ZZZZZ9');
    assert.equal(wrong.status, 404);
    assert.equal(await models.Camera.exists({ deviceSerial: 'ESP0000000000B2' }), null);
    const right = await add('ESP0000000000B2', 'bbbbb2');
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.ok((await models.DeviceRegistry.findOne({ serial: 'ESP0000000000B2' }).lean()).claimedAt, 'the registry knows it was sold');

    await request('/api/admin/registry', { method: 'POST', as: admin, body: { serial: 'ESP0000000000B3', verifyCode: 'CCCCC3' } });
    await request('/api/admin/registry/ESP0000000000B3', { method: 'PUT', as: admin, body: { disabled: true } });
    const blocked = await add('ESP0000000000B3', 'CCCCC3');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'SERIAL_DISABLED');

    // Strict: unregistered serials join no account
    assert.equal((await json(await request('/api/admin/settings', { method: 'PUT', as: admin, body: { registryMode: 'strict' } }))).status, 200);
    settingsService.clearCache?.();
    const strict = await add('ESP0000000000B4', 'DDDDD4');
    assert.equal(strict.status, 403);
    assert.equal(strict.body.code, 'SERIAL_NOT_REGISTERED');
    const viMessage = await json(await request('/api/user/add-camera', { method: 'POST', as: owner, headers: { 'X-Language': 'vi' }, body: { platform: 'camos', deviceSerial: 'ESP0000000000B4', validateCode: 'DDDDD4' } }));
    assert.match(viMessage.body.message, /chưa được đăng ký/);
});

const CSR = `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.concat([Buffer.from([0x30, 0x82, 0x01, 0x00]), Buffer.alloc(120, 'a')]).toString('base64')}\n-----END CERTIFICATE REQUEST-----`;
const registerBody = (extra = {}) => ({ v: 1, serial: SERIAL, verifyCode: CODE, model: MODEL, fw: '0.6.3', csr: CSR, ...extra });

test('registry: self-registration needs the registered code, a blocked serial is refused, the claim checks strict mode', async () => {
    const admin = await createUser({ role: 'admin' });
    await request('/api/admin/registry', { method: 'POST', as: admin, body: { serial: SERIAL, verifyCode: CODE } });
    const forged = await json(await request('/api/device/register', { method: 'POST', body: registerBody({ verifyCode: 'ZZZZZ9' }) }));
    assert.equal(forged.status, 409, 'a camera with another code cannot take a registered serial');
    const ok = await json(await request('/api/device/register', { method: 'POST', body: registerBody() }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));

    await request(`/api/admin/registry/${SERIAL}`, { method: 'PUT', as: admin, body: { disabled: true } });
    const owner = await createUser({ role: 'manager' });
    const claim = await json(await request('/api/cameras/claim', { method: 'POST', as: owner, body: { serial: SERIAL, verifyCode: CODE } }));
    assert.equal(claim.status, 403);
    assert.equal(claim.body.code, 'SERIAL_DISABLED');

    await request(`/api/admin/registry/${SERIAL}`, { method: 'PUT', as: admin, body: { disabled: false } });
    const claimed = await json(await request('/api/cameras/claim', { method: 'POST', as: owner, body: { serial: SERIAL, verifyCode: CODE } }));
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

    // Another unregistered camera registers in strict mode too, but nobody can claim it
    await request('/api/admin/settings', { method: 'PUT', as: admin, body: { registryMode: 'strict' } });
    settingsService.clearCache?.();
    const other = await json(await request('/api/device/register', { method: 'POST', body: registerBody({ serial: 'ESP00000000C0DE', verifyCode: 'EEEEE5' }) }));
    assert.equal(other.status, 201);
    const refused = await json(await request('/api/cameras/claim', { method: 'POST', as: owner, body: { serial: 'ESP00000000C0DE', verifyCode: 'EEEEE5' } }));
    assert.equal(refused.body.code, 'SERIAL_NOT_REGISTERED');

    const blockedRegister = await json(await request('/api/device/register', { method: 'POST', body: registerBody({ serial: 'ESP0000000000FF', verifyCode: 'FFFFF6' }) }));
    assert.equal(blockedRegister.status, 201, 'unknown serials still register (hidden, removed after 7 days)');
});

test('registry: backfill puts existing CamOS cameras in, claimed ones marked', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    await camosCamera(owner);
    await camosCamera(null, 'ESP0000000000D1', { unclaimed: true, selfRegistered: true });
    const res = await json(await request('/api/admin/registry/backfill', { method: 'POST', as: admin }));
    assert.equal(res.body.added, 2);
    const entry = await models.DeviceRegistry.findOne({ serial: SERIAL }).lean();
    assert.equal(entry.verifyCode, CODE);
    assert.ok(entry.claimedAt);
    assert.equal((await models.DeviceRegistry.findOne({ serial: 'ESP0000000000D1' }).lean()).claimedAt, undefined);
    assert.equal((await json(await request('/api/admin/registry/backfill', { method: 'POST', as: admin }))).body.added, 0);
});

// ---------- Fleet ----------

test('fleet: every camera with owner, model, firmware, IMEI from the modem, latest release; filters', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager', email: 'farmer@example.test' });
    await camosCamera(owner);
    await models.Camera.create({ userId: owner._id, deviceSerial: 'EZ0001', deviceName: 'Gate', model: 'CS-C6N', deviceVersion: 'V5.3.0', status: 0 });
    await camos.handleMessage(`camos/${SERIAL}/state`, { v: 1, online: true, model: MODEL, fw: '0.6.3', net: { type: '4g', rssi: -71, cell: { imei: '861234567890123', iccid: '8984012345678901234', operator: 'Viettel', csq: 20 } } });
    // Back on Wi-Fi: the IMEI stays known
    await camos.handleMessage(`camos/${SERIAL}/state`, { v: 1, online: true, fw: '0.6.3', net: { type: 'wifi', rssi: -50 } });
    await uploadFirmware(admin);
    const fw = await models.Firmware.findOne({}).lean();
    await request(`/api/admin/firmware/${fw._id}`, { method: 'PUT', as: admin, body: { current: true } });

    const res = await json(await request('/api/admin/fleet', { as: admin }));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    const row = res.body.cameras.find(c => c.deviceSerial === SERIAL);
    assert.equal(row.owner.email, 'farmer@example.test');
    assert.equal(row.imei, '861234567890123');
    assert.equal(row.operator, 'Viettel');
    assert.equal(row.net, 'wifi');
    assert.equal(row.fw, '0.6.3');
    assert.equal(row.latestFw, '0.7.0');
    assert.equal(row.outdated, true);
    assert.equal(row.state, 'online');
    assert.equal(row.verifyCodeMasked, 'K7••••');
    assert.ok(!JSON.stringify(res.body).includes(CODE));
    const ez = res.body.cameras.find(c => c.deviceSerial === 'EZ0001');
    assert.deepEqual([ez.platform, ez.model, ez.fw, ez.state], ['ezviz', 'CS-C6N', 'V5.3.0', 'offline']);

    assert.deepEqual((await json(await request('/api/admin/fleet?q=861234', { as: admin }))).body.cameras.map(c => c.deviceSerial), [SERIAL]);
    assert.deepEqual((await json(await request('/api/admin/fleet?q=farmer@', { as: admin }))).body.total, 2);
    assert.deepEqual((await json(await request('/api/admin/fleet?outdated=1', { as: admin }))).body.cameras.map(c => c.deviceSerial), [SERIAL]);
    assert.deepEqual((await json(await request('/api/admin/fleet?state=offline', { as: admin }))).body.cameras.map(c => c.deviceSerial), ['EZ0001']);
    assert.deepEqual((await json(await request('/api/admin/fleet?platform=ezviz', { as: admin }))).body.cameras.map(c => c.deviceSerial), ['EZ0001']);
    assert.equal((await request('/api/admin/fleet', { as: owner })).status, 403);
    const revealed = await json(await request(`/api/admin/fleet/${SERIAL}/reveal-code`, { method: 'POST', as: admin }));
    assert.equal(revealed.body.verifyCode, CODE);
    assert.ok(await waitFor(() => models.AuditLog.exists({ action: 'camera.verify_code_revealed', targetId: SERIAL })));
});

test('fleet: a paused camera takes no photo, uploads nothing (403, not 401), opens no live view; the owner is told why', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    await camosCamera(owner);
    const paused = await json(await request(`/api/admin/fleet/${SERIAL}/disabled`, { method: 'PUT', as: admin, body: { disabled: true, reason: 'Unpaid invoice' } }));
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.deviceSynced, true);
    const desired = published.filter(p => p.topic === `camos/${SERIAL}/shadow/desired`).pop();
    assert.equal(desired.message.disabled, true);

    const capture = await json(await request('/api/user/camera/capture', { method: 'POST', as: owner, body: { deviceSerial: SERIAL } }));
    assert.equal(capture.status, 403);
    assert.equal(capture.body.code, 'CAMERA_DISABLED');
    const live = await json(await request(`/api/cameras/${SERIAL}/live`, { as: owner }));
    assert.equal(live.status, 403);
    assert.equal(live.body.code, 'CAMERA_DISABLED');

    const boundary = 'B0undary';
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 7), Buffer.from([0xff, 0xd9])]);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="s.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const upload = await json(await request('/api/device/snapshot', { method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...deviceHeaders() } }));
    assert.equal(upload.status, 403);
    assert.equal(upload.body.error, 'disabled');
    assert.ok(upload.body.nextWakeAt);
    assert.equal(await models.Snapshot.countDocuments(), 0);

    const mine = await json(await request('/api/user/cameras', { as: owner }));
    assert.equal(mine.body.cameras[0].adminDisabled.reason, 'Unpaid invoice');
    assert.equal(mine.body.cameras[0].adminDisabled.by, undefined, 'never who');
    assert.ok(await waitFor(() => models.Notification.exists({ userId: owner._id, type: 'camera_disabled' })));

    const resumed = await json(await request(`/api/admin/fleet/${SERIAL}/disabled`, { method: 'PUT', as: admin, body: { disabled: false } }));
    assert.equal(resumed.body.changed, true);
    assert.equal(published.filter(p => p.topic === `camos/${SERIAL}/shadow/desired`).pop().message.disabled, false);
    assert.equal((await json(await request('/api/admin/fleet?state=disabled', { as: admin }))).body.total, 0);
    assert.ok(await waitFor(() => models.Notification.exists({ userId: owner._id, type: 'camera_enabled' })));
    assert.ok(await waitFor(() => models.AuditLog.exists({ action: 'camera.disabled' })));
});

// ---------- Firmware releases ----------

test('firmware: upload checks the image, computes SHA-256, refuses duplicates and wrong hashes', async () => {
    const admin = await createUser({ role: 'admin' });
    const notEsp = await uploadFirmware(admin, { data: Buffer.alloc(100 * 1024, 1) });
    assert.equal(notEsp.status, 400);
    assert.equal(notEsp.body.code, 'NOT_ESP_IMAGE');
    assert.equal((await uploadFirmware(admin, { data: image(3.5 * 1024 * 1024) })).body.code, 'TOO_LARGE', 'larger than the 3 MB slot');
    const badSha = await uploadFirmware(admin, { sha: 'a'.repeat(64) });
    assert.equal(badSha.body.code, 'SHA_MISMATCH');
    const data = image();
    const ok = await uploadFirmware(admin, { data, sha: require('crypto').createHash('sha256').update(data).digest('hex') });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.release.size, data.length);
    assert.equal(ok.body.release.notes.vi, 'Bảo vệ pin');
    assert.ok(files.has(`firmware/${MODEL}/0.7.0/camos-esp32-trap-freenove-v0.7.0-update.bin`));
    assert.equal((await uploadFirmware(admin, { data })).status, 409);
    const list = await json(await request('/api/admin/firmware', { as: admin }));
    assert.equal(list.body.releases.length, 1);
    assert.ok(list.body.models.includes(MODEL));
});

test('firmware: a GitHub release is imported per board and checked against SHA256SUMS', async () => {
    const admin = await createUser({ role: 'admin' });
    const freenove = image(120 * 1024, 2);
    const esp32cam = image(90 * 1024, 3);
    const h = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
    const base = 'https://github.com/agrhub/camos-esp32-trap/releases/download/v0.7.0';
    const fetched = [];
    firmwareService.setFetcher(async (url) => {
        fetched.push(url);
        if (url === `${base}/SHA256SUMS`) return Buffer.from(`${h(freenove)}  camos-esp32-trap-freenove-v0.7.0-update.bin\n${h(Buffer.from('x'))}  camos-esp32-trap-freenove-v0.7.0-install.bin\n${'0'.repeat(64)}  camos-esp32-trap-esp32cam-v0.7.0-update.bin\n`);
        if (url.endsWith('freenove-v0.7.0-update.bin')) return freenove;
        if (url.endsWith('esp32cam-v0.7.0-update.bin')) return esp32cam;
        if (url.includes('api.github.com')) return Buffer.from(JSON.stringify({ body: 'Battery guard and remote pause.' }));
        throw new Error('404');
    });
    const res = await json(await request('/api/admin/firmware', { method: 'POST', as: admin, body: { githubTag: 'v0.7.0' } }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const byBoard = Object.fromEntries(res.body.results.map(r => [r.board, r]));
    assert.equal(byBoard.freenove.status, 'added');
    assert.equal(byBoard.esp32cam.status, 'failed', 'the hash in SHA256SUMS does not match');
    assert.equal(byBoard.esp32cam.error, 'SHA_MISMATCH');
    assert.ok(!fetched.some(u => u.includes('install.bin')), 'only update images');
    const fw = await models.Firmware.findOne({ model: MODEL }).lean();
    assert.equal(fw.source.kind, 'github');
    assert.equal(fw.notes.en, 'Battery guard and remote pause.');
});

// ---------- Updates ----------

async function releaseCurrent(admin, version = '0.7.0') {
    const up = await uploadFirmware(admin, { version, data: image(100 * 1024, Number(version.split('.')[1])) });
    const id = up.body.release.id;
    const made = await json(await request(`/api/admin/firmware/${id}`, { method: 'PUT', as: admin, body: { current: true } }));
    return { id, made };
}

test('rollout: ota.apply to an awake camera, the signed offer and download, ota_result, boot confirms; the owner is told', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    await camosCamera(owner);
    await camosCamera(owner, 'ESP0000000000E1', { model: 'AIC-ESP32CAM' });
    const { id } = await releaseCurrent(admin);
    let applied = 0;
    rpcAnswer = (serial, req) => (req.method === 'ota.apply' ? (applied++, { ok: true, result: { version: '0.7.0' } }) : null);

    const roll = await json(await request(`/api/admin/firmware/${id}/rollout`, { method: 'POST', as: admin, body: { serials: [SERIAL, 'ESP0000000000E1', 'NOPE1'] } }));
    assert.equal(roll.status, 200, JSON.stringify(roll.body));
    assert.equal(roll.body.created, 1);
    assert.deepEqual(roll.body.skipped.map(s => s.reason).sort(), ['model_mismatch', 'not_found']);
    assert.ok(await waitFor(async () => (await openUpdate())?.state === 'installing'), 'sent and accepted');
    assert.equal(applied, 1);

    // The camera asks what to install: its own build, a signed link
    const offer = await json(await request('/api/device/ota', { headers: deviceHeaders() }));
    assert.equal(offer.status, 200);
    assert.equal(offer.body.fw, '0.7.0');
    const fw = await models.Firmware.findById(id).lean();
    assert.equal(offer.body.sha256, fw.sha256);
    assert.ok(offer.body.url.length < 256, 'fits the firmware buffer');
    const url = new URL(offer.body.url);
    assert.equal(url.origin, env.DEVICE_API_BASE_URL);
    const bin = await request(url.pathname + url.search);
    assert.equal(bin.status, 200);
    const bytes = Buffer.from(await bin.arrayBuffer());
    assert.equal(require('crypto').createHash('sha256').update(bytes).digest('hex'), fw.sha256);
    // A link for another camera, or a changed signature, opens nothing
    assert.equal((await request(url.pathname + url.search.replace(SERIAL, 'ESP0000000000E1'))).status, 401);
    assert.equal((await request(`${url.pathname}?sn=${SERIAL}&exp=9999999999&sig=AAAA`)).status, 401);
    // The other camera has no update: 204, never 401
    assert.equal((await request('/api/device/ota', { headers: deviceHeaders('ESP0000000000E1') })).status, 204);

    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 1, type: 'ota_progress', target: 'firmware', version: '0.7.0', pct: 50 });
    assert.equal((await openUpdate()).progress, 50);
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 1, type: 'ota_result', target: 'firmware', version: '0.7.0', ok: true, stage: 'installed' });
    assert.equal((await openUpdate()).state, 'rebooting');
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 1, type: 'boot', reason: 'ota', fw: '0.7.0' });
    const done = await openUpdate();
    assert.equal(done.state, 'succeeded');
    assert.equal((await models.Camera.findOne({ deviceSerial: SERIAL }).lean()).device.fw, '0.7.0');
    assert.ok(await waitFor(() => models.Notification.exists({ userId: owner._id, type: 'firmware_updated' })));
    assert.equal((await request(url.pathname + url.search)).status, 404, 'the link closes with the update');

    const updates = await json(await request(`/api/admin/firmware/updates?batchId=${roll.body.batchId}`, { as: admin }));
    assert.equal(updates.body.updates.length, 1);
    assert.equal(updates.body.batches[0].succeeded, 1);
});

test('updates wait for a sleeping or low-battery camera and go when it wakes; rollback and OLD_VERSION are recognised', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    await camosCamera(owner, SERIAL, { status: 0, device: { sleeping: true, wakeAt: new Date(Date.now() + 3600 * 1000), battery: { pct: 80, mv: 4000 } } });
    const { id } = await releaseCurrent(admin);
    rpcAnswer = (serial, req) => (req.method === 'ota.apply' ? { ok: true, result: { version: '0.7.0' } } : null);
    await request(`/api/admin/firmware/${id}/rollout`, { method: 'POST', as: admin, body: { serials: [SERIAL] } });
    assert.ok(await waitFor(async () => (await openUpdate())?.waitReason === 'sleeping'));
    assert.equal(published.filter(p => p.topic.endsWith('/rpc/req')).length, 0, 'nothing sent to a sleeping camera');

    // Wakes with a weak battery: still waits
    await camos.handleMessage(`camos/${SERIAL}/state`, { v: 1, online: true, fw: '0.6.3', battery: { pct: 20, mv: 3550, charging: false } });
    assert.ok(await waitFor(async () => (await openUpdate())?.waitReason === 'battery_low'));
    // Charging: it goes
    await camos.handleMessage(`camos/${SERIAL}/telemetry`, { v: 1, battery: { pct: 22, mv: 3600, charging: true } });
    assert.ok(await waitFor(async () => (await openUpdate())?.state === 'installing'));

    // The new image never connected: the bootloader went back to 0.6.3
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 1, type: 'ota_result', target: 'firmware', ok: true, stage: 'installed', version: '0.7.0' });
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 1, type: 'boot', reason: 'crash', fw: '0.6.3' });
    const rolled = await openUpdate();
    assert.equal(rolled.state, 'rolled_back');
    assert.ok(await waitFor(() => models.Notification.exists({ userId: owner._id, type: 'firmware_failed' })));

    // Retry: the camera says it already runs it (installed by hand meanwhile)
    rpcAnswer = (serial, req) => (req.method === 'ota.apply' ? { ok: false, error: { code: 'OLD_VERSION', message: '0.7.0' } } : null);
    const retry = await json(await request(`/api/admin/firmware/updates/${rolled._id}/retry`, { method: 'POST', as: admin }));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.ok(await waitFor(async () => (await openUpdate())?.state === 'succeeded'));
});

test('a failed download is reported with its code; a pending update can be cancelled; the sweep times out a silent install', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    await camosCamera(owner);
    const { id } = await releaseCurrent(admin);
    rpcAnswer = (serial, req) => (req.method === 'ota.apply' ? { ok: true, result: { version: '0.7.0' } } : null);
    await request(`/api/admin/firmware/${id}/rollout`, { method: 'POST', as: admin, body: { serials: [SERIAL] } });
    assert.ok(await waitFor(async () => (await openUpdate())?.state === 'installing'));
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 1, type: 'ota_result', target: 'firmware', ok: false, stage: 'failed', error: 'SIGNATURE_INVALID', detail: 'sha256 mismatch: image discarded' });
    const failed = await openUpdate();
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'SIGNATURE_INVALID');

    // Asleep: pending, cancellable
    await models.Camera.updateOne({ deviceSerial: SERIAL }, { $set: { status: 0, 'device.sleeping': true } });
    await request(`/api/admin/firmware/updates/${failed._id}/retry`, { method: 'POST', as: admin });
    const pending = await waitFor(async () => { const u = await openUpdate(); return u?.state === 'pending' && u.waitReason ? u : null; });
    const cancelled = await json(await request(`/api/admin/firmware/updates/${pending._id}/cancel`, { method: 'POST', as: admin }));
    assert.equal(cancelled.body.update.state, 'cancelled');

    // An install that never reports back
    await models.Camera.updateOne({ deviceSerial: SERIAL }, { $set: { status: 1, 'device.sleeping': false, 'device.lastSeenAt': new Date() } });
    await request(`/api/admin/firmware/updates/${pending._id}/retry`, { method: 'POST', as: admin });
    assert.ok(await waitFor(async () => (await openUpdate())?.state === 'installing'));
    const later = new Date(Date.now() + 31 * 60 * 1000);
    const swept = await firmwareService.sweep({ now: later });
    assert.equal(swept.timedOut, 1);
    assert.equal((await openUpdate()).error, 'TIMEOUT');
});

// ---------- Owners ----------

test('owners: notice of a new release (once), check, confirmed install, viewers cannot; EZVIZ shows its version only', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser();
    await camosCamera(owner, SERIAL, { sharedWith: [{ userId: viewer._id, email: viewer.email }] });
    await models.Camera.create({ userId: owner._id, deviceSerial: 'EZ0002', deviceName: 'Gate', model: 'CS-C6N', deviceVersion: 'V5.3.0' });
    const { id, made } = await releaseCurrent(admin);
    assert.deepEqual(made.body.announced, { scheduled: 0, notified: 1 });
    // Marking it current again (or another admin action) does not tell the owner twice
    await request(`/api/admin/firmware/${id}`, { method: 'PUT', as: admin, body: { current: false } });
    await request(`/api/admin/firmware/${id}`, { method: 'PUT', as: admin, body: { current: true } });
    assert.equal(await models.Notification.countDocuments({ type: 'firmware_available' }), 1);
    assert.equal(await models.Notification.countDocuments({ userId: viewer._id }), 0, 'only the owner');

    const status = await json(await request(`/api/cameras/${SERIAL}/firmware`, { as: owner, headers: { 'X-Language': 'vi' } }));
    assert.equal(status.body.current, '0.6.3');
    assert.equal(status.body.latest.version, '0.7.0');
    assert.equal(status.body.latest.notes, 'Bảo vệ pin');
    assert.equal(status.body.updateAvailable, true);
    assert.equal(status.body.canUpdate, true);
    const asViewer = await json(await request(`/api/cameras/${SERIAL}/firmware`, { as: viewer }));
    assert.equal(asViewer.body.canUpdate, false);
    assert.equal((await request(`/api/cameras/${SERIAL}/firmware/update`, { method: 'POST', as: viewer, body: { confirm: true } })).status, 404);
    assert.equal((await json(await request(`/api/cameras/${SERIAL}/firmware/update`, { method: 'POST', as: owner, body: {} }))).body.code, 'CONFIRM');

    rpcAnswer = (serial, req) => (req.method === 'ota.apply' ? { ok: true, result: { version: '0.7.0' } } : null);
    const started = await json(await request(`/api/cameras/${SERIAL}/firmware/update`, { method: 'POST', as: owner, body: { confirm: true } }));
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.state, 'installing');
    assert.equal(started.body.update.source, 'owner');
    assert.equal((await json(await request(`/api/cameras/${SERIAL}/firmware/update`, { method: 'POST', as: owner, body: { confirm: true } }))).body.code, 'BUSY');

    const ez = await json(await request('/api/cameras/EZ0002/firmware', { as: owner }));
    assert.deepEqual([ez.body.platform, ez.body.current, ez.body.managedBy, ez.body.canUpdate], ['ezviz', 'V5.3.0', 'ezviz', false]);
    const checked = await json(await request('/api/cameras/EZ0002/firmware/check', { method: 'POST', as: owner }));
    assert.ok(checked.body.checkedAt);
});

test('automatic updates: turned on, the camera gets the current release in its hour; a new release schedules it', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    await camosCamera(owner, SERIAL, { device: { tz: { iana: 'Asia/Ho_Chi_Minh' } } });
    await releaseCurrent(admin, '0.7.0');
    const hourNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hour12: false }).format(new Date())) % 24;
    const away = (hourNow + 12) % 24;
    const set = await json(await request(`/api/cameras/${SERIAL}/firmware/auto`, { method: 'PUT', as: owner, body: { enabled: true, hour: away } }));
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.queued, true);
    assert.ok(await waitFor(async () => (await openUpdate())?.waitReason === 'outside_hour'));
    assert.equal((await openUpdate()).source, 'auto');

    // In its hour: it goes
    rpcAnswer = (serial, req) => (req.method === 'ota.apply' ? { ok: true, result: { version: '0.7.0' } } : null);
    await models.Camera.updateOne({ deviceSerial: SERIAL }, { $set: { 'firmware.autoHour': hourNow } });
    await firmwareService.sweep();
    assert.ok(await waitFor(async () => (await openUpdate())?.state === 'installing'));
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 1, type: 'boot', reason: 'ota', fw: '0.7.0' });
    assert.equal((await openUpdate()).state, 'succeeded');

    // The next release is scheduled at once for this camera (no "available" notice)
    const { made } = await releaseCurrent(admin, '0.8.0');
    assert.deepEqual(made.body.announced, { scheduled: 1, notified: 0 });
    assert.equal(await models.Notification.countDocuments({ type: 'firmware_available', 'params.version': '0.8.0' }), 0);
});
