const { Camera, CameraLog, CameraCrash } = require('../models');
const { MAX_LINES_PER_CAMERA } = require('../models/CameraLog');

/**
 * Remote console log of CamOS cameras (camos-esp32-trap logfwd.c, firmware 0.8.0+), for cameras nobody can plug a
 * cable into:
 *  - start / stop: shadow desired `log {level, until}` (a sleeping camera starts at its next wake) and, when the camera
 *    is awake, RPC `log.start {level, minutes, backlog}` / `log.stop` at once. At most 60 minutes.
 *  - batches on camos/<serial>/log {session, seq, uptimeMs, at, lines: ["I (123) tag: msg"], dropped, end}, or
 *    POST /api/device/logs {kind: crash | diag, lines, crash} when MQTT is down; secrets are removed on the camera.
 *  - the `crash` event (or kind crash): reason, last log lines before the reset, core dump summary.
 * Lines are kept 24 h, 20,000 per camera at most; crash reports 30 days. People who have the log open (POST .../watch
 * every minute) get new lines over their notification stream (SSE event `camera_log`).
 */
const LEVELS = ['error', 'warn', 'info', 'debug', 'verbose'];
const LEVEL_CHARS = { E: 1, W: 2, I: 3, D: 4, V: 5 };
const MAX_MINUTES = 60;
const MAX_LINE = 500;
const MAX_LINES_PER_BATCH = 400;
const WATCH_MS = 90 * 1000;
const TRIM_EVERY = 20;

const levelOf = (name) => LEVELS.indexOf(name) + 1;

/**
 * One esp_log line: "I (12345) tag: message" -> { lvl, tag, msg, ms } (ms since boot); anything else is info text.
 */
function parseLine(line) {
    const text = String(line || '').replace(/\u001b\[[0-9;]*m/g, '').slice(0, MAX_LINE);
    const m = text.match(/^([EWIDV]) \((\d+)\) ([^:]{0,40}): ?(.*)$/s);
    if (m) return { lvl: LEVEL_CHARS[m[1]], ms: Number(m[2]), tag: m[3].trim(), msg: m[4] };
    const short = text.match(/^([EWIDV]) \((\d+)\) (.*)$/s);
    if (short) return { lvl: LEVEL_CHARS[short[1]], ms: Number(short[2]), tag: '', msg: short[3] };
    return { lvl: 3, ms: null, tag: '', msg: text };
}

// ---------- People watching a camera's log ----------

const watchers = new Map(); // serial -> Map(userId -> expires)

function watch(serial, userId, now = Date.now()) {
    let m = watchers.get(serial);
    if (!m) watchers.set(serial, (m = new Map()));
    m.set(String(userId), now + WATCH_MS);
}

function unwatch(serial, userId) {
    watchers.get(serial)?.delete(String(userId));
}

function push(serial, lines, extra = {}) {
    const m = watchers.get(serial);
    if (!m) return 0;
    const now = Date.now();
    const sse = require('../realtime/sseHub');
    let sent = 0;
    for (const [userId, expires] of m) {
        if (expires < now) {
            m.delete(userId);
            continue;
        }
        sent += sse.sendToUser(userId, 'camera_log', { deviceSerial: serial, lines, ...extra });
    }
    if (!m.size) watchers.delete(serial);
    return sent;
}

// ---------- Ingest ----------

const batches = new Map(); // serial -> batches since the last trim

async function trim(serial) {
    const cut = await CameraLog.findOne({ deviceSerial: serial }).sort({ at: -1, _id: -1 }).skip(MAX_LINES_PER_CAMERA).select('at').lean();
    if (cut) await CameraLog.deleteMany({ deviceSerial: serial, at: { $lte: cut.at } });
}

const lineView = (l) => ({ at: l.at, lvl: l.lvl, tag: l.tag, msg: l.msg, session: l.session || '' });

/**
 * A batch of lines from a camera (MQTT log topic or the device API). Returns the number of lines stored.
 * Times: the camera's `at` (epoch ms, when its clock is set) minus how long ago, by its uptime stamp, each line was
 * written; without a clock, the time FlyBot received the batch.
 */
async function ingestBatch(deviceSerial, doc, { source = 'mqtt', now = new Date() } = {}) {
    if (!doc || typeof doc !== 'object') return 0;
    const exists = await Camera.exists({ deviceSerial, platform: 'camos' });
    if (!exists) return 0;
    const raw = Array.isArray(doc.lines) ? doc.lines.filter(l => typeof l === 'string').slice(0, MAX_LINES_PER_BATCH) : [];
    const at = Number.isFinite(Number(doc.at)) && Number(doc.at) > 1.6e12 ? Number(doc.at) : now.getTime();
    const uptime = Number.isFinite(Number(doc.uptimeMs)) ? Number(doc.uptimeMs) : null;
    const session = typeof doc.session === 'string' ? doc.session.slice(0, 24) : '';
    const seq = Number.isInteger(doc.seq) ? doc.seq : 0;
    const rows = raw.map((line, i) => {
        const p = parseLine(line);
        const lineAt = uptime !== null && p.ms !== null && p.ms <= uptime && uptime - p.ms < 7 * 24 * 3600 * 1000 ? at - (uptime - p.ms) : at;
        return { deviceSerial, session, seq: seq * 1000 + i, at: new Date(lineAt), lvl: p.lvl, tag: p.tag.slice(0, 40), msg: p.msg, source, receivedAt: now };
    });
    if (rows.length) {
        await CameraLog.insertMany(rows, { ordered: false });
        const n = (batches.get(deviceSerial) || 0) + 1;
        batches.set(deviceSerial, n);
        // Trimmed when a session starts and every TRIM_EVERY batches
        if (seq === 1 || n % TRIM_EVERY === 1) trim(deviceSerial).catch(err => console.warn(`⚠️ Log trim ${deviceSerial}: ${err.message}`));
    }
    const set = { 'device.log.lastLineAt': now };
    if (doc.end === true) Object.assign(set, { 'device.log.on': false });
    else if (session) Object.assign(set, { 'device.log.on': true, 'device.log.session': session });
    await Camera.updateMany({ deviceSerial }, { $set: set });
    push(deviceSerial, rows.map(lineView), { dropped: Number(doc.dropped) || 0, end: doc.end === true });
    return rows.length;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A crash report (event `crash`, or POST /api/device/logs kind crash). Returns the stored report. */
async function ingestCrash(deviceSerial, doc, { source = 'mqtt', now = new Date() } = {}) {
    if (!doc || typeof doc !== 'object') return null;
    if (!(await Camera.exists({ deviceSerial, platform: 'camos' }))) return null;
    const cd = doc.coredump && typeof doc.coredump === 'object' ? doc.coredump : null;
    const report = await CameraCrash.create({
        deviceSerial,
        at: now,
        reason: str(doc.reason, 32),
        detail: str(doc.detail, 32),
        fw: str(doc.fw, 40),
        logTail: str(doc.logTail, 4096),
        coredump: cd ? {
            task: str(cd.task, 32) || undefined,
            pc: str(cd.pc, 12) || undefined,
            backtrace: Array.isArray(cd.backtrace) ? cd.backtrace.filter(a => typeof a === 'string' && /^0x[0-9a-fA-F]{1,8}$/.test(a)).slice(0, 32) : undefined,
            corrupted: typeof cd.corrupted === 'boolean' ? cd.corrupted : undefined,
            elfSha256: str(cd.elfSha256, 64) || undefined
        } : undefined,
        source
    });
    await Camera.updateMany({ deviceSerial }, { $set: { 'device.lastCrash': { at: now, reason: report.reason, fw: report.fw } } });
    console.warn(`💥 Camera ${deviceSerial} restarted after ${report.reason || 'a crash'} (fw ${report.fw || '?'})`);
    push(deviceSerial, [], { crash: crashView(report.toObject()) });
    return report;
}

/**
 * POST /api/device/logs { v, kind: crash | diag, fw, uptimeMs, lines, crash }: what a camera sends over HTTPS when it
 * cannot reach MQTT. Returns { status, body }.
 */
async function deviceReport(camera, body, now = new Date()) {
    const b = body && typeof body === 'object' ? body : {};
    if (!['crash', 'diag'].includes(b.kind)) return { status: 400, body: { ok: false, error: 'bad_request', message: 'kind must be crash or diag.' } };
    if (b.kind === 'crash') await ingestCrash(camera.deviceSerial, b.crash, { source: 'http', now });
    const stored = await ingestBatch(camera.deviceSerial, { session: `http-${b.kind}`, uptimeMs: b.uptimeMs, lines: b.lines }, { source: 'http', now });
    return { status: 200, body: { ok: true, stored } };
}

// ---------- Owners and admins ----------

/**
 * Turn the remote log on for `minutes` (1-60) at `level`: shadow desired log {level, until} for a sleeping camera,
 * RPC log.start now when it is awake.
 */
async function start(camera, { level = 'info', minutes = 15 } = {}, now = new Date()) {
    if ((camera.platform || 'ezviz') !== 'camos') return { status: 400, body: { success: false, code: 'NOT_CAMOS', message: 'Only CamOS cameras send their log.' } };
    if (camera.simulated) return { status: 409, body: { success: false, code: 'SIMULATED_CAMERA', message: 'A simulated camera has no log.' } };
    if (!LEVELS.includes(level)) return { status: 400, body: { success: false, message: 'level must be error, warn, info, debug or verbose.' } };
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return { status: 400, body: { success: false, message: 'minutes must be 1 to 60.' } };
    const until = new Date(now.getTime() + minutes * 60 * 1000);
    const camos = require('../platforms/camos');
    await camos.updateDesired(camera.deviceSerial, { log: { level, until: until.toISOString() } });
    let sent = false;
    const status = await camos.getStatus(camera.deviceSerial, now);
    if (status?.online && !status.sleeping) {
        sent = await camos.rpc(camera.deviceSerial, 'log.start', { level, minutes, backlog: true }).then(() => true, () => false);
    }
    await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $set: { 'device.log.requestedLevel': level, 'device.log.requestedUntil': until } });
    return { status: 200, body: { success: true, level, until, sent, nextWakeAt: status?.nextWakeAt || null } };
}

async function stop(camera, now = new Date()) {
    if ((camera.platform || 'ezviz') !== 'camos') return { status: 400, body: { success: false, code: 'NOT_CAMOS', message: 'Only CamOS cameras send their log.' } };
    const camos = require('../platforms/camos');
    await camos.updateDesired(camera.deviceSerial, { log: null });
    const status = await camos.getStatus(camera.deviceSerial, now);
    let sent = false;
    if (status?.online && !status.sleeping) sent = await camos.rpc(camera.deviceSerial, 'log.stop', {}).then(() => true, () => false);
    await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $unset: { 'device.log.requestedLevel': 1, 'device.log.requestedUntil': 1 } });
    return { status: 200, body: { success: true, sent } };
}

/** The camera's log state for the page. */
function stateOf(camera, now = new Date()) {
    const l = camera.device?.log || {};
    const requested = l.requestedUntil && new Date(l.requestedUntil) > now;
    return {
        on: !!l.on && !!(requested || (l.until && new Date(l.until) > now)),
        requested: !!requested,
        level: l.requestedLevel || l.level || null,
        until: requested ? l.requestedUntil : (l.until || null),
        lastLineAt: l.lastLineAt || null,
        lastCrash: camera.device?.lastCrash?.at ? camera.device.lastCrash : null
    };
}

/** GET /api/cameras/:serial/log?since&before&level&q&limit: lines oldest first. */
async function list(camera, query = {}, now = new Date()) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 2000);
    const filter = { deviceSerial: camera.deviceSerial };
    const range = {};
    if (query.since && !isNaN(new Date(query.since))) range.$gt = new Date(query.since);
    if (query.before && !isNaN(new Date(query.before))) range.$lt = new Date(query.before);
    if (Object.keys(range).length) filter.at = range;
    if (LEVELS.includes(query.level)) filter.lvl = { $lte: levelOf(query.level) };
    if (typeof query.q === 'string' && query.q.trim()) {
        const pattern = new RegExp(query.q.trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ msg: pattern }, { tag: pattern }];
    }
    // The newest `limit` lines (or the next ones after `since`), returned oldest first
    const rows = range.$gt && !range.$lt
        ? await CameraLog.find(filter).sort({ at: 1, seq: 1 }).limit(limit).lean()
        : (await CameraLog.find(filter).sort({ at: -1, seq: -1 }).limit(limit).lean()).reverse();
    return { success: true, state: stateOf(camera, now), lines: rows.map(lineView) };
}

/** The last 24 h as text (download). */
async function text(camera) {
    const rows = await CameraLog.find({ deviceSerial: camera.deviceSerial }).sort({ at: 1, seq: 1 }).limit(MAX_LINES_PER_CAMERA).lean();
    const letter = ['', 'E', 'W', 'I', 'D', 'V'];
    return rows.map(r => `${new Date(r.at).toISOString()} ${letter[r.lvl] || 'I'} ${r.tag ? `${r.tag}: ` : ''}${r.msg}`).join('\n') + '\n';
}

function crashView(c) {
    return {
        id: String(c._id),
        at: c.at,
        reason: c.reason,
        detail: c.detail || '',
        fw: c.fw,
        logTail: c.logTail || '',
        coredump: c.coredump?.pc || c.coredump?.backtrace?.length ? c.coredump : null,
        source: c.source
    };
}

async function crashes(camera) {
    const rows = await CameraCrash.find({ deviceSerial: camera.deviceSerial }).sort({ at: -1 }).limit(20).lean();
    return { success: true, crashes: rows.map(crashView) };
}

module.exports = {
    LEVELS,
    MAX_MINUTES,
    parseLine,
    watch,
    unwatch,
    ingestBatch,
    ingestCrash,
    deviceReport,
    start,
    stop,
    stateOf,
    list,
    text,
    crashes
};
