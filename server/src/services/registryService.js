const crypto = require('crypto');
const { DeviceRegistry, Camera, User } = require('../models');

/**
 * The serial registry (cameras made or bought for sale). An admin enters each serial with the verify code
 * printed on its label, one by one, from a CSV, or from the label QR text (CAMOS:1;SN:...;VC:...;M:...;;).
 *
 * Where it is checked (CamOS cameras; EZVIZ cameras are checked by the EZVIZ cloud):
 *  - adding a camera to an account (claim, or "Add camera" before the camera registered itself): a registered
 *    serial needs its registry code and must not be blocked; in "strict" mode an unregistered serial is refused
 *  - self-registration (POST /api/device/register): a registered serial must come with its registry code and
 *    must not be blocked. Unregistered serials still register (hidden, removed after 7 days) in both modes, so
 *    the firmware never changes; strict mode only stops them from joining an account.
 * Mode: system setting registryMode (env REGISTRY_MODE), "open" by default.
 */
const SERIAL = /^[A-Z0-9_-]{3,64}$/;
const ESP_SERIAL = /^ESP[0-9A-F]{12}$/;
// camos-esp32-trap codes: 6 Crockford base32 characters; other CamOS cameras: up to 32 letters and digits
const ESP_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const CODE = /^[A-Z0-9]{4,32}$/;
const MODEL = /^[A-Za-z0-9._-]{0,64}$/;
const MAX_IMPORT_ROWS = 5000;
const MAX_PAGE_SIZE = 100;
const STATUSES = ['available', 'claimed', 'disabled'];

const normSerial = (s) => String(s ?? '').trim().toUpperCase();
const normCode = (s) => String(s ?? '').trim().toUpperCase();
const clip = (s, max) => String(s ?? '').trim().slice(0, max);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fail = (status, code, message) => ({ status, body: { success: false, code, message } });

/** "K7••••": enough to tell two labels apart, not enough to claim the camera. */
function maskCode(code) {
    const c = String(code || '');
    if (!c) return '';
    return c.slice(0, 2) + '•'.repeat(Math.max(c.length - 2, 2));
}

function codesMatch(a, b) {
    const x = Buffer.from(normCode(a));
    const y = Buffer.from(normCode(b));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function mode() {
    return (await require('./settingsService').getSettings()).registryMode === 'strict' ? 'strict' : 'open';
}

function lookup(serial) {
    return DeviceRegistry.findOne({ serial: normSerial(serial) }).lean();
}

/** Problems with one entry's fields, or null. */
function checkEntry({ serial, verifyCode, model, hwVersion, batch, note }) {
    if (!SERIAL.test(serial)) return 'bad_serial';
    if (ESP_SERIAL.test(serial) ? !ESP_CODE.test(verifyCode) : !CODE.test(verifyCode)) return 'bad_code';
    if (!MODEL.test(model || '')) return 'bad_model';
    if (String(hwVersion || '').length > 32 || String(batch || '').length > 64 || String(note || '').length > 300) return 'too_long';
    return null;
}

const ENTRY_ERRORS = {
    bad_serial: 'serial must be 3 to 64 letters, digits, - or _.',
    bad_code: 'verifyCode does not fit this serial (ESP serials: 6 Crockford base32 characters).',
    bad_model: 'model is not valid.',
    too_long: 'hwVersion, batch or note is too long.'
};

function entryOf(body) {
    const b = body && typeof body === 'object' ? body : {};
    return {
        serial: normSerial(b.serial),
        verifyCode: normCode(b.verifyCode),
        model: clip(b.model, 64),
        hwVersion: clip(b.hwVersion, 32),
        batch: clip(b.batch, 64),
        note: clip(b.note, 300)
    };
}

// ---------- Checks used by the claim / add / register flows ----------

/**
 * May this serial + code join an account? Returns null (go on), or a refusal:
 * { status, body: { success: false, code: SERIAL_NOT_REGISTERED | SERIAL_DISABLED | NOT_FOUND } }.
 * NOT_FOUND (with wrongCode: true) when the code is not the registered one.
 */
async function checkClaim(serial, verifyCode) {
    const entry = await lookup(serial);
    if (!entry) {
        if (await mode() === 'strict') return fail(403, 'SERIAL_NOT_REGISTERED', 'This serial is not registered. Check the label or ask the seller.');
        return null;
    }
    if (!codesMatch(entry.verifyCode, verifyCode)) {
        const refusal = fail(404, 'NOT_FOUND', 'No camera waiting to be claimed matches this serial and code.');
        refusal.wrongCode = true;
        return refusal;
    }
    if (entry.disabled) return fail(403, 'SERIAL_DISABLED', 'This camera serial is blocked. Ask the seller.');
    return null;
}

/**
 * Self-registration of a camera (device API, CONTRACTS 2a shape). Returns null or { status, body }:
 * 403 disabled for a blocked serial, 409 serial_taken when the code is not the registered one.
 */
async function checkRegister(serial, verifyCode) {
    const entry = await lookup(serial);
    if (!entry) return null;
    if (entry.disabled) return { status: 403, body: { ok: false, error: 'disabled', message: 'This serial is blocked.' } };
    if (!codesMatch(entry.verifyCode, verifyCode)) return { status: 409, body: { ok: false, error: 'serial_taken', message: 'This serial is already registered.' } };
    return null;
}

/** A camera that lost its factory data made a new verify code: its entry, if any, takes it. */
async function setCode(serial, verifyCode, now = new Date()) {
    await DeviceRegistry.updateOne({ serial: normSerial(serial) }, { $set: { verifyCode: normCode(verifyCode), updatedAt: now } });
}

/** A customer added the camera: remember who and when (first time only). */
async function markClaimed(serial, userId, now = new Date()) {
    await DeviceRegistry.updateOne({ serial: normSerial(serial), claimedAt: { $exists: false } }, { $set: { claimedAt: now, claimedBy: userId, updatedAt: now } }).catch(() => {});
}

// ---------- Admin ----------

function statusOf(entry) {
    if (entry.disabled) return 'disabled';
    return entry.claimedAt ? 'claimed' : 'available';
}

/** GET /api/admin/registry?q&status&batch&page&limit */
async function list(query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
    const filter = {};
    if (typeof query.q === 'string' && query.q.trim()) {
        const pattern = new RegExp(escapeRegex(query.q.trim().slice(0, 64)), 'i');
        filter.$or = [{ serial: pattern }, { batch: pattern }, { model: pattern }, { note: pattern }];
    }
    if (typeof query.batch === 'string' && query.batch.trim()) filter.batch = query.batch.trim().slice(0, 64);
    if (query.status === 'disabled') filter.disabled = true;
    else if (query.status === 'claimed') Object.assign(filter, { disabled: { $ne: true }, claimedAt: { $exists: true } });
    else if (query.status === 'available') Object.assign(filter, { disabled: { $ne: true }, claimedAt: { $exists: false } });

    const [total, rows, counts, batches] = await Promise.all([
        DeviceRegistry.countDocuments(filter),
        DeviceRegistry.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        DeviceRegistry.aggregate([{ $group: { _id: null, total: { $sum: 1 }, disabled: { $sum: { $cond: ['$disabled', 1, 0] } }, claimed: { $sum: { $cond: [{ $and: [{ $ne: ['$disabled', true] }, { $gt: ['$claimedAt', null] }] }, 1, 0] } } } }]),
        DeviceRegistry.distinct('batch')
    ]);
    const serials = rows.map(r => r.serial);
    const cameras = await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName userId unclaimed adminDisabled').populate('userId', 'email').lean();
    const bySerial = new Map(cameras.map(c => [c.deviceSerial, c]));
    const claimers = await User.find({ _id: { $in: rows.map(r => r.claimedBy).filter(Boolean) } }).select('email').lean();
    const emailOf = new Map(claimers.map(u => [String(u._id), u.email]));
    const c = counts[0] || { total: 0, disabled: 0, claimed: 0 };
    return {
        success: true,
        total,
        page,
        limit,
        mode: await mode(),
        counts: { total: c.total, disabled: c.disabled, claimed: c.claimed, available: c.total - c.disabled - c.claimed },
        batches: batches.filter(Boolean).sort(),
        entries: rows.map(r => {
            const cam = bySerial.get(r.serial);
            return {
                serial: r.serial,
                verifyCodeMasked: maskCode(r.verifyCode),
                model: r.model,
                hwVersion: r.hwVersion,
                batch: r.batch,
                note: r.note,
                status: statusOf(r),
                disabled: !!r.disabled,
                disabledReason: r.disabledReason || '',
                claimedAt: r.claimedAt || null,
                claimedBy: r.claimedBy ? (emailOf.get(String(r.claimedBy)) || null) : null,
                createdAt: r.createdAt,
                camera: cam ? {
                    deviceName: cam.deviceName,
                    owner: cam.userId?.email || null,
                    unclaimed: !!cam.unclaimed,
                    disabled: !!cam.adminDisabled?.at
                } : null
            };
        })
    };
}

/** POST /api/admin/registry { serial, verifyCode, model?, hwVersion?, batch?, note? } */
async function add(body, actorId) {
    const entry = entryOf(body);
    const problem = checkEntry(entry);
    if (problem) return fail(400, 'BAD_REQUEST', ENTRY_ERRORS[problem]);
    if (await DeviceRegistry.exists({ serial: entry.serial })) return fail(409, 'EXISTS', 'This serial is already in the registry.');
    try {
        await DeviceRegistry.create({ ...entry, createdBy: actorId });
    } catch (err) {
        if (err?.code === 11000) return fail(409, 'EXISTS', 'This serial is already in the registry.');
        throw err;
    }
    return { status: 201, body: { success: true, serial: entry.serial } };
}

/** PUT /api/admin/registry/:serial { verifyCode?, model?, hwVersion?, batch?, note?, disabled?, disabledReason? } */
async function update(serial, body, now = new Date()) {
    const current = await lookup(serial);
    if (!current) return fail(404, 'NOT_FOUND', 'This serial is not in the registry.');
    const b = body && typeof body === 'object' ? body : {};
    const next = entryOf({ ...current, ...b, serial: current.serial });
    const problem = checkEntry(next);
    if (problem) return fail(400, 'BAD_REQUEST', ENTRY_ERRORS[problem]);
    if (b.disabled !== undefined && typeof b.disabled !== 'boolean') return fail(400, 'BAD_REQUEST', 'disabled must be true or false.');
    // The label code of a camera someone already added cannot change under them
    if (current.claimedAt && next.verifyCode !== current.verifyCode) return fail(409, 'CLAIMED', 'The code of a camera that is already in an account cannot change.');
    const set = { model: next.model, hwVersion: next.hwVersion, batch: next.batch, note: next.note, verifyCode: next.verifyCode, updatedAt: now };
    if (b.disabled !== undefined) {
        set.disabled = b.disabled;
        set.disabledReason = b.disabled ? clip(b.disabledReason, 300) : '';
    } else if (b.disabledReason !== undefined && current.disabled) {
        set.disabledReason = clip(b.disabledReason, 300);
    }
    await DeviceRegistry.updateOne({ serial: current.serial }, { $set: set });
    const changed = Object.keys(set).filter(k => k !== 'updatedAt' && String(set[k] ?? '') !== String(current[k] ?? ''));
    return { status: 200, body: { success: true, serial: current.serial, changed } };
}

/** DELETE /api/admin/registry/:serial: only a serial nobody added to an account. */
async function remove(serial) {
    const current = await lookup(serial);
    if (!current) return fail(404, 'NOT_FOUND', 'This serial is not in the registry.');
    const inUse = current.claimedAt || await Camera.exists({ deviceSerial: current.serial, userId: { $ne: null } });
    if (inUse) return fail(409, 'CLAIMED', 'This camera is in an account: block the serial instead.');
    await DeviceRegistry.deleteOne({ serial: current.serial });
    return { status: 200, body: { success: true } };
}

async function revealCode(serial) {
    const current = await lookup(serial);
    if (!current) return fail(404, 'NOT_FOUND', 'This serial is not in the registry.');
    return { status: 200, body: { success: true, serial: current.serial, verifyCode: current.verifyCode } };
}

// ---------- Import ----------

const HEADER = ['serial', 'verifycode', 'model', 'hwversion', 'batch', 'note'];

/** One CSV line into fields (quotes, doubled quotes, commas or semicolons). */
function splitCsvLine(line, sep) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
}

/** The label QR text (camos-esp32-trap tools/label.py): CAMOS:1;SN:<serial>;VC:<code>;M:<model>;; */
function parseLabel(line) {
    if (!/^CAMOS:1;/i.test(line)) return null;
    const fields = Object.fromEntries(line.split(';').map(p => p.split(':')).filter(p => p.length >= 2).map(([k, ...v]) => [k.toUpperCase(), v.join(':')]));
    return { serial: fields.SN, verifyCode: fields.VC, model: fields.M };
}

/** Rows of a CSV text (with or without the header line) or of label QR lines. */
function parseRows(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
    const rows = [];
    let columns = null;
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        const label = parseLabel(line);
        if (label) return rows.push({ line: i + 1, ...label });
        const sep = !line.includes(',') && line.includes(';') ? ';' : ',';
        const cells = splitCsvLine(line, sep);
        if (!columns && cells.some(c => HEADER.includes(c.toLowerCase().replace(/[\s_]/g, '')))) {
            columns = cells.map(c => c.toLowerCase().replace(/[\s_]/g, ''));
            return;
        }
        const cols = columns || HEADER;
        const at = (name) => {
            const idx = cols.indexOf(name);
            return idx >= 0 ? cells[idx] : undefined;
        };
        rows.push({ line: i + 1, serial: at('serial'), verifyCode: at('verifycode'), model: at('model'), hwVersion: at('hwversion'), batch: at('batch'), note: at('note') });
    });
    return rows;
}

/**
 * POST /api/admin/registry/import { csv, dryRun?, overwrite?, batch? }: up to 5,000 rows. A serial already in the
 * registry is skipped, or (overwrite) updated while nobody added it to an account. `batch` fills empty batch cells.
 * Returns { created, updated, skipped, errors: [{ line, serial, error }] }; a dry run writes nothing.
 */
async function importCsv({ csv, dryRun = false, overwrite = false, batch = '' } = {}, actorId, now = new Date()) {
    if (typeof csv !== 'string' || !csv.trim()) return fail(400, 'BAD_REQUEST', 'csv is required.');
    const rows = parseRows(csv);
    if (rows.length > MAX_IMPORT_ROWS) return fail(400, 'TOO_MANY', `At most ${MAX_IMPORT_ROWS} rows per import.`);
    const errors = [];
    const seen = new Set();
    const valid = [];
    for (const row of rows) {
        const entry = entryOf({ ...row, batch: row.batch || batch });
        const problem = checkEntry(entry);
        if (problem) { errors.push({ line: row.line, serial: entry.serial, error: problem }); continue; }
        if (seen.has(entry.serial)) { errors.push({ line: row.line, serial: entry.serial, error: 'duplicate' }); continue; }
        seen.add(entry.serial);
        valid.push(entry);
    }
    const existing = await DeviceRegistry.find({ serial: { $in: valid.map(v => v.serial) } }).select('serial claimedAt verifyCode').lean();
    const existingBy = new Map(existing.map(e => [e.serial, e]));
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const toCreate = [];
    for (const entry of valid) {
        const old = existingBy.get(entry.serial);
        if (!old) { toCreate.push({ ...entry, createdBy: actorId, createdAt: now, updatedAt: now }); continue; }
        if (!overwrite) { skipped++; continue; }
        if (old.claimedAt && old.verifyCode !== entry.verifyCode) { errors.push({ serial: entry.serial, error: 'claimed' }); continue; }
        if (!dryRun) await DeviceRegistry.updateOne({ serial: entry.serial }, { $set: { ...entry, updatedAt: now } });
        updated++;
    }
    if (!dryRun && toCreate.length) {
        try {
            const done = await DeviceRegistry.insertMany(toCreate, { ordered: false });
            created = done.length;
        } catch (err) {
            created = err?.insertedDocs?.length ?? err?.result?.insertedCount ?? 0;
            skipped += toCreate.length - created;
        }
    } else {
        created = toCreate.length;
    }
    return { status: 200, body: { success: true, dryRun: !!dryRun, rows: rows.length, created, updated, skipped, errors: errors.slice(0, 200), errorCount: errors.length } };
}

/**
 * POST /api/admin/registry/backfill: every CamOS camera already known (registered, claimed or added by its owner)
 * goes into the registry with its current code, so turning on strict mode locks nobody out.
 */
async function backfill(actorId, now = new Date()) {
    const cameras = await Camera.find({ platform: 'camos', simulated: { $ne: true } }).select('deviceSerial validateCode model userId claimedAt addedAt device.hw').lean();
    const known = new Set((await DeviceRegistry.find({ serial: { $in: cameras.map(c => c.deviceSerial.toUpperCase()) } }).select('serial').lean()).map(e => e.serial));
    let added = 0;
    let skipped = 0;
    for (const cam of cameras) {
        const entry = entryOf({ serial: cam.deviceSerial, verifyCode: cam.validateCode, model: cam.model, hwVersion: cam.device?.hw || '' });
        if (known.has(entry.serial) || checkEntry(entry)) { skipped++; continue; }
        await DeviceRegistry.create({
            ...entry,
            createdBy: actorId,
            createdAt: now,
            ...(cam.userId ? { claimedAt: cam.claimedAt || cam.addedAt || now, claimedBy: cam.userId } : {})
        }).then(() => { added++; }, () => { skipped++; });
    }
    return { status: 200, body: { success: true, added, skipped } };
}

module.exports = {
    STATUSES,
    MAX_IMPORT_ROWS,
    maskCode,
    codesMatch,
    mode,
    lookup,
    checkClaim,
    checkRegister,
    setCode,
    markClaimed,
    list,
    add,
    update,
    remove,
    revealCode,
    parseRows,
    importCsv,
    backfill
};
