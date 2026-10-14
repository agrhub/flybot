const mongoose = require('mongoose');
const { Treatment, Camera, User } = require('../models');
const { TREATMENT_TYPES } = require('../models/Treatment');
const { getViewableSerials, canManageCamera, viewableCameras } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const { recordAudit } = require('../services/auditService');
const treatmentService = require('../services/treatmentService');
const harvestService = require('../services/harvestService');
const { readClientId, isDuplicateKey } = require('../utils/clientId');

const MAX_PAGE_SIZE = 500;
const MAX_CAMERAS = 50;
const TEXT_LIMITS = { product: 120, activeIngredient: 120, dose: 60, area: 60, operator: 80, note: 500 };
const MAX_BACKDATE_MS = 365 * 24 * 60 * 60 * 1000;

const NOT_FOUND = { success: false, message: "Treatment not found." };

function toClient(t, visibleSerials, effect = undefined) {
    const out = {
        id: String(t._id),
        // Only the cameras this viewer can see
        cameraSerials: t.cameraSerials.filter(s => visibleSerials.has(s)),
        type: t.type,
        at: t.at,
        product: t.product,
        activeIngredient: t.activeIngredient,
        dose: t.dose,
        area: t.area,
        operator: t.operator,
        preHarvestDays: t.preHarvestDays,
        harvestAllowedFrom: Number.isInteger(t.preHarvestDays) ? new Date(new Date(t.at).getTime() + t.preHarvestDays * 24 * 60 * 60 * 1000) : null,
        note: t.note,
        createdBy: t.createdByEmail || null
    };
    if (effect !== undefined) out.effect = effect;
    return out;
}

/**
 * Validate a create/update body. All cameras must be manageable by the user.
 * Returns { value } or { error }.
 */
async function validateInput(body, user, { partial = false, manageable = null } = {}) {
    const value = {};
    if (!partial || body.type !== undefined) {
        if (!TREATMENT_TYPES.includes(body.type)) return { error: `type must be one of ${TREATMENT_TYPES.join(', ')}.`, code: 'INVALID_TYPE' };
        value.type = body.type;
    }
    if (!partial || body.at !== undefined) {
        const at = new Date(body.at);
        if (isNaN(at) || at > new Date(Date.now() + 24 * 60 * 60 * 1000) || at < new Date(Date.now() - MAX_BACKDATE_MS)) {
            return { error: "Invalid date (up to a year back, not in the future).", code: 'INVALID_DATE' };
        }
        value.at = at;
    }
    if (!partial || body.cameraSerials !== undefined) {
        const serials = body.cameraSerials;
        if (!Array.isArray(serials) || !serials.length || serials.length > MAX_CAMERAS || serials.some(s => typeof s !== 'string')) {
            return { error: `Choose 1 to ${MAX_CAMERAS} cameras.`, code: 'INVALID_CAMERAS' };
        }
        const unique = [...new Set(serials)];
        // An import checks many rows against one list of the user's cameras
        const allowed = manageable ? unique.every(serial => manageable.has(serial))
            : await Camera.find({ deviceSerial: { $in: unique } }).select('deviceSerial userId sharedWith')
                .then(cameras => cameras.length === unique.length && cameras.every(c => canManageCamera(user, c)));
        if (!allowed) {
            return { error: "Some cameras were not found or you cannot manage them.", code: 'CAMERA_NOT_FOUND' };
        }
        value.cameraSerials = unique;
    }
    for (const [field, max] of Object.entries(TEXT_LIMITS)) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== 'string' || body[field].length > max) return { error: `${field} must be at most ${max} characters.`, code: 'TEXT_TOO_LONG', field };
        value[field] = body[field].trim();
    }
    if (body.preHarvestDays !== undefined) {
        if (body.preHarvestDays !== null && (!Number.isInteger(body.preHarvestDays) || body.preHarvestDays < 0 || body.preHarvestDays > 365)) {
            return { error: "preHarvestDays must be a whole number from 0 to 365.", code: 'INVALID_PHI' };
        }
        value.preHarvestDays = body.preHarvestDays;
    }
    if (value.type === 'spray' && !partial && !value.product) return { error: "Enter the product used.", code: 'PRODUCT_REQUIRED' };
    return { value };
}

const sendError = (res, result) =>
    res.status(400).json({ success: false, message: result.error, ...(result.code ? { code: result.code } : {}) });

/**
 * GET /api/treatments/withholding: treatments on the viewer's traps still inside their
 * pre-harvest interval, the soonest to end first.
 */
async function listWithholding(req, res) {
    try {
        res.json({ success: true, treatments: await harvestService.activeWithholding(req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'List pre-harvest intervals' });
    }
}

/**
 * The query filter for ?deviceSerial=&type=&from=&to= on the viewer's traps.
 * Returns { filter } or { forbidden: true } for a camera they cannot see.
 */
function treatmentFilter(query, visible) {
    const filter = {};
    if (typeof query.deviceSerial === 'string' && query.deviceSerial && query.deviceSerial !== 'all') {
        if (!visible.has(query.deviceSerial)) return { forbidden: true };
        filter.cameraSerials = query.deviceSerial;
    } else {
        filter.cameraSerials = { $in: [...visible] };
    }
    if (TREATMENT_TYPES.includes(query.type)) filter.type = query.type;
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if ((from && !isNaN(from)) || (to && !isNaN(to))) {
        filter.at = {};
        if (from && !isNaN(from)) filter.at.$gte = from;
        if (to && !isNaN(to)) filter.at.$lte = to;
    }
    return { filter };
}

const CANNOT_SEE_CAMERA = { success: false, message: "You cannot see this camera." };

/**
 * GET /api/treatments?deviceSerial=&type=&from=&to=&page=&limit=&effect=1
 */
async function listTreatments(req, res) {
    try {
        const visible = new Set(await getViewableSerials(req.user));
        // A camera they cannot see is refused the same way whether or not they have cameras
        const { filter, forbidden } = treatmentFilter(req.query, visible);
        if (forbidden) return res.status(403).json(CANNOT_SEE_CAMERA);
        if (!visible.size) return res.json({ success: true, total: 0, treatments: [] });

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
        const [total, items] = await Promise.all([
            Treatment.countDocuments(filter),
            Treatment.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean()
        ]);

        // Effect summary per row (small queries on the daily rollup); skipped for big exports
        const withEffect = req.query.effect === '1' && limit <= 50;
        // The page's rollup read once for all its rows
        let data = null;
        if (withEffect && items.length) {
            const serials = [...new Set(items.flatMap(t => t.cameraSerials.filter(sr => visible.has(sr))))];
            const now = new Date();
            const keys = items.map(t => treatmentService.effectRange(t, treatmentService.DEFAULT_WINDOW_DAYS, now));
            data = await treatmentService.loadEffectData(serials, keys.map(k => k.fromKey).sort()[0], keys.map(k => k.toKey).sort().at(-1));
        }
        const treatments = items.map((t) => {
            if (!withEffect) return toClient(t, visible);
            const effect = treatmentService.computeEffect(t, t.cameraSerials.filter(sr => visible.has(sr)), data);
            return toClient(t, visible, { status: effect.status, changePct: effect.changePct, before: effect.before, after: effect.after });
        });
        res.json({ success: true, total, page, limit, treatments });
    } catch (err) {
        sendServerError(res, err, { context: 'List treatments' });
    }
}

// Uses judged per ingredient: enough for a season, bounded so the summary stays quick
const MAX_EFFECTIVENESS_TREATMENTS = 200;
const DEFAULT_EFFECTIVENESS_DAYS = 365;

/**
 * GET /api/treatments/effectiveness?deviceSerial=&type=&from=&to=
 * Each active ingredient (or product) with its uses and average effect on catches.
 * Without dates: the last 12 months.
 */
async function getEffectiveness(req, res) {
    try {
        const visible = new Set(await getViewableSerials(req.user));
        const { filter, forbidden } = treatmentFilter(req.query, visible);
        if (forbidden) return res.status(403).json(CANNOT_SEE_CAMERA);
        if (!visible.size) return res.json({ success: true, ingredients: [] });
        if (!filter.at) filter.at = { $gte: new Date(Date.now() - DEFAULT_EFFECTIVENESS_DAYS * 24 * 60 * 60 * 1000) };
        const treatments = await Treatment.find(filter).sort({ at: -1 }).limit(MAX_EFFECTIVENESS_TREATMENTS).lean();
        res.json({ success: true, ingredients: await treatmentService.effectivenessByIngredient(treatments, visible) });
    } catch (err) {
        sendServerError(res, err, { context: 'Treatment effectiveness' });
    }
}

async function findVisible(req) {
    if (!mongoose.isValidObjectId(req.params.id)) return null;
    const treatment = await Treatment.findById(req.params.id);
    if (!treatment) return null;
    const visible = new Set(await getViewableSerials(req.user));
    if (!treatment.cameraSerials.some(s => visible.has(s))) return null;
    return { treatment, visible };
}

async function canEdit(user, treatment) {
    const cameras = await Camera.find({ deviceSerial: { $in: treatment.cameraSerials } }).select('userId sharedWith');
    return cameras.length > 0 && cameras.every(c => canManageCamera(user, c));
}

/**
 * GET /api/treatments/:id/effect: catches per day before/after, per camera
 */
async function getEffect(req, res) {
    try {
        const found = await findVisible(req);
        if (!found) return res.status(404).json(NOT_FOUND);
        const serials = found.treatment.cameraSerials.filter(s => found.visible.has(s));
        const effect = await treatmentService.effectOf(found.treatment, serials);
        const names = await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName').lean();
        const nameOf = new Map(names.map(c => [c.deviceSerial, c.deviceName]));
        effect.cameras = effect.cameras.map(c => ({ ...c, deviceName: nameOf.get(c.deviceSerial) || c.deviceSerial }));
        res.json({ success: true, treatment: toClient(found.treatment, found.visible), effect });
    } catch (err) {
        sendServerError(res, err, { context: 'Treatment effect' });
    }
}

const auditTarget = (t) => ({ type: 'treatment', id: String(t._id), label: `${t.type}${t.product ? `: ${t.product}` : ''}` });

/**
 * POST /api/treatments (owners/admins of every listed camera)
 */
async function createTreatment(req, res) {
    try {
        const clientId = readClientId(req.body);
        if (clientId.error) return sendError(res, clientId);
        // Sent again (offline, then the signal came back): the first one stands
        const sentBefore = async () => clientId.value && Treatment.findOne({ createdBy: req.user.id, clientId: clientId.value });
        const existing = await sentBefore();
        if (existing) return res.json({ success: true, duplicate: true, treatment: toClient(existing, new Set(await getViewableSerials(req.user))) });
        const result = await validateInput(req.body || {}, req.user);
        if (result.error) return sendError(res, result);
        let treatment;
        try {
            treatment = await Treatment.create({ ...result.value, clientId: clientId.value, createdBy: req.user.id, createdByEmail: req.user.email });
        } catch (err) {
            // Two sends at the same moment: the other one won
            if (!isDuplicateKey(err)) throw err;
            return res.json({ success: true, duplicate: true, treatment: toClient(await sentBefore(), new Set(await getViewableSerials(req.user))) });
        }
        recordAudit(req, { action: 'treatment.created', target: auditTarget(treatment), details: { cameras: treatment.cameraSerials, at: treatment.at.toISOString() } });
        const visible = new Set(await getViewableSerials(req.user));
        res.status(201).json({ success: true, treatment: toClient(treatment, visible) });
    } catch (err) {
        sendServerError(res, err, { context: 'Create treatment' });
    }
}

const MAX_IMPORT_ROWS = 500;
// Same day, minute, kind, product and traps: the same treatment entered twice
const sameKey = (t) => [new Date(t.at).toISOString().slice(0, 16), t.type, (t.product || '').toLowerCase(), [...t.cameraSerials].sort().join(',')].join('|');

/**
 * POST /api/treatments/import { rows: [{ type, at, cameraSerials, product, ... }], dryRun }
 * A paper or spreadsheet log typed in once: every row is checked like a new treatment, rows
 * already in the log (or twice in the file) are skipped, and with dryRun nothing is saved, so
 * the page can show what will happen. One status per row: ready / imported, duplicate, error.
 */
async function importTreatments(req, res) {
    try {
        const rows = req.body?.rows;
        if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ success: false, message: "Send the rows to import." });
        if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ success: false, message: `At most ${MAX_IMPORT_ROWS} rows at a time.` });
        const dryRun = req.body.dryRun === true;

        const cameras = await viewableCameras(req.user).select('deviceSerial userId sharedWith');
        const manageable = new Set(cameras.filter(cam => canManageCamera(req.user, cam)).map(cam => cam.deviceSerial));
        const results = [];
        const valid = [];
        for (const [index, row] of rows.entries()) {
            const result = row && typeof row === 'object' ? await validateInput(row, req.user, { manageable }) : { code: 'INVALID_ROW' };
            if (result.code || result.error) {
                results.push({ row: index, status: 'error', code: result.code || 'INVALID_ROW', ...(result.field ? { field: result.field } : {}) });
                continue;
            }
            valid.push({ index, value: result.value });
            results.push({ row: index, status: dryRun ? 'ready' : 'imported' });
        }

        // Skip what the log already has, and repeats inside the file
        if (valid.length) {
            const times = valid.map(v => v.value.at.getTime());
            const existing = await Treatment.find({
                cameraSerials: { $in: [...new Set(valid.flatMap(v => v.value.cameraSerials))] },
                at: { $gte: new Date(Math.min(...times) - 60000), $lte: new Date(Math.max(...times) + 60000) }
            }).select('at type product cameraSerials').lean();
            const seen = new Set(existing.map(sameKey));
            const kept = [];
            for (const v of valid) {
                const key = sameKey(v.value);
                if (seen.has(key)) {
                    results[v.index] = { row: v.index, status: 'duplicate' };
                    continue;
                }
                seen.add(key);
                kept.push(v);
            }
            if (!dryRun && kept.length) {
                await Treatment.insertMany(kept.map(v => ({ ...v.value, createdBy: req.user.id, createdByEmail: req.user.email })));
                recordAudit(req, { action: 'treatment.imported', details: { count: kept.length, rows: rows.length } });
            }
        }
        const count = (status) => results.filter(r => r.status === status).length;
        res.json({
            success: true,
            dryRun,
            summary: { rows: rows.length, ready: count('ready'), imported: count('imported'), duplicate: count('duplicate'), error: count('error') },
            results
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Import treatments' });
    }
}

/**
 * PUT /api/treatments/:id (partial)
 */
async function updateTreatment(req, res) {
    try {
        const found = await findVisible(req);
        if (!found) return res.status(404).json(NOT_FOUND);
        if (!(await canEdit(req.user, found.treatment))) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot change this treatment." });
        }
        const result = await validateInput(req.body || {}, req.user, { partial: true });
        if (result.error) return sendError(res, result);
        Object.assign(found.treatment, result.value, { updatedAt: new Date() });
        // A new date or interval means a new day to remind
        if (result.value.at !== undefined || result.value.preHarvestDays !== undefined) found.treatment.harvestNotifiedAt = null;
        await found.treatment.save();
        recordAudit(req, { action: 'treatment.updated', target: auditTarget(found.treatment), details: { fields: Object.keys(result.value) } });
        res.json({ success: true, treatment: toClient(found.treatment, found.visible) });
    } catch (err) {
        sendServerError(res, err, { context: 'Update treatment' });
    }
}

/**
 * DELETE /api/treatments/:id
 */
async function deleteTreatment(req, res) {
    try {
        const found = await findVisible(req);
        if (!found) return res.status(404).json(NOT_FOUND);
        if (!(await canEdit(req.user, found.treatment))) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot delete this treatment." });
        }
        await Treatment.deleteOne({ _id: found.treatment._id });
        recordAudit(req, { action: 'treatment.deleted', target: auditTarget(found.treatment) });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete treatment' });
    }
}

/**
 * POST /api/treatments/vietgap/send: last month's record to the signed-in person now
 * (email and linked Telegram), the same PDF as the monthly one.
 */
async function sendVietGapRecord(req, res) {
    try {
        const user = await User.findById(req.user.id).select('email name role language emailVerified notificationPrefs telegram disabled');
        const result = await require('../services/vietgapService').sendVietGapLog(user);
        if (result.reason === 'no_channel') {
            return res.status(400).json({ success: false, code: 'NO_CHANNEL', message: "Confirm your email or link Telegram to receive the record." });
        }
        res.json({ success: true, sent: result.sent, count: result.count, month: result.month });
    } catch (err) {
        sendServerError(res, err, { context: 'Send VietGAP record' });
    }
}

module.exports = {
    importTreatments,
    listWithholding,
    getEffectiveness,
    sendVietGapRecord,
    validateInput,
    listTreatments,
    getEffect,
    createTreatment,
    updateTreatment,
    deleteTreatment
};
