const mongoose = require('mongoose');
const { Treatment, Camera, User } = require('../models');
const { TREATMENT_TYPES } = require('../models/Treatment');
const { getViewableSerials, canManageCamera } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const { recordAudit } = require('../services/auditService');
const treatmentService = require('../services/treatmentService');

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
async function validateInput(body, user, { partial = false } = {}) {
    const value = {};
    if (!partial || body.type !== undefined) {
        if (!TREATMENT_TYPES.includes(body.type)) return { error: `type must be one of ${TREATMENT_TYPES.join(', ')}.` };
        value.type = body.type;
    }
    if (!partial || body.at !== undefined) {
        const at = new Date(body.at);
        if (isNaN(at) || at > new Date(Date.now() + 24 * 60 * 60 * 1000) || at < new Date(Date.now() - MAX_BACKDATE_MS)) {
            return { error: "Invalid date (up to a year back, not in the future)." };
        }
        value.at = at;
    }
    if (!partial || body.cameraSerials !== undefined) {
        const serials = body.cameraSerials;
        if (!Array.isArray(serials) || !serials.length || serials.length > MAX_CAMERAS || serials.some(s => typeof s !== 'string')) {
            return { error: `Choose 1 to ${MAX_CAMERAS} cameras.` };
        }
        const unique = [...new Set(serials)];
        const cameras = await Camera.find({ deviceSerial: { $in: unique } }).select('deviceSerial userId sharedWith');
        if (cameras.length !== unique.length || cameras.some(c => !canManageCamera(user, c))) {
            return { error: "Some cameras were not found or you cannot manage them.", code: 'CAMERA_NOT_FOUND' };
        }
        value.cameraSerials = unique;
    }
    for (const [field, max] of Object.entries(TEXT_LIMITS)) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== 'string' || body[field].length > max) return { error: `${field} must be at most ${max} characters.` };
        value[field] = body[field].trim();
    }
    if (body.preHarvestDays !== undefined) {
        if (body.preHarvestDays !== null && (!Number.isInteger(body.preHarvestDays) || body.preHarvestDays < 0 || body.preHarvestDays > 365)) {
            return { error: "preHarvestDays must be a whole number from 0 to 365." };
        }
        value.preHarvestDays = body.preHarvestDays;
    }
    if (value.type === 'spray' && !partial && !value.product) return { error: "Enter the product used.", code: 'PRODUCT_REQUIRED' };
    return { value };
}

const sendError = (res, result) =>
    res.status(400).json({ success: false, message: result.error, ...(result.code ? { code: result.code } : {}) });

/**
 * GET /api/treatments?deviceSerial=&type=&from=&to=&page=&limit=&effect=1
 */
async function listTreatments(req, res) {
    try {
        const visible = new Set(await getViewableSerials(req.user));
        if (!visible.size) return res.json({ success: true, total: 0, treatments: [] });

        const filter = {};
        if (typeof req.query.deviceSerial === 'string' && req.query.deviceSerial && req.query.deviceSerial !== 'all') {
            if (!visible.has(req.query.deviceSerial)) return res.status(403).json({ success: false, message: "You cannot see this camera." });
            filter.cameraSerials = req.query.deviceSerial;
        } else {
            filter.cameraSerials = { $in: [...visible] };
        }
        if (TREATMENT_TYPES.includes(req.query.type)) filter.type = req.query.type;
        const from = req.query.from ? new Date(req.query.from) : null;
        const to = req.query.to ? new Date(req.query.to) : null;
        if ((from && !isNaN(from)) || (to && !isNaN(to))) {
            filter.at = {};
            if (from && !isNaN(from)) filter.at.$gte = from;
            if (to && !isNaN(to)) filter.at.$lte = to;
        }

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
        const [total, items] = await Promise.all([
            Treatment.countDocuments(filter),
            Treatment.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean()
        ]);

        // Effect summary per row (small queries on the daily rollup); skipped for big exports
        const withEffect = req.query.effect === '1' && limit <= 50;
        const treatments = await Promise.all(items.map(async (t) => {
            if (!withEffect) return toClient(t, visible);
            const serials = t.cameraSerials.filter(s => visible.has(s));
            const effect = await treatmentService.effectOf(t, serials);
            return toClient(t, visible, { status: effect.status, changePct: effect.changePct, before: effect.before, after: effect.after });
        }));
        res.json({ success: true, total, page, limit, treatments });
    } catch (err) {
        sendServerError(res, err, { context: 'List treatments' });
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
        const result = await validateInput(req.body || {}, req.user);
        if (result.error) return sendError(res, result);
        const treatment = await Treatment.create({ ...result.value, createdBy: req.user.id, createdByEmail: req.user.email });
        recordAudit(req, { action: 'treatment.created', target: auditTarget(treatment), details: { cameras: treatment.cameraSerials, at: treatment.at.toISOString() } });
        const visible = new Set(await getViewableSerials(req.user));
        res.status(201).json({ success: true, treatment: toClient(treatment, visible) });
    } catch (err) {
        sendServerError(res, err, { context: 'Create treatment' });
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
    sendVietGapRecord,
    validateInput,
    listTreatments,
    getEffect,
    createTreatment,
    updateTreatment,
    deleteTreatment
};
