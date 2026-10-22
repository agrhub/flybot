const crypto = require('crypto');
const env = require('../config/env');
const { Camera, Snapshot } = require('../models');
const { CAPTURE_INTERVALS } = require('../services/captureSchedule');
const aws = require('./aws');

/**
 * CameraPlatform "camos": the CamOS cameras (ESP32-S3 trap, AMB82) on AWS IoT Core, protocol v1
 * (camos-esp32-trap docs/protocol-v1.md) with the v1 additions of flybot-aws CONTRACTS section 3.
 *
 *  - cloud -> camera: the classic Device Shadow of thing `<serial>` (desired), and RPC messages
 *    published on `camos/<serial>/rpc/req`, both through the IoT data plane (AWS SDK).
 *  - camera -> cloud: `camos/<serial>/{state,event,telemetry,rpc/res}`, the shadow's reported
 *    side and the lifecycle events, delivered by platforms/iotEvents.js (MQTT over WebSocket) or
 *    an IoT rule posting to /api/device/events. Both end in `handleMessage`.
 *  - photos: the camera uploads them itself to the device API (routes/deviceRoutes.js), which
 *    stores them through the same pipeline as EZVIZ photos; `snapshot()` asks for one (RPC
 *    `snapshot.now`) and waits for that upload.
 */
const PLATFORM = 'camos';
const SERIAL = /^[A-Za-z0-9_-]{1,64}$/;
// An RPC answer, and the photo after `snapshot.now`, are waited for this long
const RPC_TIMEOUT_MS = 20000;
const SNAPSHOT_TIMEOUT_MS = 70000;
// A camera that said nothing for this long is shown offline
const OFFLINE_AFTER_MS = 2 * 60 * 60 * 1000;

const thingNameOf = (camera, deviceSerial) => camera?.device?.thingName || deviceSerial;
const topic = (deviceSerial, suffix) => `camos/${deviceSerial}/${suffix}`;

// Waiters: RPC answers by id, and the next uploaded photo by serial
const pendingRpc = new Map();
const pendingSnapshots = new Map();

function listCameras(filter = {}) {
    return Camera.find({ ...filter, platform: PLATFORM });
}

// ---------- Shadow ----------

const decode = (payload) => {
    if (!payload) return null;
    const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/** The shadow document's `state` ({ desired, reported, delta }), or null when there is none yet. */
async function getShadow(deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial }).select('device.thingName').lean();
    const { GetThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');
    try {
        const res = await aws.getClient('iotData').send(new GetThingShadowCommand({ thingName: thingNameOf(camera, deviceSerial) }));
        return decode(res?.payload)?.state || null;
    } catch (err) {
        if (err?.name === 'ResourceNotFoundException') return null;
        throw err;
    }
}

/** Merge `desired` into the shadow's desired state and remember it on the camera. */
// Desired keys FlyBot wrote once that the firmware answers NOT_SUPPORTED on every apply (shadow.c): `tz` (it reads
// `timezone`) and `video.image.wdr` (no WDR control on the OV5640). Removed from the shadow at the next write.
const LEGACY_DESIRED = ['tz', 'video.image.wdr'];

function getAt(obj, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function setAt(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {});
    o[keys[keys.length - 1]] = value;
}

/** A desired document without null leaves (null asks AWS to delete a key; the camera must not see it), keeping `log: null`. */
function pruneNulls(obj, top = true) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === null) { if (top && k === 'log') out[k] = null; continue; }
        out[k] = v && typeof v === 'object' && !Array.isArray(v) ? pruneNulls(v, false) : v;
    }
    return out;
}

async function updateDesired(deviceSerial, desired) {
    const camera = await Camera.findOne({ deviceSerial }).select('device.thingName device.shadow.desired').lean();
    desired = JSON.parse(JSON.stringify(desired || {}));
    for (const path of LEGACY_DESIRED) if (getAt(camera?.device?.shadow?.desired, path) !== undefined && getAt(desired, path) === undefined) setAt(desired, path, null);
    const { UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');
    const res = await aws.getClient('iotData').send(new UpdateThingShadowCommand({
        thingName: thingNameOf(camera, deviceSerial),
        payload: Buffer.from(JSON.stringify({ state: { desired } }))
    }));
    const merged = pruneNulls(deepMerge(camera?.device?.shadow?.desired || {}, desired));
    await Camera.updateMany({ deviceSerial }, { $set: { 'device.shadow.desired': merged, 'device.shadow.desiredAt': new Date() } });
    const answer = decode(res?.payload);
    // The camos-esp32-trap firmware reads its settings from camos/<serial>/shadow/desired (protocol 8), not from the
    // AWS shadow: publish the whole desired document there too, retained, so a camera that sleeps gets it at connect
    const version = Number.isInteger(answer?.version) ? answer.version : Math.floor(Date.now() / 1000);
    await publish(deviceSerial, 'shadow/desired', { ...merged, version }, { retain: true })
        .catch(err => console.warn(`⚠️ Desired settings not published to the camera (${deviceSerial}): ${err.message}`));
    return answer?.state || { desired: merged };
}

function deepMerge(base, patch) {
    const out = { ...(base || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
        out[key] = value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object'
            ? deepMerge(out[key], value)
            : value;
    }
    return out;
}

// ---------- RPC ----------

async function publish(deviceSerial, suffix, message, { retain = false } = {}) {
    const { PublishCommand } = require('@aws-sdk/client-iot-data-plane');
    await aws.getClient('iotData').send(new PublishCommand({
        topic: topic(deviceSerial, suffix),
        qos: 1,
        ...(retain ? { retain: true } : {}),
        payload: Buffer.from(JSON.stringify(message))
    }));
}

/**
 * Send an RPC (`snapshot.now`, `live.start` { minutes }, `live.stop`, `gps.fix`, `reboot`,
 * `ota.apply`, or any protocol v1 method). With `wait` the camera's answer on rpc/res is returned
 * ({ ok, result } or { ok: false, error }); without, { id, sent: true } as soon as it is published.
 */
async function rpc(deviceSerial, method, params = {}, { wait = false, timeoutMs = RPC_TIMEOUT_MS, timeoutS = 60 } = {}) {
    if (!SERIAL.test(String(deviceSerial))) throw new Error('Invalid serial');
    const id = crypto.randomUUID();
    const request = { v: 1, id, method, params: params || {}, timeoutS };
    let answer = null;
    if (wait) {
        answer = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRpc.delete(id);
                reject(Object.assign(new Error(`The camera did not answer ${method} in time.`), { code: 'TIMEOUT' }));
            }, timeoutMs);
            timer.unref?.();
            pendingRpc.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
        });
    }
    await publish(deviceSerial, 'rpc/req', request);
    return wait ? answer : { id, sent: true };
}

// ---------- Capture ----------

/**
 * Ask the camera for a photo now and wait for its upload (POST /api/device/snapshot, which
 * calls `snapshotArrived`). Returns { snapshot } (already stored) or null when nothing came.
 * A sleeping camera cannot answer: the request is left in the shadow (capture.requestNow) so
 * it takes a photo at its next wake, and null is returned.
 */
async function snapshot(deviceSerial, { timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
    const status = await getStatus(deviceSerial);
    if (!status) return null;
    if (!status.online || status.sleeping) {
        await updateDesired(deviceSerial, { capture: { requestNow: Date.now() } }).catch(err => console.warn(`⚠️ Shadow not updated (${deviceSerial}): ${err.message}`));
        return null;
    }
    const arrived = new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingSnapshots.delete(deviceSerial);
            resolve(null);
        }, timeoutMs);
        timer.unref?.();
        pendingSnapshots.set(deviceSerial, (doc) => { clearTimeout(timer); resolve(doc); });
    });
    try {
        await rpc(deviceSerial, 'snapshot.now', {});
    } catch (err) {
        pendingSnapshots.delete(deviceSerial);
        console.warn(`⚠️ snapshot.now not sent (${deviceSerial}): ${err.message}`);
        return null;
    }
    const doc = await arrived;
    return doc ? { snapshot: doc } : null;
}

/** The device API stored a photo of this camera (routes/deviceRoutes.js). */
function snapshotArrived(deviceSerial, doc) {
    const waiter = pendingSnapshots.get(deviceSerial);
    if (!waiter) return false;
    pendingSnapshots.delete(deviceSerial);
    waiter(doc);
    return true;
}

// ---------- Live ----------

/**
 * Live view: the KVS viewer config (platforms/kinesis.js). A camera on battery only joins the
 * channel when asked: `live.requested` goes into the shadow for its next wake, and `live.start`
 * is sent right away when it is awake.
 */
async function liveSession(deviceSerial, { user, minutes = 5 } = {}) {
    const kinesis = require('./kinesis');
    const status = await getStatus(deviceSerial);
    // A camera whose firmware has no cloud live view says so in its shadow (live.supported false): no
    // viewer session and no live request, the page offers a capture and the camera's local page instead
    if (status && status.liveSupported === false) {
        return { platform: PLATFORM, supported: false, camera: status, localUrl: status.localUrl };
    }
    const session = await kinesis.liveSession(deviceSerial, { user });
    const live = await requestLive(deviceSerial, { minutes, status }).catch(err => ({ requested: false, error: err.message }));
    return { ...session, supported: true, camera: status, live };
}

/**
 * The camera's own web page on its local network: camos-esp32-trap firmware 0.4.1 and later answers
 * flybot-<last 6 letters/digits of the serial>.local over mDNS. Null for other cameras (AMB82, older firmware).
 */
/** The credential provider host and role alias a camera needs for live view, or null when this server has none. */
function liveCredentials() {
    return env.IOT_CREDENTIALS_ENDPOINT && env.IOT_ROLE_ALIAS
        ? { credentialsEndpoint: env.IOT_CREDENTIALS_ENDPOINT, roleAlias: env.IOT_ROLE_ALIAS }
        : null;
}

/**
 * A camera that registered before this server had live credentials reports live.supported false: give it the
 * credential provider and role alias through the shadow (desired kvs.*), once per alias.
 */
async function offerLiveCredentials(deviceSerial, reported) {
    const creds = liveCredentials();
    if (!creds || reported?.live?.supported !== false) return false;
    const camera = await Camera.findOne({ deviceSerial, platform: PLATFORM }).select('device.liveCredsAlias device.kvsChannelName').lean();
    if (!camera || camera.device?.liveCredsAlias === creds.roleAlias) return false;
    const channelName = camera.device?.kvsChannelName || require('./kinesis').channelNameOf(deviceSerial);
    await updateDesired(deviceSerial, { kvs: { region: env.AWS_REGION, channelName, ...creds } });
    await Camera.updateMany({ deviceSerial, platform: PLATFORM }, { $set: { 'device.liveCredsAlias': creds.roleAlias } });
    return true;
}

/**
 * A live request is taken once the camera reports it (live.requested true: it applied the desired document and starts
 * the session) or a session (live.active): reset desired live.requested, or the retained desired document would
 * start a new session at every connect of the camera.
 */
async function settleLiveRequest(deviceSerial, reported) {
    if (reported?.live?.requested !== true && reported?.live?.active !== true) return false;
    const camera = await Camera.findOne({ deviceSerial, platform: PLATFORM }).select('device.shadow.desired.live').lean();
    if (camera?.device?.shadow?.desired?.live?.requested !== true) return false;
    await updateDesired(deviceSerial, { live: { requested: false } });
    await Camera.updateMany({ deviceSerial, platform: PLATFORM }, { $set: { 'device.liveRequested': false } });
    return true;
}

function localConsoleUrl(deviceSerial, fw) {
    if (!/^ESP/i.test(String(deviceSerial || ''))) return null;
    const v = String(fw || '').match(/(\d+)\.(\d+)\.(\d+)/);
    if (!v || Number(v[1]) * 1e6 + Number(v[2]) * 1e3 + Number(v[3]) < 4001) return null;
    const tail = String(deviceSerial).replace(/[^A-Za-z0-9]/g, '').slice(-6).toLowerCase();
    return `http://flybot-${tail}.local/`;
}

/**
 * Ask for a live session: shadow `live.requested` (used at the next wake) and RPC `live.start`
 * when the camera is awake. Returns { requested, sent, nextWakeAt }.
 */
async function requestLive(deviceSerial, { minutes = 5, status = null } = {}) {
    const now = new Date();
    const state = status || await getStatus(deviceSerial);
    await Camera.updateMany({ deviceSerial }, { $set: { 'device.liveRequested': true, 'device.liveRequestedAt': now } });
    await updateDesired(deviceSerial, { live: { requested: true, minutes } }).catch(err => console.warn(`⚠️ Shadow not updated (${deviceSerial}): ${err.message}`));
    let sent = false;
    if (state?.online && !state.sleeping) {
        await rpc(deviceSerial, 'live.start', { minutes }).then(() => { sent = true; }).catch(err => console.warn(`⚠️ live.start not sent (${deviceSerial}): ${err.message}`));
    }
    return { requested: true, sent, nextWakeAt: state?.nextWakeAt || null };
}

// ---------- Playback: the snapshot timeline ----------

async function playback(deviceSerial, { from, to, limit = 200 } = {}) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    const items = await Snapshot.find({ deviceSerial, ...(Object.keys(range).length ? { createdAt: range } : {}) })
        .sort({ createdAt: -1 }).limit(Math.min(limit, 1000))
        .select('_id createdAt s3Key imageUrl aiProcessed pestCount trigger quality.issues lambda.traceId').lean();
    return {
        platform: PLATFORM,
        kind: 'snapshots',
        items: items.map(s => ({
            id: String(s._id),
            at: s.createdAt,
            imageKey: s.s3Key,
            count: s.aiProcessed ? s.pestCount ?? null : null,
            trigger: s.trigger || null,
            issues: s.quality?.issues || [],
            traceId: s.lambda?.traceId || null
        }))
    };
}

// ---------- Schedule and status ----------

/** The capture interval goes into the shadow (capture.intervalMin) and stays FlyBot's record too. */
async function setCaptureSchedule(deviceSerial, minutes) {
    if (!CAPTURE_INTERVALS.includes(minutes)) throw new Error(`minutes must be one of ${CAPTURE_INTERVALS.join(', ')}`);
    await Camera.updateMany({ deviceSerial }, { $set: { captureIntervalMinutes: minutes } });
    await updateDesired(deviceSerial, { capture: { intervalMin: minutes } });
    return { platform: PLATFORM, minutes, applied: 'shadow' };
}

/** When the camera will next wake (from its goodbye/LWT), or the schedule's best guess. */
function nextWakeOf(camera, now = new Date()) {
    const wake = camera.device?.wakeAt ? new Date(camera.device.wakeAt) : null;
    if (wake && wake > now) return wake;
    const last = camera.device?.lastSeenAt ? new Date(camera.device.lastSeenAt) : null;
    const minutes = CAPTURE_INTERVALS.includes(camera.captureIntervalMinutes) ? camera.captureIntervalMinutes : 30;
    if (!last) return null;
    let next = new Date(last.getTime() + minutes * 60 * 1000);
    while (next <= now && next.getTime() - now.getTime() > -24 * 3600 * 1000) next = new Date(next.getTime() + minutes * 60 * 1000);
    return next > now ? next : null;
}

/** Status for the UI: online, power mode, sleeping and next wake, battery, network. */
async function getStatus(deviceSerial, now = new Date()) {
    const camera = await Camera.findOne({ deviceSerial }).select('status captureIntervalMinutes lastSync device').lean();
    if (!camera) return null;
    const d = camera.device || {};
    const stale = d.lastSeenAt ? now.getTime() - new Date(d.lastSeenAt).getTime() > OFFLINE_AFTER_MS : true;
    const sleeping = !!d.sleeping && (!d.wakeAt || new Date(d.wakeAt) > now);
    return {
        platform: PLATFORM,
        online: Number(camera.status) === 1 && !stale && !sleeping,
        power: { mode: d.power?.mode || 'auto' },
        sleeping,
        wakeAt: sleeping ? d.wakeAt || null : null,
        nextWakeAt: sleeping || Number(camera.status) !== 1 ? nextWakeOf(camera, now) : null,
        lastSeenAt: d.lastSeenAt || null,
        battery: d.battery || null,
        net: d.net || null,
        rssi: d.rssi ?? null,
        location: d.location || null,
        fw: d.fw || null,
        liveRequested: !!d.liveRequested,
        // false only when the camera reports it (shadow live.supported); cameras that do not report it keep live view
        liveSupported: d.shadow?.reported?.live?.supported !== false,
        localUrl: localConsoleUrl(deviceSerial, d.fw),
        paired: !!d.tokenHash,
        kvsChannelName: d.kvsChannelName || null
    };
}

// ---------- Camera -> cloud messages ----------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
const dateOf = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)) : undefined);
const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** Fields of Camera.device from a state / telemetry / reported-shadow document. */
function deviceFieldsOf(doc) {
    if (!doc || typeof doc !== 'object') return {};
    const battery = doc.battery && typeof doc.battery === 'object'
        ? strip({ mv: num(doc.battery.mv), pct: num(doc.battery.pct), charging: typeof doc.battery.charging === 'boolean' ? doc.battery.charging : undefined, solarMv: num(doc.battery.solarMv) })
        : undefined;
    const gps = doc.location || doc.gps;
    const location = gps && typeof gps === 'object' && num(gps.lat) !== undefined
        ? strip({ lat: num(gps.lat), lng: num(gps.lng ?? gps.lon), fixAt: gps.fixAt ? new Date(gps.fixAt) : dateOf(gps.ts) })
        : undefined;
    const net = typeof doc.net === 'string' ? doc.net : (doc.net && typeof doc.net === 'object' ? doc.net.type : undefined);
    const rssi = num(doc.rssi ?? doc.net?.rssi);
    const power = doc.power && typeof doc.power === 'object' && ['auto', 'battery', 'powered'].includes(doc.power.mode) ? { mode: doc.power.mode } : undefined;
    // 4G modem (state net.cell, protocol 4; firmware 0.7.0+ also top-level modem.*): kept while on Wi-Fi again
    const cell = (doc.net && typeof doc.net === 'object' && doc.net.cell && typeof doc.net.cell === 'object') ? doc.net.cell : (doc.modem && typeof doc.modem === 'object' ? doc.modem : {});
    const ident = (v, re) => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : undefined);
    return strip({
        model: ident(doc.model, /^[A-Za-z0-9._-]{1,64}$/),
        'device.imei': ident(cell.imei, /^[0-9]{14,17}$/),
        'device.iccid': ident(cell.iccid, /^[0-9A-Fa-f]{18,22}$/),
        'device.operator': typeof cell.operator === 'string' && cell.operator.trim() ? cell.operator.trim().slice(0, 40) : undefined,
        'device.hw': ident(doc.hw, /^[A-Za-z0-9._-]{1,32}$/),
        'device.mac': ident(doc.mac, /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/),
        // reported log {on, level, until, session} (remote log, firmware 0.8.0+)
        ...(doc.log && typeof doc.log === 'object' && typeof doc.log.on === 'boolean' ? {
            'device.log.on': doc.log.on,
            'device.log.level': typeof doc.log.level === 'string' ? doc.log.level.slice(0, 8) : undefined,
            'device.log.until': doc.log.until && !isNaN(new Date(doc.log.until)) ? new Date(doc.log.until) : undefined,
            'device.log.session': typeof doc.log.session === 'string' ? doc.log.session.slice(0, 24) : undefined
        } : {}),
        'device.fw': typeof doc.fw === 'string' ? doc.fw.slice(0, 40) : undefined,
        'device.net': net && ['wifi', '4g'].includes(net) ? net : undefined,
        'device.rssi': rssi,
        'device.battery': battery && Object.keys(battery).length ? battery : undefined,
        'device.location': location,
        'device.power': power,
        'device.kvsChannelName': typeof doc.kvs?.channelName === 'string' ? doc.kvs.channelName.slice(0, 256) : undefined,
        ...(Number.isInteger(doc.capture?.intervalMin) && CAPTURE_INTERVALS.includes(doc.capture.intervalMin) ? { captureIntervalMinutes: doc.capture.intervalMin } : {})
    });
}

/**
 * The camera is awake and talking: a reported version may finish its firmware update, and a pending one is sent
 * now (services/firmwareService.js). In the background; never throws.
 */
function firmwareAware(deviceSerial, fw, now = new Date()) {
    const firmware = require('../services/firmwareService');
    Promise.resolve(fw ? firmware.versionReported(deviceSerial, fw, now) : null)
        .then(() => firmware.cameraAwake(deviceSerial))
        .catch(err => console.warn(`⚠️ Firmware check ${deviceSerial}: ${err.message}`));
}

/**
 * The camera's first MQTT message or connection: a self-registered camera can no longer
 * re-register with the same serial after this (CONTRACTS 2a.2).
 */
async function markConnected(deviceSerial, at = new Date()) {
    await Camera.updateMany({ deviceSerial, platform: PLATFORM, 'device.firstConnectAt': { $exists: false } }, { $set: { 'device.firstConnectAt': at } }).catch(() => {});
}

async function setOnline(deviceSerial, online, at = new Date(), extra = {}) {
    const before = await Camera.findOne({ deviceSerial, platform: PLATFORM }).select('status deviceName').lean();
    if (!before) return false;
    const set = { status: online ? 1 : 0, lastSync: at, ...extra };
    if (online) Object.assign(set, { 'device.sleeping': false, 'device.lastSeenAt': at });
    await Camera.updateMany({ deviceSerial }, { $set: set });
    if (Number(before.status) !== (online ? 1 : 0)) {
        require('../services/notificationService').cameraStatusChanged(deviceSerial, online ? 1 : 0)
            .catch(err => console.error(`⚠️ Status alert failed (${deviceSerial}):`, err.message));
    }
    return true;
}

/**
 * One message from a camera (MQTT subscriber or the IoT rule webhook). `topic` is the MQTT
 * topic, `payload` the JSON (object, string or bytes). Returns what was done, or null when the
 * topic is not one of ours. Never throws on a bad payload.
 */
async function handleMessage(topicName, payload, { now = new Date() } = {}) {
    const doc = typeof payload === 'object' && payload !== null && !Buffer.isBuffer(payload) && !(payload instanceof Uint8Array) ? payload : decode(payload);
    const camos = String(topicName || '').match(/^camos\/([A-Za-z0-9_-]{1,64})\/(state|event|telemetry|rpc\/res|shadow\/reported|log)$/);
    if (camos) {
        const [, deviceSerial, kind] = camos;
        if (!doc || typeof doc !== 'object') return { deviceSerial, kind, ignored: 'bad payload' };
        await markConnected(deviceSerial, now);
        if (kind === 'log') {
            // Remote console log (services/cameraLogService.js), on request only
            const stored = await require('../services/cameraLogService').ingestBatch(deviceSerial, doc, { now });
            return { deviceSerial, kind, stored };
        }
        if (kind === 'rpc/res') {
            const waiter = pendingRpc.get(String(doc.id || ''));
            if (waiter) {
                pendingRpc.delete(String(doc.id));
                waiter.resolve({ ok: doc.ok !== false, result: doc.result ?? null, error: doc.error ?? null });
            }
            await Camera.updateMany({ deviceSerial, platform: PLATFORM }, { $set: { 'device.lastSeenAt': now } });
            return { deviceSerial, kind, answered: !!waiter };
        }
        if (kind === 'state') {
            const online = doc.online !== false;
            const fields = deviceFieldsOf(doc);
            if (online) await setOnline(deviceSerial, true, now, fields);
            else await setOnline(deviceSerial, false, now, { ...fields, ...(doc.sleeping ? { 'device.sleeping': true, 'device.wakeAt': dateOf(doc.wakeAt) } : {}) });
            if (online) firmwareAware(deviceSerial, fields['device.fw'], now);
            return { deviceSerial, kind, online };
        }
        if (kind === 'telemetry' || kind === 'shadow/reported') {
            const fields = deviceFieldsOf(doc);
            const set = { ...fields, 'device.lastSeenAt': now };
            if (kind === 'shadow/reported') Object.assign(set, { 'device.shadow.reported': doc, 'device.shadow.reportedAt': now });
            if (kind === 'shadow/reported') await offerLiveCredentials(deviceSerial, doc).catch(err => console.warn(`⚠️ Live credentials not offered (${deviceSerial}): ${err.message}`));
            if (kind === 'shadow/reported') await settleLiveRequest(deviceSerial, doc).catch(err => console.warn(`⚠️ Live request not reset (${deviceSerial}): ${err.message}`));
            await Camera.updateMany({ deviceSerial, platform: PLATFORM }, { $set: set });
            firmwareAware(deviceSerial, fields['device.fw'], now);
            return { deviceSerial, kind };
        }
        // event
        const type = String(doc.type || '');
        const set = { 'device.lastSeenAt': now, ...deviceFieldsOf(doc) };
        if (type === 'goodbye' || doc.sleeping === true) {
            const wakeAt = dateOf(doc.wakeAt);
            await Camera.updateMany({ deviceSerial, platform: PLATFORM }, { $set: { ...set, 'device.sleeping': true, 'device.wakeAt': wakeAt, status: 0 } });
            return { deviceSerial, kind, type: 'goodbye', wakeAt: wakeAt || null };
        }
        if (type === 'boot') await setOnline(deviceSerial, true, now, set);
        else await Camera.updateMany({ deviceSerial, platform: PLATFORM }, { $set: set });
        // How the previous boot ended (crash, watchdog, brownout): kept for the camera's log page
        if (type === 'crash') {
            await require('../services/cameraLogService').ingestCrash(deviceSerial, doc, { now })
                .catch(err => console.warn(`⚠️ Crash report ${deviceSerial}: ${err.message}`));
        }
        // Firmware updates: progress, result, and the boot that confirms (or rolls back) the new version
        const ota = await require('../services/firmwareService').handleEvent(deviceSerial, doc, now)
            .catch(err => { console.warn(`⚠️ OTA event ${deviceSerial}: ${err.message}`); return null; });
        return { deviceSerial, kind, type, ...(ota ? { ota } : {}) };
    }
    const presence = String(topicName || '').match(/^\$aws\/events\/presence\/(connected|disconnected)\/([A-Za-z0-9_-]{1,64})$/);
    if (presence) {
        const [, what, clientId] = presence;
        const camera = await Camera.findOne({ platform: PLATFORM, $or: [{ deviceSerial: clientId }, { 'device.thingName': clientId }] }).select('deviceSerial device.connectedAt device.connectedSession').lean();
        if (!camera) return { clientId, kind: 'presence', ignored: 'unknown camera' };
        // IoT Core's own event time; events can arrive out of order (a short power cut: the new session's connect,
        // then the old session's keepalive timeout)
        const at = Number.isFinite(Number(doc?.timestamp)) && Number(doc.timestamp) > 0 ? new Date(Number(doc.timestamp)) : now;
        const session = typeof doc?.sessionIdentifier === 'string' ? doc.sessionIdentifier.slice(0, 64) : undefined;
        if (what === 'connected') {
            await markConnected(camera.deviceSerial, now);
            await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $set: { 'device.connectedAt': at, ...(session ? { 'device.connectedSession': session } : {}) } });
            await setOnline(camera.deviceSerial, true, now);
            console.log(`📡 ${camera.deviceSerial} connected`);
            return { deviceSerial: camera.deviceSerial, kind: 'presence', online: true };
        }
        const reason = typeof doc?.disconnectReason === 'string' ? doc.disconnectReason : '';
        const lastConnect = camera.device?.connectedAt ? new Date(camera.device.connectedAt) : null;
        // Not the session that connected last: the camera already has a newer connection
        const older = reason === 'DUPLICATE_CLIENTID'
            || (session && camera.device?.connectedSession && session !== camera.device.connectedSession)
            || (lastConnect && at < lastConnect);
        if (older) {
            console.log(`📡 ${camera.deviceSerial} disconnect of an older session ignored (${reason || 'stale'})`);
            return { deviceSerial: camera.deviceSerial, kind: 'presence', ignored: 'older session' };
        }
        await setOnline(camera.deviceSerial, false, now);
        console.log(`📡 ${camera.deviceSerial} disconnected (${reason || 'no reason'})`);
        return { deviceSerial: camera.deviceSerial, kind: 'presence', online: false };
    }
    const shadow = String(topicName || '').match(/^\$aws\/things\/([A-Za-z0-9_:-]{1,128})\/shadow\/update\/(accepted|documents)$/);
    if (shadow) {
        const [, thingName, what] = shadow;
        const camera = await Camera.findOne({ platform: PLATFORM, $or: [{ deviceSerial: thingName }, { 'device.thingName': thingName }] }).select('deviceSerial').lean();
        if (!camera) return { thingName, kind: 'shadow', ignored: 'unknown camera' };
        const state = what === 'documents' ? doc?.current?.state : doc?.state;
        const reported = state?.reported;
        if (!reported || typeof reported !== 'object') return { deviceSerial: camera.deviceSerial, kind: 'shadow', ignored: 'no reported state' };
        const set = { ...deviceFieldsOf(reported), 'device.lastSeenAt': now, 'device.shadow.reported': reported, 'device.shadow.reportedAt': now };
        if (reported.live && typeof reported.live === 'object' && reported.live.requested === false) set['device.liveRequested'] = false;
        await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $set: set });
        await offerLiveCredentials(camera.deviceSerial, reported).catch(err => console.warn(`⚠️ Live credentials not offered (${camera.deviceSerial}): ${err.message}`));
        await settleLiveRequest(camera.deviceSerial, reported).catch(err => console.warn(`⚠️ Live request not reset (${camera.deviceSerial}): ${err.message}`));
        return { deviceSerial: camera.deviceSerial, kind: 'shadow' };
    }
    return null;
}

/** Topics the subscriber listens to (platforms/iotEvents.js). */
const SUBSCRIPTIONS = [
    'camos/+/state', 'camos/+/event', 'camos/+/telemetry', 'camos/+/rpc/res', 'camos/+/shadow/reported', 'camos/+/log',
    '$aws/events/presence/connected/+', '$aws/events/presence/disconnected/+',
    '$aws/things/+/shadow/update/accepted'
];

module.exports = {
    PLATFORM,
    SUBSCRIPTIONS,
    RPC_TIMEOUT_MS,
    SNAPSHOT_TIMEOUT_MS,
    thingNameOf,
    listCameras,
    getShadow,
    updateDesired,
    rpc,
    snapshot,
    snapshotArrived,
    liveSession,
    localConsoleUrl,
    liveCredentials,
    offerLiveCredentials,
    requestLive,
    playback,
    setCaptureSchedule,
    getStatus,
    nextWakeOf,
    deviceFieldsOf,
    handleMessage
};
