const crypto = require('crypto');
const env = require('../config/env');
const { Camera, Firmware, FirmwareUpdate, User } = require('../models');
const { OPEN_STATES } = require('../models/FirmwareUpdate');
const { compareVersions, stateOf, isDisabled } = require('./fleetService');

/**
 * Firmware of the CamOS cameras: releases per model, updates of chosen cameras, notices to the owners and their
 * automatic updates. Built on what camos-esp32-trap 0.6.x already does (docs/dev/PROTOCOL_ADDITIONS.md):
 *  1. FlyBot sends the RPC `ota.apply` (no params) while the camera is awake;
 *  2. the camera asks GET /api/device/ota, which offers the build of *its* open update: { fw, url, sha256 }, the url
 *     a signed link to /api/device/firmware/<id> (FlyBot serves the image from S3, so a GitHub redirect never
 *     reaches the camera);
 *  3. rpc/res: ok (installing), OLD_VERSION (already on it), NOT_FOUND; firmware 0.7.0+: LOW_BATTERY;
 *  4. event ota_result { ok, stage, error, detail } (0.7.0+: ota_progress { pct } before it);
 *  5. event boot { reason, fw }: the new version confirms the update, the old one after an install is a rollback
 *     (the bootloader went back because the new image never reached MQTT).
 * A camera on battery sleeps between photos: pending updates are sent when it wakes (state / boot / telemetry /
 * photo upload) and has enough charge; the 5-minute job settles the rest.
 */
const MODEL = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+.][A-Za-z0-9.]{1,24})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIN_IMAGE_BYTES = 64 * 1024;
// The OTA slot of each board (camos-esp32-trap partitions*.csv): 3 MB, 1.69 MB on the 4 MB ESP32-CAM
const SLOT_BYTES = { 'AIC-ESP32CAM': 0x1B0000 };
const DEFAULT_SLOT_BYTES = 0x300000;
// GitHub release boards -> the model the camera reports
const BOARD_MODELS = { freenove: 'AIC-FREENOVE-S3CAM', esp32cam: 'AIC-ESP32CAM', esp32s3cam: 'AIC-ESP32S3CAM' };
const DEFAULT_REPO = 'agrhub/camos-esp32-trap';
const MAX_ATTEMPTS = 5;
// A sent ota.apply that got no answer (restart, lost message) goes back to pending after this
const SENT_STALE_MS = 3 * 60 * 1000;
// Installing / rebooting without a boot report for this long: failed
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const LINK_TTL_S = 60 * 60;
// A camera on battery below this voltage waits (when it reports no percentage)
const MIN_BATTERY_MV = 3700;
const AUTO_WINDOW_HOURS = 3;
const DEFAULT_AUTO_HOUR = 12;
const MAX_PAGE_SIZE = 100;

const fail = (status, code, message, extra = {}) => ({ status, body: { success: false, code, message, ...extra } });
const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const slotOf = (model) => SLOT_BYTES[model] || DEFAULT_SLOT_BYTES;
const idOf = (v) => String(v?._id ?? v ?? '');

// ---------- Downloads (overridable in tests) ----------

let fetcher = async (url, { maxBytes = env.FIRMWARE_MAX_BYTES, responseType = 'arraybuffer' } = {}) => {
    const axios = require('axios');
    const res = await axios.get(url, { responseType, maxContentLength: maxBytes, maxRedirects: 5, timeout: 120000, validateStatus: s => s === 200 });
    return responseType === 'arraybuffer' ? Buffer.from(res.data) : res.data;
};
function setFetcher(fn) {
    fetcher = fn;
}

// ---------- Releases ----------

function releaseView(fw, counts = {}) {
    return {
        id: idOf(fw),
        model: fw.model,
        version: fw.version,
        fileName: fw.fileName,
        size: fw.size,
        sha256: fw.sha256,
        source: fw.source || { kind: 'upload' },
        notes: { en: fw.notes?.en || '', vi: fw.notes?.vi || '' },
        current: !!fw.current,
        minBatteryPct: fw.minBatteryPct ?? 40,
        createdAt: fw.createdAt,
        cameras: counts[`${fw.model}|${fw.version}`] || 0
    };
}

/** GET /api/admin/firmware: every release, newest version first per model, with how many cameras run it. */
async function listReleases() {
    const releases = await Firmware.find({}).lean();
    releases.sort((a, b) => a.model.localeCompare(b.model) || compareVersions(b.version, a.version));
    const rows = await Camera.aggregate([
        { $match: { platform: 'camos', simulated: { $ne: true } } },
        { $group: { _id: { model: '$model', fw: '$device.fw' }, n: { $sum: 1 } } }
    ]);
    const counts = Object.fromEntries(rows.map(r => [`${r._id.model}|${r._id.fw}`, r.n]));
    const models = await Camera.distinct('model', { platform: 'camos', simulated: { $ne: true } });
    return {
        success: true,
        boards: BOARD_MODELS,
        models: [...new Set([...models.filter(Boolean), ...releases.map(r => r.model), ...Object.values(BOARD_MODELS)])].sort(),
        releases: releases.map(r => releaseView(r, counts))
    };
}

/** Is this an ESP-IDF application image that fits the model's OTA slot? Returns null or an error code. */
function checkImage(buffer, model) {
    if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) return 'too_small';
    if (buffer.length > Math.min(slotOf(model), env.FIRMWARE_MAX_BYTES)) return 'too_large';
    // ESP image header magic (esp_image_header_t.magic)
    if (buffer[0] !== 0xE9) return 'not_esp_image';
    return null;
}

const IMAGE_ERRORS = {
    too_small: 'The file is too small to be a firmware image.',
    too_large: "The file is larger than this model's firmware slot.",
    not_esp_image: 'The file is not an ESP32 application image (use the -update.bin file).',
    sha_mismatch: 'The file does not match the SHA-256 given.'
};

/**
 * Store one build: checks, SHA-256, upload to S3, the release row. `expectedSha256` (from SHA256SUMS or the admin)
 * must match when given. Returns { status, body }.
 */
async function addRelease({ buffer, fileName, model, version, notes, minBatteryPct, expectedSha256, source }, actorId) {
    model = String(model || '').trim();
    version = String(version || '').trim().replace(/^v/i, '');
    if (!MODEL.test(model)) return fail(400, 'BAD_REQUEST', 'model is not valid.');
    if (!VERSION.test(version)) return fail(400, 'BAD_REQUEST', 'version must look like 0.7.0.');
    const problem = checkImage(buffer, model);
    if (problem) return fail(400, problem.toUpperCase(), IMAGE_ERRORS[problem]);
    const sha256 = sha256Of(buffer);
    if (expectedSha256 && String(expectedSha256).trim().toLowerCase() !== sha256) return fail(400, 'SHA_MISMATCH', IMAGE_ERRORS.sha_mismatch);
    if (await Firmware.exists({ model, version })) return fail(409, 'EXISTS', 'This model already has this version.');
    const safeName = String(fileName || `${model}-${version}.bin`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const s3Key = `firmware/${model}/${version}/${safeName}`;
    await require('./s3Service').uploadSnapshot(s3Key, buffer, 'application/octet-stream');
    const pct = Number.isInteger(minBatteryPct) && minBatteryPct >= 0 && minBatteryPct <= 100 ? minBatteryPct : 40;
    try {
        const doc = await Firmware.create({
            model, version, s3Key, fileName: safeName, size: buffer.length, sha256,
            source: source || { kind: 'upload' },
            notes: { en: String(notes?.en || '').slice(0, 4000), vi: String(notes?.vi || '').slice(0, 4000) },
            minBatteryPct: pct,
            createdBy: actorId
        });
        return { status: 201, body: { success: true, release: releaseView(doc.toObject()) } };
    } catch (err) {
        if (err?.code === 11000) return fail(409, 'EXISTS', 'This model already has this version.');
        throw err;
    }
}

/** POST /api/admin/firmware { url, model, version, sha256?, notes? }: FlyBot downloads the image itself. */
async function addFromUrl(body, actorId) {
    const b = body && typeof body === 'object' ? body : {};
    let url;
    try {
        url = new URL(String(b.url || ''));
    } catch {
        return fail(400, 'BAD_REQUEST', 'url must be an http(s) address.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) return fail(400, 'BAD_REQUEST', 'url must be an http(s) address.');
    if (b.sha256 !== undefined && b.sha256 !== '' && !SHA256.test(String(b.sha256).toLowerCase())) return fail(400, 'BAD_REQUEST', 'sha256 must be 64 hex digits.');
    let buffer;
    try {
        buffer = await fetcher(url.href, { maxBytes: Math.min(slotOf(b.model), env.FIRMWARE_MAX_BYTES) });
    } catch (err) {
        return fail(502, 'DOWNLOAD_FAILED', 'The firmware could not be downloaded.', { detail: String(err.message || '').slice(0, 200) });
    }
    return addRelease({
        buffer, fileName: url.pathname.split('/').pop(), model: b.model, version: b.version, notes: b.notes,
        minBatteryPct: b.minBatteryPct, expectedSha256: b.sha256 || undefined, source: { kind: 'url', url: url.href }
    }, actorId);
}

/**
 * POST /api/admin/firmware { githubTag, repo? }: the update images of a camos-esp32-trap GitHub release, one release
 * per board, each checked against the release's SHA256SUMS. Release notes come from the GitHub release text.
 */
async function importGithubRelease(body, actorId) {
    const b = body && typeof body === 'object' ? body : {};
    const tag = String(b.githubTag || '').trim();
    const repo = String(b.repo || DEFAULT_REPO).trim();
    if (!/^v?\d+\.\d+\.\d+[A-Za-z0-9.+-]{0,24}$/.test(tag)) return fail(400, 'BAD_REQUEST', 'githubTag must look like v0.7.0.');
    if (!/^[A-Za-z0-9_.-]{1,40}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return fail(400, 'BAD_REQUEST', 'repo must be owner/name.');
    const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
    let sums;
    try {
        sums = (await fetcher(`${base}/SHA256SUMS`, { maxBytes: 64 * 1024 })).toString('utf8');
    } catch (err) {
        return fail(502, 'DOWNLOAD_FAILED', 'The release or its SHA256SUMS could not be read.', { detail: String(err.message || '').slice(0, 200) });
    }
    const files = [];
    for (const line of sums.split(/\r?\n/)) {
        const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(\S+)$/i);
        const name = m?.[2]?.match(/^camos-esp32-trap-([a-z0-9]+)-v(.+)-update\.bin$/);
        if (m && name && BOARD_MODELS[name[1]]) files.push({ sha256: m[1].toLowerCase(), fileName: m[2], board: name[1], version: name[2] });
    }
    if (!files.length) return fail(422, 'NO_IMAGES', 'The release has no update images listed in SHA256SUMS.');
    let notes = '';
    try {
        const info = JSON.parse((await fetcher(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { maxBytes: 256 * 1024 })).toString('utf8'));
        notes = String(info?.body || '').slice(0, 4000);
    } catch {
        // Notes are optional
    }
    const results = [];
    for (const f of files) {
        const model = BOARD_MODELS[f.board];
        if (await Firmware.exists({ model, version: f.version })) {
            results.push({ board: f.board, model, version: f.version, status: 'exists' });
            continue;
        }
        let buffer;
        try {
            buffer = await fetcher(`${base}/${f.fileName}`, { maxBytes: Math.min(slotOf(model), env.FIRMWARE_MAX_BYTES) });
        } catch (err) {
            results.push({ board: f.board, model, version: f.version, status: 'failed', error: 'DOWNLOAD_FAILED' });
            continue;
        }
        const added = await addRelease({
            buffer, fileName: f.fileName, model, version: f.version, notes: { en: notes, vi: '' }, minBatteryPct: b.minBatteryPct,
            expectedSha256: f.sha256, source: { kind: 'github', url: `${base}/${f.fileName}`, tag }
        }, actorId);
        results.push({ board: f.board, model, version: f.version, status: added.status === 201 ? 'added' : 'failed', error: added.status === 201 ? undefined : added.body.code, id: added.body.release?.id });
    }
    const addedCount = results.filter(r => r.status === 'added').length;
    return { status: addedCount ? 201 : 200, body: { success: true, tag, repo, results } };
}

/**
 * PUT /api/admin/firmware/:id { current?, notes?, minBatteryPct? }. Making a build current takes the mark off the
 * model's other builds and tells the owners of older cameras (or schedules their automatic update).
 */
async function updateRelease(id, body) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) return fail(404, 'NOT_FOUND', 'Firmware not found.');
    const fw = await Firmware.findById(id).lean();
    if (!fw) return fail(404, 'NOT_FOUND', 'Firmware not found.');
    const b = body && typeof body === 'object' ? body : {};
    const set = {};
    if (b.current !== undefined) {
        if (typeof b.current !== 'boolean') return fail(400, 'BAD_REQUEST', 'current must be true or false.');
        set.current = b.current;
    }
    if (b.notes !== undefined) {
        if (!b.notes || typeof b.notes !== 'object') return fail(400, 'BAD_REQUEST', 'notes must be { en, vi }.');
        set['notes.en'] = String(b.notes.en ?? fw.notes?.en ?? '').slice(0, 4000);
        set['notes.vi'] = String(b.notes.vi ?? fw.notes?.vi ?? '').slice(0, 4000);
    }
    if (b.minBatteryPct !== undefined) {
        if (!Number.isInteger(b.minBatteryPct) || b.minBatteryPct < 0 || b.minBatteryPct > 100) return fail(400, 'BAD_REQUEST', 'minBatteryPct must be 0 to 100.');
        set.minBatteryPct = b.minBatteryPct;
    }
    if (set.current === true) await Firmware.updateMany({ model: fw.model, _id: { $ne: fw._id } }, { $set: { current: false } });
    await Firmware.updateOne({ _id: fw._id }, { $set: set });
    const fresh = await Firmware.findById(fw._id).lean();
    let announced = null;
    if (set.current === true && !fw.current) announced = await announce(fresh);
    return { status: 200, body: { success: true, release: releaseView(fresh), announced } };
}

/** DELETE /api/admin/firmware/:id: not the current build, and no camera on its way to it. */
async function deleteRelease(id) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) return fail(404, 'NOT_FOUND', 'Firmware not found.');
    const fw = await Firmware.findById(id).lean();
    if (!fw) return fail(404, 'NOT_FOUND', 'Firmware not found.');
    if (fw.current) return fail(409, 'CURRENT', 'Make another build current before deleting this one.');
    if (await FirmwareUpdate.exists({ firmwareId: fw._id, state: { $in: OPEN_STATES } })) return fail(409, 'IN_USE', 'Cameras are still updating to this build.');
    await require('./s3Service').deleteS3Object(fw.s3Key).catch(err => console.warn(`⚠️ Firmware file ${fw.s3Key} not deleted: ${err.message}`));
    await Firmware.deleteOne({ _id: fw._id });
    return { status: 200, body: { success: true } };
}

const currentFor = (model) => (model ? Firmware.findOne({ model, current: true }).lean() : null);

// ---------- Updates ----------

function updateView(u, names = new Map()) {
    return {
        id: idOf(u),
        deviceSerial: u.deviceSerial,
        deviceName: names.get(u.deviceSerial) || null,
        model: u.model,
        fromVersion: u.fromVersion || '',
        toVersion: u.toVersion,
        batchId: u.batchId || null,
        source: u.source,
        state: u.state,
        waitReason: u.waitReason || null,
        progress: u.progress ?? null,
        attempts: u.attempts || 0,
        error: u.error || null,
        detail: u.detail || null,
        sentAt: u.sentAt || null,
        finishedAt: u.finishedAt || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt
    };
}

/**
 * Open an update of `camera` to `firmware`. Returns { update } or { skipped: reason } (not_camos, simulated,
 * model_mismatch, up_to_date, busy).
 */
async function createUpdate(camera, firmware, { source, requestedBy, batchId, allowSame = false, now = new Date() }) {
    if ((camera.platform || 'ezviz') !== 'camos') return { skipped: 'not_camos' };
    if (camera.simulated) return { skipped: 'simulated' };
    if (camera.model && camera.model !== firmware.model) return { skipped: 'model_mismatch' };
    const from = camera.device?.fw || '';
    if (!allowSame && from && compareVersions(from, firmware.version) === 0) return { skipped: 'up_to_date' };
    const open = await FirmwareUpdate.findOne({ deviceSerial: camera.deviceSerial, state: { $in: OPEN_STATES } }).lean();
    if (open) return idOf(open.firmwareId) === idOf(firmware) ? { update: open, existing: true } : { skipped: 'busy', update: open };
    try {
        const update = await FirmwareUpdate.create({
            deviceSerial: camera.deviceSerial, firmwareId: firmware._id, model: firmware.model, fromVersion: from, toVersion: firmware.version,
            batchId, source, requestedBy, state: 'pending', createdAt: now, updatedAt: now
        });
        return { update: update.toObject() };
    } catch (err) {
        if (err?.code === 11000) return { skipped: 'busy' };
        throw err;
    }
}

/**
 * POST /api/admin/firmware/:id/rollout { serials?: [], allOfModel?: true, outdatedOnly? = true }: one update per
 * camera, sharing a batch id. Returns the counts and the cameras left out with why.
 */
async function rollout(id, body, actorId, now = new Date()) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) return fail(404, 'NOT_FOUND', 'Firmware not found.');
    const fw = await Firmware.findById(id).lean();
    if (!fw) return fail(404, 'NOT_FOUND', 'Firmware not found.');
    const b = body && typeof body === 'object' ? body : {};
    const outdatedOnly = b.outdatedOnly !== false;
    let cameras;
    if (b.allOfModel === true) {
        cameras = await Camera.find({ platform: 'camos', model: fw.model, simulated: { $ne: true }, unclaimed: { $ne: true } }).lean();
    } else if (Array.isArray(b.serials) && b.serials.length && b.serials.length <= 1000 && b.serials.every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s))) {
        cameras = await Camera.find({ deviceSerial: { $in: [...new Set(b.serials)] } }).lean();
    } else {
        return fail(400, 'BAD_REQUEST', 'Give serials (up to 1000) or allOfModel.');
    }
    const batchId = `b_${now.getTime().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const created = [];
    const skipped = [];
    for (const camera of cameras) {
        const from = camera.device?.fw || '';
        if (outdatedOnly && from && compareVersions(from, fw.version) >= 0) {
            skipped.push({ deviceSerial: camera.deviceSerial, reason: 'up_to_date' });
            continue;
        }
        const result = await createUpdate(camera, fw, { source: 'admin', requestedBy: actorId, batchId, allowSame: !outdatedOnly, now });
        if (result.update && !result.skipped && !result.existing) created.push(result.update);
        else skipped.push({ deviceSerial: camera.deviceSerial, reason: result.skipped || 'already_queued' });
    }
    // Requested serials that are not cameras at all
    if (Array.isArray(b.serials)) {
        const found = new Set(cameras.map(c => c.deviceSerial));
        for (const s of new Set(b.serials)) if (!found.has(s)) skipped.push({ deviceSerial: s, reason: 'not_found' });
    }
    for (const u of created) dispatch(u.deviceSerial).catch(err => console.warn(`⚠️ OTA dispatch ${u.deviceSerial}: ${err.message}`));
    return { status: 200, body: { success: true, batchId: created.length ? batchId : null, created: created.length, skipped } };
}

/** GET /api/admin/firmware/updates?batchId&state&serial&page&limit, and the batches with their counts. */
async function listUpdates(query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), MAX_PAGE_SIZE);
    const filter = {};
    if (typeof query.batchId === 'string' && /^b_[a-z0-9_]{1,40}$/.test(query.batchId)) filter.batchId = query.batchId;
    if (typeof query.state === 'string') {
        if (query.state === 'open') filter.state = { $in: OPEN_STATES };
        else if (require('../models/FirmwareUpdate').UPDATE_STATES.includes(query.state)) filter.state = query.state;
    }
    if (typeof query.serial === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(query.serial)) filter.deviceSerial = query.serial;
    const [total, rows, batches] = await Promise.all([
        FirmwareUpdate.countDocuments(filter),
        FirmwareUpdate.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        FirmwareUpdate.aggregate([
            { $match: { batchId: { $exists: true, $ne: null } } },
            { $group: { _id: '$batchId', model: { $first: '$model' }, toVersion: { $first: '$toVersion' }, createdAt: { $min: '$createdAt' }, total: { $sum: 1 },
                succeeded: { $sum: { $cond: [{ $eq: ['$state', 'succeeded'] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $in: ['$state', ['failed', 'rolled_back']] }, 1, 0] } },
                cancelled: { $sum: { $cond: [{ $eq: ['$state', 'cancelled'] }, 1, 0] } } } },
            { $sort: { createdAt: -1 } },
            { $limit: 20 }
        ])
    ]);
    const names = new Map((await Camera.find({ deviceSerial: { $in: rows.map(r => r.deviceSerial) } }).select('deviceSerial deviceName').lean()).map(c => [c.deviceSerial, c.deviceName]));
    return {
        success: true,
        total,
        page,
        limit,
        updates: rows.map(r => updateView(r, names)),
        batches: batches.map(b => ({ batchId: b._id, model: b.model, toVersion: b.toVersion, createdAt: b.createdAt, total: b.total, succeeded: b.succeeded, failed: b.failed, cancelled: b.cancelled, open: b.total - b.succeeded - b.failed - b.cancelled }))
    };
}

/** POST /api/admin/firmware/updates/:id/cancel: only before the camera started installing. */
async function cancelUpdate(id, now = new Date()) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) return fail(404, 'NOT_FOUND', 'Update not found.');
    const done = await FirmwareUpdate.findOneAndUpdate({ _id: id, state: { $in: ['pending', 'sent'] } }, { $set: { state: 'cancelled', finishedAt: now, updatedAt: now, waitReason: null } }, { new: true }).lean();
    if (!done) return fail(409, 'NOT_CANCELLABLE', 'Only an update that has not started installing can be cancelled.');
    return { status: 200, body: { success: true, update: updateView(done) } };
}

/** POST /api/admin/firmware/updates/:id/retry: a new update to the same build after a failure or a cancel. */
async function retryUpdate(id, actorId) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) return fail(404, 'NOT_FOUND', 'Update not found.');
    const old = await FirmwareUpdate.findById(id).lean();
    if (!old) return fail(404, 'NOT_FOUND', 'Update not found.');
    if (!['failed', 'rolled_back', 'cancelled'].includes(old.state)) return fail(409, 'NOT_RETRYABLE', 'Only a failed or cancelled update can be tried again.');
    const [camera, fw] = await Promise.all([Camera.findOne({ deviceSerial: old.deviceSerial }).lean(), Firmware.findById(old.firmwareId).lean()]);
    if (!camera || !fw) return fail(404, 'NOT_FOUND', 'Update not found.');
    const result = await createUpdate(camera, fw, { source: 'admin', requestedBy: actorId, batchId: old.batchId, allowSame: true });
    if (!result.update || result.skipped) return fail(409, 'BUSY', 'This camera already has an update in progress.');
    dispatch(camera.deviceSerial).catch(() => {});
    return { status: 200, body: { success: true, update: updateView(result.update) } };
}

// ---------- Dispatch ----------

const localHour = (camera, now) => {
    const zone = camera.device?.tz?.iana || require('./captureSchedule').TIMEZONE;
    try {
        return Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hour12: false }).format(now)) % 24;
    } catch {
        return now.getUTCHours();
    }
};

/** Why this update must wait now, or null. */
function waitReasonOf(camera, update, firmware, now = new Date()) {
    const state = stateOf(camera, now);
    if (state !== 'online') return state === 'sleeping' ? 'sleeping' : 'offline';
    const d = camera.device || {};
    const powered = d.power?.mode === 'powered';
    const b = d.battery;
    if (!powered && b && typeof b === 'object' && b.charging !== true) {
        const min = firmware?.minBatteryPct ?? 40;
        const low = Number.isFinite(b.pct) ? b.pct < min : (Number.isFinite(b.mv) ? b.mv < MIN_BATTERY_MV : false);
        if (low) return 'battery_low';
    }
    if (update.source === 'auto') {
        const start = Number.isInteger(camera.firmware?.autoHour) ? camera.firmware.autoHour : DEFAULT_AUTO_HOUR;
        const hour = localHour(camera, now);
        if ((hour - start + 24) % 24 >= AUTO_WINDOW_HOURS) return 'outside_hour';
    }
    return null;
}

const inFlight = new Set();

/**
 * Send this camera's pending update when it can take it now (awake, charged, in its hour). Called when the camera
 * shows up and by the 5-minute job. Returns the update's new state, or null when nothing was due.
 */
async function dispatch(deviceSerial, { now = new Date() } = {}) {
    if (inFlight.has(deviceSerial)) return null;
    const pending = await FirmwareUpdate.findOne({ deviceSerial, state: 'pending' }).lean();
    if (!pending) return null;
    inFlight.add(deviceSerial);
    try {
        const [camera, firmware] = await Promise.all([Camera.findOne({ deviceSerial }).lean(), Firmware.findById(pending.firmwareId).lean()]);
        if (!camera || !firmware) {
            await finish(pending, 'failed', { error: 'GONE', detail: 'The camera or the firmware no longer exists.' }, now);
            return 'failed';
        }
        const reason = waitReasonOf(camera, pending, firmware, now);
        if (reason) {
            if (pending.waitReason !== reason) await FirmwareUpdate.updateOne({ _id: pending._id, state: 'pending' }, { $set: { waitReason: reason, updatedAt: now } });
            return 'pending';
        }
        // Taken by this process (another instance or a parallel wake may race for it)
        const sent = await FirmwareUpdate.findOneAndUpdate({ _id: pending._id, state: 'pending' },
            { $set: { state: 'sent', sentAt: now, waitReason: null, updatedAt: now }, $inc: { attempts: 1 } }, { new: true }).lean();
        if (!sent) return null;
        let answer;
        try {
            answer = await require('../platforms/camos').rpc(deviceSerial, 'ota.apply', {}, { wait: true, timeoutS: 60 });
        } catch (err) {
            const timedOut = err.code === 'TIMEOUT';
            if (sent.attempts >= MAX_ATTEMPTS) return finish(sent, 'failed', { error: timedOut ? 'NO_ANSWER' : 'SEND_FAILED', detail: String(err.message || '').slice(0, 200) }).then(() => 'failed');
            await FirmwareUpdate.updateOne({ _id: sent._id, state: 'sent' }, { $set: { state: 'pending', waitReason: 'offline', updatedAt: new Date() } });
            return 'pending';
        }
        // The camera may have reported the result already (ota_result before rpc/res is read)
        const latest = await FirmwareUpdate.findById(sent._id).lean();
        if (latest?.state !== 'sent') return latest?.state || null;
        if (answer?.ok) {
            await FirmwareUpdate.updateOne({ _id: sent._id, state: 'sent' }, { $set: { state: 'installing', progress: 0, updatedAt: new Date() } });
            return 'installing';
        }
        const code = String(answer?.error?.code || 'ERROR');
        const message = String(answer?.error?.message || '').slice(0, 200);
        if (code === 'OLD_VERSION') {
            await finish(sent, 'succeeded', { detail: 'The camera already runs this version.' });
            return 'succeeded';
        }
        if (code === 'LOW_BATTERY' || code === 'BUSY') {
            await FirmwareUpdate.updateOne({ _id: sent._id, state: 'sent' }, { $set: { state: 'pending', waitReason: code === 'LOW_BATTERY' ? 'battery_low' : 'offline', updatedAt: new Date() } });
            return 'pending';
        }
        await finish(sent, 'failed', { error: code, detail: message });
        return 'failed';
    } finally {
        inFlight.delete(deviceSerial);
    }
}

/** Close an update and tell the owner how it ended. */
async function finish(update, state, { error, detail } = {}, now = new Date()) {
    const done = await FirmwareUpdate.findOneAndUpdate({ _id: update._id, state: { $in: OPEN_STATES } },
        { $set: { state, finishedAt: now, updatedAt: now, waitReason: null, ...(error ? { error } : {}), ...(detail ? { detail } : {}), ...(state === 'succeeded' ? { progress: 100 } : {}) } },
        { new: true }).lean();
    if (!done) return null;
    console.log(`📦 Firmware update ${done.deviceSerial} ${done.fromVersion || '?'} -> ${done.toVersion}: ${state}${error ? ` (${error})` : ''}`);
    if (['succeeded', 'failed', 'rolled_back'].includes(state) && !(state === 'succeeded' && detail === 'The camera already runs this version.')) {
        const type = state === 'succeeded' ? 'firmware_updated' : 'firmware_failed';
        notifyOwner(done.deviceSerial, type, (cam) => ({ camera: cam.deviceName || cam.deviceSerial, version: done.toVersion, from: done.fromVersion || '', error: error || state }))
            .catch(err => console.warn(`⚠️ Firmware notice ${done.deviceSerial}: ${err.message}`));
    }
    return done;
}

/** The camera's owner only (people it is shared with cannot update it); a muted camera stays quiet. */
async function notifyOwner(deviceSerial, type, buildParams) {
    const camera = await Camera.findOne({ deviceSerial }).select('deviceSerial deviceName userId').lean();
    if (!camera?.userId) return null;
    const owner = await User.findById(camera.userId).select('notificationPrefs.mutedCameras').lean();
    if ((owner?.notificationPrefs?.mutedCameras || []).includes(deviceSerial)) return null;
    return require('./notificationService').notifyUser({ userId: camera.userId, type, deviceSerial, params: buildParams(camera) });
}

/** Whatever the camera said that shows it is awake: try its pending update (in the background). */
function cameraAwake(deviceSerial) {
    if (!deviceSerial) return;
    FirmwareUpdate.exists({ deviceSerial, state: 'pending' })
        .then(found => (found ? dispatch(deviceSerial) : null))
        .catch(err => console.warn(`⚠️ OTA dispatch ${deviceSerial}: ${err.message}`));
}

/**
 * An event from the camera (platforms/camos.js handleMessage): ota_progress, ota_result, boot. Returns what changed
 * or null.
 */
async function handleEvent(deviceSerial, doc, now = new Date()) {
    const type = String(doc?.type || '');
    if (!['ota_progress', 'ota_result', 'boot'].includes(type)) return null;
    const open = await FirmwareUpdate.findOne({ deviceSerial, state: { $in: OPEN_STATES } }).lean();
    if (type === 'boot') {
        const fw = typeof doc.fw === 'string' ? doc.fw : '';
        if (open && fw) {
            const result = await settleByVersion(open, fw, now);
            if (result) return result;
        }
        cameraAwake(deviceSerial);
        return null;
    }
    if (!open || open.state === 'pending') return null;
    if (doc.target && doc.target !== 'firmware') return null;
    if (type === 'ota_progress') {
        const pct = Number(doc.pct);
        if (!Number.isFinite(pct)) return null;
        await FirmwareUpdate.updateOne({ _id: open._id, state: { $in: ['sent', 'installing'] } }, { $set: { state: 'installing', progress: Math.max(0, Math.min(100, Math.round(pct))), updatedAt: now } });
        return { state: 'installing', progress: pct };
    }
    // ota_result
    if (doc.ok === true || doc.stage === 'installed') {
        await FirmwareUpdate.updateOne({ _id: open._id, state: { $in: ['sent', 'installing'] } }, { $set: { state: 'rebooting', progress: 100, installedAt: now, updatedAt: now } });
        return { state: 'rebooting' };
    }
    await finish(open, 'failed', { error: String(doc.error || 'DOWNLOAD_FAILED').slice(0, 40), detail: String(doc.detail || '').slice(0, 200) }, now);
    return { state: 'failed' };
}

/** The camera reports `fw`: the new version ends its update, the old one after an install is a rollback. */
async function settleByVersion(open, fw, now = new Date()) {
    if (compareVersions(fw, open.toVersion) === 0) {
        await finish(open, 'succeeded', {}, now);
        return { state: 'succeeded' };
    }
    if (['installing', 'rebooting'].includes(open.state) && open.fromVersion && compareVersions(fw, open.fromVersion) === 0 && open.installedAt) {
        await finish(open, 'rolled_back', { error: 'ROLLED_BACK', detail: `The camera came back on ${fw}.` }, now);
        return { state: 'rolled_back' };
    }
    return null;
}

/** A state / reported document carried `fw` (the boot event may have been missed). */
async function versionReported(deviceSerial, fw, now = new Date()) {
    if (!fw) return null;
    const open = await FirmwareUpdate.findOne({ deviceSerial, state: { $in: ['installing', 'rebooting'] } }).lean();
    if (!open || compareVersions(fw, open.toVersion) !== 0) return null;
    return settleByVersion(open, fw, now);
}

// ---------- Device API ----------

function signLink(firmwareId, deviceSerial, exp) {
    return crypto.createHmac('sha256', env.JWT_SECRET || 'flybot').update(`fw:${firmwareId}:${deviceSerial}:${exp}`).digest('base64url').slice(0, 32);
}

function downloadUrl(firmwareId, deviceSerial, now = new Date()) {
    const exp = Math.floor(now.getTime() / 1000) + LINK_TTL_S;
    const q = `sn=${encodeURIComponent(deviceSerial)}&exp=${exp}&sig=${signLink(String(firmwareId), deviceSerial, exp)}`;
    return `${env.DEVICE_API_BASE_URL}/api/device/firmware/${firmwareId}?${q}`;
}

/**
 * GET /api/device/ota for an authenticated camera: the build of its open update, or the env offer
 * (DEVICE_OTA_*), or null (204). Never an error: the firmware takes a 401 here as "unknown device".
 */
async function offerFor(camera, now = new Date()) {
    const open = await FirmwareUpdate.findOne({ deviceSerial: camera.deviceSerial, state: { $in: OPEN_STATES } }).lean();
    if (open) {
        const fw = await Firmware.findById(open.firmwareId).select('version sha256').lean();
        if (fw) return { fw: fw.version, url: downloadUrl(fw._id, camera.deviceSerial, now), sha256: fw.sha256 };
    }
    return require('./deviceService').otaManifest(camera);
}

/**
 * GET /api/device/firmware/:id?sn&exp&sig: the image, for a link FlyBot signed for that camera (or a camera that
 * sends its own token), only while the camera has an open update to this build. Returns { status, firmware }.
 */
async function authorizeDownload(id, { sn, exp, sig } = {}, deviceCamera = null, now = new Date()) {
    if (!/^[a-f0-9]{24}$/i.test(String(id))) return { status: 404 };
    let serial = deviceCamera?.deviceSerial || null;
    if (!serial) {
        const e = Number(exp);
        if (typeof sn !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sn) || !Number.isInteger(e) || typeof sig !== 'string') return { status: 401 };
        if (e * 1000 < now.getTime()) return { status: 401 };
        const expected = Buffer.from(signLink(String(id), sn, e));
        const given = Buffer.from(sig);
        if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { status: 401 };
        serial = sn;
    }
    const open = await FirmwareUpdate.exists({ deviceSerial: serial, firmwareId: id, state: { $in: OPEN_STATES } });
    if (!open) return { status: 404 };
    const firmware = await Firmware.findById(id).lean();
    if (!firmware) return { status: 404 };
    await FirmwareUpdate.updateOne({ deviceSerial: serial, firmwareId: id, state: 'sent' }, { $set: { state: 'installing', progress: 0, updatedAt: now } });
    return { status: 200, firmware };
}

// ---------- Owners ----------

/** Status for the camera's owner (GET /api/cameras/:serial/firmware). */
async function statusFor(camera, { canManage = false, language = 'en' } = {}) {
    const platform = camera.platform || 'ezviz';
    const current = platform === 'camos' ? camera.device?.fw || null : camera.deviceVersion || null;
    if (platform !== 'camos') {
        // EZVIZ firmware is updated through the EZVIZ app; FlyBot shows the version only
        return { success: true, platform, model: camera.model || null, current, latest: null, updateAvailable: false, managedBy: 'ezviz', canUpdate: false, autoUpdate: false };
    }
    const rel = await currentFor(camera.model);
    const last = await FirmwareUpdate.findOne({ deviceSerial: camera.deviceSerial }).sort({ createdAt: -1 }).lean();
    const updateAvailable = !!(rel && current && compareVersions(current, rel.version) < 0);
    const open = last && OPEN_STATES.includes(last.state);
    return {
        success: true,
        platform,
        model: camera.model || null,
        current,
        latest: rel ? { version: rel.version, notes: (language === 'vi' ? rel.notes?.vi : rel.notes?.en) || rel.notes?.en || rel.notes?.vi || '', size: rel.size, publishedAt: rel.createdAt, minBatteryPct: rel.minBatteryPct ?? 40 } : null,
        updateAvailable,
        update: last ? updateView(last) : null,
        canUpdate: canManage && !camera.simulated && updateAvailable && !open,
        autoUpdate: !!camera.firmware?.autoUpdate,
        autoHour: Number.isInteger(camera.firmware?.autoHour) ? camera.firmware.autoHour : DEFAULT_AUTO_HOUR,
        disabled: isDisabled(camera),
        battery: camera.device?.battery || null,
        power: camera.device?.power?.mode || null,
        state: stateOf(camera)
    };
}

/** POST /api/cameras/:serial/firmware/update { confirm: true }: the owner installs the current release. */
async function requestByOwner(camera, userId) {
    if ((camera.platform || 'ezviz') !== 'camos') return fail(400, 'NOT_CAMOS', 'Only CamOS cameras are updated through FlyBot.');
    if (camera.simulated) return fail(409, 'SIMULATED_CAMERA', 'A simulated camera has no firmware.');
    const rel = await currentFor(camera.model);
    if (!rel) return fail(404, 'NO_RELEASE', 'There is no firmware release for this camera yet.');
    const result = await createUpdate(camera, rel, { source: 'owner', requestedBy: userId });
    if (result.skipped === 'up_to_date') return fail(409, 'UP_TO_DATE', 'The camera already runs the latest firmware.');
    if (result.skipped === 'busy' || result.existing) return fail(409, 'BUSY', 'This camera already has an update in progress.');
    if (result.skipped) return fail(409, result.skipped.toUpperCase(), 'This camera cannot take this firmware.');
    const state = await dispatch(camera.deviceSerial).catch(err => {
        console.warn(`⚠️ OTA dispatch ${camera.deviceSerial}: ${err.message}`);
        return 'pending';
    });
    const fresh = await FirmwareUpdate.findById(result.update._id).lean();
    return { status: 200, body: { success: true, state: state || fresh?.state, update: updateView(fresh || result.update) } };
}

/** PUT /api/cameras/:serial/firmware/auto { enabled, hour? } */
async function setAuto(camera, { enabled, hour }, userId) {
    if ((camera.platform || 'ezviz') !== 'camos') return fail(400, 'NOT_CAMOS', 'Only CamOS cameras are updated through FlyBot.');
    if (typeof enabled !== 'boolean') return fail(400, 'BAD_REQUEST', 'enabled must be true or false.');
    if (hour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23)) return fail(400, 'BAD_REQUEST', 'hour must be 0 to 23.');
    await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $set: { 'firmware.autoUpdate': enabled, ...(hour !== undefined ? { 'firmware.autoHour': hour } : {}) } });
    let queued = false;
    if (enabled) {
        const fresh = await Camera.findOne({ deviceSerial: camera.deviceSerial }).lean();
        queued = !!(await scheduleAuto(fresh, userId));
    }
    return { status: 200, body: { success: true, autoUpdate: enabled, autoHour: hour ?? camera.firmware?.autoHour ?? DEFAULT_AUTO_HOUR, queued } };
}

/** An automatic update for a camera that wants them and runs an older build than its model's current one. */
async function scheduleAuto(camera, requestedBy) {
    if (!camera?.firmware?.autoUpdate || camera.simulated || (camera.platform || 'ezviz') !== 'camos' || isDisabled(camera)) return null;
    const rel = await currentFor(camera.model);
    if (!rel || !camera.device?.fw || compareVersions(camera.device.fw, rel.version) >= 0) return null;
    const result = await createUpdate(camera, rel, { source: 'auto', requestedBy });
    if (result.update && !result.skipped && !result.existing) {
        cameraAwake(camera.deviceSerial);
        return result.update;
    }
    return null;
}

/**
 * A build became current: cameras with automatic updates get one; the owners of the other older cameras of that
 * model get one notice per release (in-app, and email / Telegram / push by their alert settings).
 */
async function announce(firmware) {
    const cameras = await Camera.find({ platform: 'camos', model: firmware.model, simulated: { $ne: true }, unclaimed: { $ne: true }, userId: { $ne: null } }).lean();
    let scheduled = 0;
    let notified = 0;
    for (const camera of cameras) {
        const fw = camera.device?.fw;
        if (!fw || compareVersions(fw, firmware.version) >= 0) continue;
        if (camera.firmware?.autoUpdate && !isDisabled(camera)) {
            if (await scheduleAuto(camera)) scheduled++;
            continue;
        }
        if (await noticeAvailable(camera, firmware)) notified++;
    }
    return { scheduled, notified };
}

async function noticeAvailable(camera, firmware) {
    if (camera.firmware?.notifiedVersion && compareVersions(camera.firmware.notifiedVersion, firmware.version) >= 0) return false;
    await Camera.updateMany({ deviceSerial: camera.deviceSerial }, { $set: { 'firmware.notifiedVersion': firmware.version } });
    await notifyOwner(camera.deviceSerial, 'firmware_available', (cam) => ({ camera: cam.deviceName || cam.deviceSerial, version: firmware.version, current: camera.device?.fw || '' }))
        .catch(err => console.warn(`⚠️ Firmware notice ${camera.deviceSerial}: ${err.message}`));
    return true;
}

// ---------- The 5-minute job ----------

/**
 * Settle what no message settled: sent without an answer (back to pending), installing / rebooting for too long
 * (failed, unless the camera reports the new version), pending updates of cameras that are awake now, automatic
 * updates for cameras that turned them on or joined after the release. Returns counts for the pipeline monitor.
 */
async function sweep({ now = new Date() } = {}) {
    const stale = await FirmwareUpdate.updateMany(
        { state: 'sent', sentAt: { $lt: new Date(now.getTime() - SENT_STALE_MS) } },
        { $set: { state: 'pending', waitReason: 'offline', updatedAt: now } }
    );
    let timedOut = 0;
    const installing = await FirmwareUpdate.find({ state: { $in: ['installing', 'rebooting'] }, updatedAt: { $lt: new Date(now.getTime() - INSTALL_TIMEOUT_MS) } }).limit(200).lean();
    for (const u of installing) {
        const camera = await Camera.findOne({ deviceSerial: u.deviceSerial }).select('device.fw').lean();
        if (camera?.device?.fw && compareVersions(camera.device.fw, u.toVersion) === 0) await finish(u, 'succeeded', {}, now);
        else if (await finish(u, 'failed', { error: 'TIMEOUT', detail: 'No report from the camera after the install.' }, now)) timedOut++;
    }
    let dispatched = 0;
    const pending = await FirmwareUpdate.find({ state: 'pending' }).select('deviceSerial').limit(200).lean();
    for (const u of pending) {
        const state = await dispatch(u.deviceSerial, { now }).catch(() => null);
        if (state && state !== 'pending') dispatched++;
    }
    let auto = 0;
    const releases = await Firmware.find({ current: true }).lean();
    for (const rel of releases) {
        const cameras = await Camera.find({ platform: 'camos', model: rel.model, 'firmware.autoUpdate': true, simulated: { $ne: true } }).limit(500).lean();
        for (const camera of cameras) if (await scheduleAuto(camera)) auto++;
    }
    return { requeued: stale.modifiedCount || 0, timedOut, dispatched, auto };
}

module.exports = {
    BOARD_MODELS,
    DEFAULT_AUTO_HOUR,
    MIN_BATTERY_MV,
    checkImage,
    listReleases,
    addRelease,
    addFromUrl,
    importGithubRelease,
    updateRelease,
    deleteRelease,
    currentFor,
    createUpdate,
    rollout,
    listUpdates,
    cancelUpdate,
    retryUpdate,
    waitReasonOf,
    dispatch,
    cameraAwake,
    handleEvent,
    versionReported,
    downloadUrl,
    offerFor,
    authorizeDownload,
    statusFor,
    requestByOwner,
    setAuto,
    scheduleAuto,
    announce,
    sweep,
    setFetcher
};
