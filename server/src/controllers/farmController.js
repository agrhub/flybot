const mongoose = require('mongoose');
const { Farm, Plot, Camera } = require('../models');
const timezoneService = require('../services/timezoneService');
const { canManageCamera, getViewableSerials } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const { normalizeLanguage } = require('../utils/i18n');
const { recordAudit } = require('../services/auditService');
const { queueMail } = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const notificationService = require('../services/notificationService');
const farmService = require('../services/farmService');
const farmCompareService = require('../services/farmCompareService');
const sprayPlanService = require('../services/sprayPlanService');
const seasonReportService = require('../services/seasonReportService');
const { EMAIL_REGEX, normalizeEmail, findUserByEmail, safeUrl, withAccountStatus } = require('./shareController');

const MAX_FARMS_PER_OWNER = 50;
const MAX_PLOTS_PER_FARM = 100;
const MAX_SHARES = 50;
const MAX_BOUNDARY_POINTS = 200;
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const NOT_FOUND = { success: false, message: "Farm not found." };

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const sharesOf = (farm) => (farm.sharedWith || []).map(sh => ({
    email: sh.email,
    userId: sh.userId ? String(sh.userId) : null,
    status: sh.userId ? 'active' : 'pending',
    sharedAt: sh.sharedAt
}));
const farmTarget = (farm) => ({ type: 'farm', id: String(farm._id), label: farm.name });

async function findFarm(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    return Farm.findById(id).populate('ownerId', 'email name role');
}

async function loadViewable(req, res) {
    const farm = await findFarm(req.params.id);
    if (!farmService.canViewFarm(req.user, farm)) {
        res.status(404).json(NOT_FOUND);
        return null;
    }
    return farm;
}

async function loadEditable(req, res) {
    const farm = await loadViewable(req, res);
    if (!farm) return null;
    if (!farmService.canEditFarm(req.user, farm)) {
        res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot change this farm." });
        return null;
    }
    return farm;
}

const ownerOf = (farm) => (farm.ownerId?.email
    ? { id: String(farm.ownerId._id), email: farm.ownerId.email, name: farm.ownerId.name || farm.ownerId.email.split('@')[0] }
    : { id: String(farm.ownerId), email: '', name: '' });

function toPlot(plot) {
    return {
        id: String(plot._id),
        name: plot.name,
        crop: plot.crop,
        areaHa: plot.areaHa,
        color: plot.color,
        alertThreshold: plot.alertThreshold,
        boundary: plot.boundary || []
    };
}

function validatePlot(body, { partial = false } = {}) {
    const value = {};
    if (!partial || body.name !== undefined) {
        const name = text(body.name, 80);
        if (!name) return { error: "Please enter a plot name." };
        value.name = name;
    }
    if (body.crop !== undefined) value.crop = text(body.crop, 80);
    if (body.areaHa !== undefined) {
        if (body.areaHa !== null && (typeof body.areaHa !== 'number' || !(body.areaHa >= 0) || body.areaHa > 100000)) return { error: "Invalid area." };
        value.areaHa = body.areaHa;
    }
    if (body.color !== undefined) {
        if (!COLOR_REGEX.test(body.color)) return { error: "Invalid color." };
        value.color = body.color;
    }
    if (body.alertThreshold !== undefined) {
        if (body.alertThreshold !== null && (!Number.isInteger(body.alertThreshold) || body.alertThreshold < 1 || body.alertThreshold > 10000)) {
            return { error: "alertThreshold must be a whole number from 1 to 10000." };
        }
        value.alertThreshold = body.alertThreshold;
    }
    if (body.boundary !== undefined) {
        const b = body.boundary;
        const valid = Array.isArray(b) && (b.length === 0 || (b.length >= 3 && b.length <= MAX_BOUNDARY_POINTS))
            && b.every(p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
        if (!valid) return { error: `The boundary needs 3 to ${MAX_BOUNDARY_POINTS} points.` };
        value.boundary = b.map(([lat, lng]) => [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]);
    }
    return { value };
}

// ---------- Farms ----------

/**
 * GET /api/farms
 */
async function listFarms(req, res) {
    try {
        const farms = await Farm.find(farmService.farmViewFilter(req.user)).populate('ownerId', 'email name').sort({ name: 1 }).lean();
        const ids = farms.map(f => f._id);
        const [plots, cameras] = await Promise.all([
            Plot.aggregate([{ $match: { farmId: { $in: ids } } }, { $group: { _id: '$farmId', count: { $sum: 1 } } }]),
            Camera.aggregate([{ $match: { farmId: { $in: ids } } }, { $group: { _id: '$farmId', count: { $sum: 1 } } }])
        ]);
        const plotCount = new Map(plots.map(p => [String(p._id), p.count]));
        const cameraCount = new Map(cameras.map(c => [String(c._id), c.count]));
        res.json({
            success: true,
            farms: farms.map(f => ({
                id: String(f._id),
                name: f.name,
                description: f.description,
                timezone: f.timezone || '',
                owner: ownerOf(f),
                canEdit: farmService.canEditFarm(req.user, f),
                plotCount: plotCount.get(String(f._id)) || 0,
                cameraCount: cameraCount.get(String(f._id)) || 0
            }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'List farms' });
    }
}

/**
 * GET /api/farms/compare?days=7|30|90
 * The viewer's farms side by side: flies per trap per day against the period before, per plot.
 */
async function compareFarms(req, res) {
    try {
        const farms = await Farm.find(farmService.farmViewFilter(req.user)).select('name').lean();
        const visible = new Set(await getViewableSerials(req.user));
        const days = parseInt(req.query.days, 10);
        res.json({ success: true, ...(await farmCompareService.compareFarms(farms, visible, days)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Compare farms' });
    }
}

/**
 * GET /api/farms/plan: what to do next on each plot (treat, bait before the next generation,
 * collect fallen fruit, or keep monitoring), the most urgent first
 */
async function getPlan(req, res) {
    try {
        res.json({ success: true, ...(await sprayPlanService.planFor(req.user)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Spray plan' });
    }
}

/**
 * GET /api/farms/season-report?from=YYYY-MM-DD&to=YYYY-MM-DD: the season report PDF
 * (the last 6 months by default).
 */
async function downloadSeasonReport(req, res) {
    try {
        const period = seasonReportService.parsePeriod(req.query);
        if (period.error) return res.status(400).json({ success: false, message: period.error });
        const data = await seasonReportService.seasonData(req.user, period);
        const pdf = seasonReportService.buildSeasonPdf(data, { language: req.user.language, owner: req.user.name || req.user.email });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="FlyBot_season_${period.fromKey}_${period.toKey}.pdf"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(pdf);
    } catch (err) {
        sendServerError(res, err, { context: 'Season report' });
    }
}

/**
 * POST /api/farms/season-report/send { from, to }: the same PDF to the user's email.
 */
async function sendSeasonReport(req, res) {
    try {
        if (!req.user.emailVerified) return res.status(400).json({ success: false, message: "Confirm your email address first." });
        const period = seasonReportService.parsePeriod(req.body || {});
        if (period.error) return res.status(400).json({ success: false, message: period.error });
        const data = await seasonReportService.seasonData(req.user, period);
        const language = normalizeLanguage(req.user.language);
        const pdf = seasonReportService.buildSeasonPdf(data, { language, owner: req.user.name || req.user.email });
        const params = { from: period.fromKey.split('-').reverse().join('/'), to: period.toKey.split('-').reverse().join('/'), farms: data.farms.length };
        queueMail(emailTemplates.seasonEmail({
            user: req.user, language, params, url: safeUrl('/farms'),
            attachments: [{ filename: `FlyBot_season_${period.fromKey}_${period.toKey}.pdf`, content: pdf, contentType: 'application/pdf' }]
        }));
        res.json({ success: true, farms: data.farms.length });
    } catch (err) {
        sendServerError(res, err, { context: 'Send season report' });
    }
}

/**
 * POST /api/farms { name, description } (admin, manager)
 */
async function createFarm(req, res) {
    try {
        const name = text(req.body.name, 80);
        if (!name) return res.status(400).json({ success: false, message: "Please enter a farm name." });
        if ((await Farm.countDocuments({ ownerId: req.user.id })) >= MAX_FARMS_PER_OWNER) {
            return res.status(400).json({ success: false, message: `You can have at most ${MAX_FARMS_PER_OWNER} farms.` });
        }
        const timezone = req.body.timezone === undefined ? '' : String(req.body.timezone || '');
        if (timezone && !timezoneService.isZone(timezone)) return res.status(400).json({ success: false, message: "timezone must be an IANA timezone such as Asia/Ho_Chi_Minh." });
        const orgId = await require('../services/orgService').defaultOrgFor(req.user);
        const farm = await Farm.create({ ownerId: req.user.id, name, description: text(req.body.description, 500), orgId, timezone });
        recordAudit(req, { action: 'farm.created', target: farmTarget(farm) });
        res.status(201).json({ success: true, farm: { id: String(farm._id), name: farm.name, description: farm.description, timezone: farm.timezone } });
    } catch (err) {
        sendServerError(res, err, { context: 'Create farm' });
    }
}

/**
 * GET /api/farms/:id: plots with live figures, the farm's cameras, and (for editors) shares
 */
async function getFarm(req, res) {
    try {
        const farm = await loadViewable(req, res);
        if (!farm) return;
        const canEdit = farmService.canEditFarm(req.user, farm);
        const [plots, cameras] = await Promise.all([
            Plot.find({ farmId: farm._id }).sort({ name: 1 }).lean(),
            Camera.find({ farmId: farm._id }).select('deviceSerial deviceName status plotId alertThreshold latitude longitude').lean()
        ]);
        const stats = await farmService.plotStats(plots, cameras);
        const statsBy = new Map(stats.map(s => [s.plotId, s]));
        // Cameras the editor may still add to a plot
        let assignable = [];
        if (canEdit) {
            const filter = await farmService.assignableFilter(farm);
            const candidates = await Camera.find(filter).select('deviceSerial deviceName userId farmId plotId sharedWith').lean();
            assignable = candidates
                .filter(c => canManageCamera(req.user, c))
                .map(c => ({ deviceSerial: c.deviceSerial, deviceName: c.deviceName, farmId: c.farmId ? String(c.farmId) : null, plotId: c.plotId ? String(c.plotId) : null }));
        }
        res.json({
            success: true,
            farm: {
                id: String(farm._id),
                name: farm.name,
                description: farm.description,
                owner: ownerOf(farm),
                canEdit,
                ...(canEdit ? { sharedWith: await withAccountStatus(sharesOf(farm)) } : {})
            },
            plots: plots.map(p => ({ ...toPlot(p), stats: statsBy.get(String(p._id)) })),
            cameras: cameras.map(c => ({
                deviceSerial: c.deviceSerial,
                deviceName: c.deviceName,
                status: c.status,
                plotId: c.plotId ? String(c.plotId) : null,
                latitude: c.latitude,
                longitude: c.longitude
            })),
            assignable
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Get farm' });
    }
}

/**
 * PUT /api/farms/:id { name?, description? }
 */
async function updateFarm(req, res) {
    try {
        const farm = await loadEditable(req, res);
        if (!farm) return;
        if (req.body.name !== undefined) {
            const name = text(req.body.name, 80);
            if (!name) return res.status(400).json({ success: false, message: "Please enter a farm name." });
            farm.name = name;
        }
        if (req.body.description !== undefined) farm.description = text(req.body.description, 500);
        let timezoneChanged = false;
        if (req.body.timezone !== undefined) {
            const timezone = String(req.body.timezone || '');
            if (timezone && !timezoneService.isZone(timezone)) return res.status(400).json({ success: false, message: "timezone must be an IANA timezone such as Asia/Ho_Chi_Minh." });
            timezoneChanged = timezone !== (farm.timezone || '');
            farm.timezone = timezone;
        }
        await farm.save();
        // The farm's CamOS cameras get the new clock (shadow tz)
        if (timezoneChanged) timezoneService.syncFarm(farm._id).catch(err => console.warn('⚠️ Farm timezone sync failed:', err.message));
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Update farm' });
    }
}

/**
 * DELETE /api/farms/:id: plots are deleted, cameras stay (unassigned), farm shares end
 */
async function deleteFarm(req, res) {
    try {
        const farm = await loadEditable(req, res);
        if (!farm) return;
        await farmService.unassignCameras({ farmId: farm._id });
        await Camera.updateMany({ 'sharedWith.viaFarm': farm._id }, { $pull: { sharedWith: { viaFarm: farm._id } } });
        await Plot.deleteMany({ farmId: farm._id });
        await Farm.deleteOne({ _id: farm._id });
        recordAudit(req, { action: 'farm.deleted', target: farmTarget(farm) });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete farm' });
    }
}

// ---------- Plots ----------

async function createPlot(req, res) {
    try {
        const farm = await loadEditable(req, res);
        if (!farm) return;
        const result = validatePlot(req.body || {});
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        if ((await Plot.countDocuments({ farmId: farm._id })) >= MAX_PLOTS_PER_FARM) {
            return res.status(400).json({ success: false, message: `A farm can have at most ${MAX_PLOTS_PER_FARM} plots.` });
        }
        const plot = await Plot.create({ ...result.value, farmId: farm._id });
        res.status(201).json({ success: true, plot: toPlot(plot) });
    } catch (err) {
        sendServerError(res, err, { context: 'Create plot' });
    }
}

async function findPlot(farm, plotId) {
    if (!mongoose.isValidObjectId(plotId)) return null;
    return Plot.findOne({ _id: plotId, farmId: farm._id });
}

async function updatePlot(req, res) {
    try {
        const farm = await loadEditable(req, res);
        if (!farm) return;
        const plot = await findPlot(farm, req.params.plotId);
        if (!plot) return res.status(404).json({ success: false, message: "Plot not found." });
        const result = validatePlot(req.body || {}, { partial: true });
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        Object.assign(plot, result.value);
        await plot.save();
        res.json({ success: true, plot: toPlot(plot) });
    } catch (err) {
        sendServerError(res, err, { context: 'Update plot' });
    }
}

async function deletePlot(req, res) {
    try {
        const farm = await loadEditable(req, res);
        if (!farm) return;
        const plot = await findPlot(farm, req.params.plotId);
        if (!plot) return res.status(404).json({ success: false, message: "Plot not found." });
        await farmService.unassignCameras({ plotId: plot._id });
        await Plot.deleteOne({ _id: plot._id });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete plot' });
    }
}

/**
 * PUT /api/farms/:id/plots/:plotId/cameras { cameraSerials }: the exact list of traps in the plot.
 * Cameras may come from another plot or farm (they move); removed ones become unassigned.
 */
async function setPlotCameras(req, res) {
    try {
        const farm = await loadEditable(req, res);
        if (!farm) return;
        const plot = await findPlot(farm, req.params.plotId);
        if (!plot) return res.status(404).json({ success: false, message: "Plot not found." });
        const serials = req.body.cameraSerials;
        if (!Array.isArray(serials) || serials.length > 200 || serials.some(s => typeof s !== 'string')) {
            return res.status(400).json({ success: false, message: "cameraSerials must be a list of camera serials." });
        }
        const unique = [...new Set(serials)];
        const filter = await farmService.assignableFilter(farm);
        const cameras = await Camera.find({ ...filter, deviceSerial: { $in: unique } }).select('deviceSerial userId farmId sharedWith selfRegistered unclaimed platform');
        if (cameras.length !== unique.length || cameras.some(c => !canManageCamera(req.user, c))) {
            return res.status(400).json({ success: false, code: 'CAMERA_NOT_FOUND', message: "Only the farm owner's cameras can be added to its plots." });
        }
        const previousFarms = [...new Set(cameras.filter(c => c.farmId).map(c => String(c.farmId)))].filter(id => id !== String(farm._id));

        await farmService.unassignCameras({ plotId: plot._id, deviceSerial: { $nin: unique } });
        await Camera.updateMany({ deviceSerial: { $in: unique } }, { $set: { farmId: farm._id, plotId: plot._id } });
        await farmService.syncFarmShares(farm);
        // CamOS cameras moved to this farm take its timezone
        for (const c of cameras.filter(c => c.platform === 'camos')) timezoneService.syncCamera(c.deviceSerial).catch(() => {});
        // Farms the cameras came from lose their shares on them
        for (const id of previousFarms) {
            const other = await Farm.findById(id);
            if (other) await farmService.syncFarmShares(other);
        }
        recordAudit(req, { action: 'farm.cameras_changed', target: farmTarget(farm), details: { plotId: String(req.params.plotId), cameras: unique } });
        res.json({ success: true, cameraSerials: unique });
    } catch (err) {
        sendServerError(res, err, { context: 'Set plot cameras' });
    }
}

// ---------- Sharing ----------

async function shareFarm(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        const farm = await loadEditable(req, res);
        if (!farm) return;
        if (!farmService.canShareFarm(req.user, farm)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only the farm owner can share it." });
        }
        if (farm.ownerId?.email?.toLowerCase() === email) {
            return res.status(400).json({ success: false, code: 'SHARE_WITH_OWNER', message: "This person already owns the farm." });
        }
        if (farm.sharedWith.some(sh => sh.email === email)) {
            return res.status(409).json({ success: false, code: 'ALREADY_SHARED', message: "The farm is already shared with this email." });
        }
        if (farm.sharedWith.length >= MAX_SHARES) {
            return res.status(400).json({ success: false, message: `A farm can be shared with at most ${MAX_SHARES} people.` });
        }
        const recipient = await findUserByEmail(email);
        // Only a confirmed address gets access right away
        const active = !!recipient?.emailVerified;
        farm.sharedWith.push({ userId: active ? recipient._id : null, email, sharedAt: new Date() });
        await farm.save();
        await farmService.syncFarmShares(farm);
        recordAudit(req, { action: 'farm.shared', target: farmTarget(farm), details: { email, invited: !active } });

        const sharer = req.user.name || req.user.email;
        const params = { farmName: farm.name };
        if (active) {
            await notificationService.notifyUser({ userId: recipient._id, type: 'farm_shared', params: { ...params, sharer, farmId: String(farm._id) } });
            queueMail(emailTemplates.shareEmail({ kind: 'farmShared', to: recipient.email, user: recipient, language: normalizeLanguage(recipient.language), sharer, params, url: safeUrl(`/farms/${farm._id}`) }));
        } else if (recipient) {
            // Has an account but has not confirmed the address yet
            queueMail(emailTemplates.shareEmail({ kind: 'farmShared', to: recipient.email, user: recipient, language: normalizeLanguage(recipient.language), sharer, params, url: safeUrl(`/farms/${farm._id}`) }));
        } else {
            queueMail(emailTemplates.shareEmail({ kind: 'farmInvite', to: email, language: normalizeLanguage(req.user.language), sharer, params, url: safeUrl('/auth/login', { mode: 'register', email }) }));
        }
        res.json({ success: true, invited: !active, shares: await withAccountStatus(sharesOf(farm)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Share farm' });
    }
}

async function unshareFarm(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        const farm = await loadEditable(req, res);
        if (!farm) return;
        if (!farmService.canShareFarm(req.user, farm)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only the farm owner can share it." });
        }
        const before = farm.sharedWith.length;
        farm.sharedWith = farm.sharedWith.filter(sh => sh.email !== email);
        if (farm.sharedWith.length === before) return res.status(404).json({ success: false, message: "This farm is not shared with that email." });
        await farm.save();
        await farmService.syncFarmShares(farm);
        recordAudit(req, { action: 'farm.unshared', target: farmTarget(farm), details: { email } });
        res.json({ success: true, shares: await withAccountStatus(sharesOf(farm)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Unshare farm' });
    }
}

/**
 * GET /api/farms/map: every visible plot with a boundary, for the map page
 */
async function mapPlots(req, res) {
    try {
        const farms = await Farm.find(farmService.farmViewFilter(req.user)).select('name').lean();
        const plots = await Plot.find({ farmId: { $in: farms.map(f => f._id) }, 'boundary.2': { $exists: true } }).lean();
        const cameras = await Camera.find({ plotId: { $in: plots.map(p => p._id) } }).select('deviceSerial plotId status alertThreshold').lean();
        const stats = await farmService.plotStats(plots, cameras);
        const statsBy = new Map(stats.map(s => [s.plotId, s]));
        const farmName = new Map(farms.map(f => [String(f._id), f.name]));
        res.json({
            success: true,
            plots: plots.map(p => ({ ...toPlot(p), farmId: String(p.farmId), farmName: farmName.get(String(p.farmId)), stats: statsBy.get(String(p._id)) }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Map plots' });
    }
}

/**
 * Pending farm invitations become access once the address is confirmed.
 */
async function claimPendingFarmShares(user) {
    const email = String(user.email || '').toLowerCase();
    if (!email) return 0;
    const farms = await Farm.find({ sharedWith: { $elemMatch: { email, userId: null } } });
    for (const farm of farms) {
        for (const sh of farm.sharedWith) if (sh.email === email && !sh.userId) sh.userId = user._id;
        await farm.save();
        await farmService.syncFarmShares(farm);
    }
    return farms.length;
}

module.exports = {
    getPlan,
    compareFarms,
    downloadSeasonReport,
    sendSeasonReport,
    listFarms,
    createFarm,
    getFarm,
    updateFarm,
    deleteFarm,
    createPlot,
    updatePlot,
    deletePlot,
    setPlotCameras,
    shareFarm,
    unshareFarm,
    mapPlots,
    claimPendingFarmShares
};
