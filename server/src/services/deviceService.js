const crypto = require('crypto');
const env = require('../config/env');
const { Camera } = require('../models');
const { CAPTURE_INTERVALS, deviceSchedules } = require('./captureSchedule');

/**
 * The CamOS device API (routes/deviceRoutes.js; flybot-aws docs/CONTRACTS.md section 2): the
 * cameras' side of FlyBot. Pairing hands each camera its own token (stored as a SHA-256 hash),
 * photos go through the same pipeline as EZVIZ photos (cron/captureJob.js storeSnapshot).
 */
const SERIAL = /^[A-Za-z0-9_-]{3,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
// A provisioning token (owner -> camera) is good for this long
const PROVISION_TTL_MS = 24 * 60 * 60 * 1000;
// Photo size limit (CONTRACTS: 2 MB)
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_META_BYTES = 8 * 1024;
// A paused camera is told to come back this much later
const DISABLED_RETRY_MS = 6 * 60 * 60 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const safeEqualHex = (a, b) => {
    const x = Buffer.from(String(a || ''), 'hex');
    const y = Buffer.from(String(b || ''), 'hex');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const isJpeg = (b) => Buffer.isBuffer(b) && b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;

// ---------- Provisioning and pairing ----------

/**
 * A new provisioning token for a CamOS camera the owner registered (shown once in the app, typed
 * into the camera's portal / network QR). Returns { provisionToken, expiresAt, pairUrl }.
 */
async function issueProvisionToken(camera, now = new Date()) {
    const provisionToken = newToken();
    const expiresAt = new Date(now.getTime() + PROVISION_TTL_MS);
    await Camera.updateOne({ _id: camera._id }, {
        $set: {
            platform: 'camos',
            'device.provisionTokenHash': sha256(provisionToken),
            'device.provisionExpiresAt': expiresAt,
            'device.thingName': camera.device?.thingName || camera.deviceSerial
        }
    });
    return { provisionToken, expiresAt, pairUrl: `${env.DEVICE_API_BASE_URL}/api/device/pair`, apiBase: env.DEVICE_API_BASE_URL };
}

/**
 * POST /api/device/pair { serial, verifyCode, provisionToken }: the camera's one call after the
 * portal provisioned it. The verification code is the one on the camera's label (the owner
 * typed it when adding the camera). Returns { status, body }.
 */
async function pair({ serial, verifyCode, provisionToken }, now = new Date()) {
    if (!SERIAL.test(String(serial || '')) || typeof verifyCode !== 'string' || !TOKEN.test(String(provisionToken || ''))) {
        return { status: 400, body: { ok: false, error: 'bad_request', message: 'serial, verifyCode and provisionToken are required.' } };
    }
    const camera = await Camera.findOne({ deviceSerial: serial, platform: 'camos' }).select('deviceSerial validateCode device').lean();
    const d = camera?.device || {};
    const fresh = d.provisionExpiresAt && new Date(d.provisionExpiresAt) > now;
    const codeOk = camera && String(camera.validateCode || '').trim().toUpperCase() === String(verifyCode).trim().toUpperCase();
    if (!camera || !fresh || !codeOk || !safeEqualHex(d.provisionTokenHash, sha256(provisionToken))) {
        return { status: 401, body: { ok: false, error: 'unauthorized', message: 'Unknown camera, wrong code or expired provisioning token.' } };
    }
    const deviceToken = newToken();
    const kvs = require('../platforms/kinesis');
    let channelName = d.kvsChannelName || kvs.channelNameOf(serial);
    try {
        channelName = (await kvs.ensureChannel(serial)).channelName;
    } catch (err) {
        // The channel can be made at the first live request; pairing must not fail on KVS
        console.warn(`⚠️ KVS channel for ${serial} not created at pairing: ${err.message}`);
    }
    await Camera.updateOne({ _id: camera._id }, {
        $set: {
            'device.tokenHash': sha256(deviceToken),
            'device.tokenIssuedAt': now,
            'device.pairedAt': now,
            'device.lastSeenAt': now,
            'device.thingName': d.thingName || serial,
            'device.kvsChannelName': channelName
        },
        $unset: { 'device.provisionTokenHash': 1, 'device.provisionExpiresAt': 1 }
    });
    return {
        status: 200,
        body: {
            ok: true,
            deviceToken,
            iot: { endpoint: env.IOT_ENDPOINT || null, thingName: d.thingName || serial, ...(require('../platforms/camos').liveCredentials() || {}) },
            kvs: { region: env.AWS_REGION, channelName }
        }
    };
}

/** The camera of a request's X-Device-Serial / X-Device-Token, or null. */
async function authenticate(serial, token) {
    if (!SERIAL.test(String(serial || '')) || !TOKEN.test(String(token || ''))) return null;
    const camera = await Camera.findOne({ deviceSerial: serial, platform: 'camos' }).lean();
    if (!camera?.device?.tokenHash) return null;
    return safeEqualHex(camera.device.tokenHash, sha256(token)) ? camera : null;
}

// ---------- Snapshot upload ----------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** The `meta` part, checked and trimmed to what FlyBot stores. */
function readMeta(raw) {
    let meta = {};
    if (raw !== undefined && raw !== null && raw !== '') {
        if (Buffer.byteLength(String(raw)) > MAX_META_BYTES) return { error: 'meta is too large.' };
        try {
            meta = JSON.parse(String(raw));
        } catch {
            return { error: 'meta is not valid JSON.' };
        }
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { error: 'meta must be an object.' };
    }
    const capturedAt = meta.capturedAt ? new Date(meta.capturedAt) : null;
    const trigger = ['schedule', 'rpc', 'boot'].includes(meta.trigger) ? meta.trigger : undefined;
    const battery = meta.battery && typeof meta.battery === 'object'
        ? strip({ mv: num(meta.battery.mv), pct: num(meta.battery.pct), charging: typeof meta.battery.charging === 'boolean' ? meta.battery.charging : undefined, solarMv: num(meta.battery.solarMv) })
        : undefined;
    const location = meta.location && typeof meta.location === 'object' && num(meta.location.lat) !== undefined && num(meta.location.lng) !== undefined
        ? strip({ lat: num(meta.location.lat), lng: num(meta.location.lng), fixAt: meta.location.fixAt && !isNaN(new Date(meta.location.fixAt)) ? new Date(meta.location.fixAt) : undefined })
        : undefined;
    return {
        value: strip({
            v: num(meta.v),
            serial: typeof meta.serial === 'string' ? meta.serial.slice(0, 64) : undefined,
            capturedAt: capturedAt && !isNaN(capturedAt) ? capturedAt : undefined,
            trigger,
            battery: battery && Object.keys(battery).length ? battery : undefined,
            net: ['wifi', '4g'].includes(meta.net) ? meta.net : undefined,
            rssi: num(meta.rssi),
            location,
            fw: typeof meta.fw === 'string' ? meta.fw.slice(0, 40) : undefined
        })
    };
}

/** When the camera should wake next, from its schedule (a hint; the shadow is the rule). */
function nextWakeAt(camera, now = new Date()) {
    const schedule = deviceSchedules([camera], now).get(camera.deviceSerial);
    const minutes = CAPTURE_INTERVALS.includes(schedule?.intervalMinutes) ? schedule.intervalMinutes : 30;
    return new Date(now.getTime() + minutes * 60 * 1000);
}

/**
 * POST /api/device/snapshot: store the photo (same pipeline as EZVIZ photos), remember what the
 * camera reported, answer right away and analyze in the background (a camera on battery must
 * not wait for the Lambda). Returns { status, body }.
 */
async function storeDeviceSnapshot(camera, { image, meta: rawMeta, imageType }, now = new Date()) {
    if (!Buffer.isBuffer(image) || !image.length) return { status: 400, body: { ok: false, error: 'bad_request', message: 'image part is required.' } };
    if (image.length > MAX_IMAGE_BYTES) return { status: 413, body: { ok: false, error: 'too_large', message: `image must be at most ${MAX_IMAGE_BYTES} bytes.` } };
    if ((imageType && imageType !== 'image/jpeg') || !isJpeg(image)) return { status: 415, body: { ok: false, error: 'unsupported_type', message: 'image must be a JPEG.' } };
    const meta = readMeta(rawMeta);
    if (meta.error) return { status: 400, body: { ok: false, error: 'bad_request', message: meta.error } };
    const m = meta.value;
    // Paused by an admin: 403 (never 401, which would make the camera drop its registration), next try in 6 h
    if (camera.adminDisabled?.at) {
        // Still awake and reachable: a firmware update may go
        await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $set: strip({ status: 1, 'device.lastSeenAt': now, 'device.sleeping': false, 'device.fw': m.fw, 'device.battery': m.battery }) });
        require('./firmwareService').cameraAwake(camera.deviceSerial);
        return { status: 403, body: { ok: false, error: 'disabled', message: 'This camera is paused by an administrator.', nextWakeAt: new Date(now.getTime() + DISABLED_RETRY_MS).toISOString() } };
    }
    // Self-registered cameras: 1 photo an hour while unclaimed, the demo's daily cap after
    const registration = require('./registrationService');
    const limited = await registration.uploadLimit(camera, now);
    if (limited) return limited;
    // A clock far off (no NTP yet) must not file the photo in the past or the future
    const capturedAt = m.capturedAt && Math.abs(m.capturedAt.getTime() - now.getTime()) < 7 * 24 * 3600 * 1000 ? m.capturedAt : now;

    const captureJob = require('../cron/captureJob');
    const saved = await captureJob.storeSnapshot(camera.deviceSerial, image, { trigger: m.trigger, meta: m, capturedAt });
    if (camera.selfRegistered && camera.unclaimed) await registration.markUnclaimedPhoto(saved, now);
    const set = strip({
        status: 1,
        lastCaptureAt: now,
        'device.lastSeenAt': now,
        'device.sleeping': false,
        'device.fw': m.fw,
        'device.net': m.net,
        'device.rssi': m.rssi,
        'device.battery': m.battery,
        'device.location': m.location
    });
    await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $set: set });
    // Awake: a reported version may finish a firmware update, and a pending one can go now
    const firmware = require('./firmwareService');
    Promise.resolve(m.fw ? firmware.versionReported(camera.deviceSerial, m.fw, now) : null)
        .then(() => firmware.cameraAwake(camera.deviceSerial))
        .catch(err => console.warn(`⚠️ Firmware check ${camera.deviceSerial}: ${err.message}`));
    if (m.location && (camera.latitude === null || camera.latitude === undefined)) {
        await Camera.updateMany({ deviceSerial: camera.deviceSerial, latitude: null }, { $set: { latitude: m.location.lat, longitude: m.location.lng } }).catch(() => {});
    }
    // A GPS fix in another timezone: the shadow's tz follows (no-op when it did not change)
    if (m.location) require('./timezoneService').syncCamera(camera.deviceSerial).catch(() => {});
    // Whoever asked for this photo (platforms/camos.js snapshot) gets it now
    require('../platforms/camos').snapshotArrived(camera.deviceSerial, saved);
    // AI, alerts, quality, webhook: in the background
    captureJob.finishSnapshot(saved, image).catch(err => console.error(`❌ Device photo processing failed (${camera.deviceSerial}):`, err.message));
    return {
        status: 200,
        body: { ok: true, snapshotId: String(saved._id), nextWakeAt: (camera.selfRegistered && camera.unclaimed ? registration.unclaimedNextWake(now) : nextWakeAt(camera, now)).toISOString() }
    };
}

// ---------- Time and OTA ----------

const timeNow = (now = new Date()) => ({ now: now.toISOString(), epoch: Math.floor(now.getTime() / 1000) });

/** The firmware offered (env DEVICE_OTA_*), or null when there is none or the camera already runs it. */
function otaManifest(camera) {
    if (!env.DEVICE_OTA_FW || !env.DEVICE_OTA_URL || !/^[a-f0-9]{64}$/.test(env.DEVICE_OTA_SHA256)) return null;
    if (camera?.device?.fw && camera.device.fw === env.DEVICE_OTA_FW) return null;
    return { fw: env.DEVICE_OTA_FW, url: env.DEVICE_OTA_URL, sha256: env.DEVICE_OTA_SHA256 };
}

module.exports = {
    SERIAL,
    TOKEN,
    MAX_IMAGE_BYTES,
    PROVISION_TTL_MS,
    sha256,
    issueProvisionToken,
    pair,
    authenticate,
    readMeta,
    nextWakeAt,
    storeDeviceSnapshot,
    timeNow,
    otaManifest
};
