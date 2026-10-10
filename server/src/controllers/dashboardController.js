const crypto = require('crypto');
const mongoose = require('mongoose');
const { Dashboard, Camera, User } = require('../models');
const { WIDGET_TYPES } = require('../models/Dashboard');
const { viewFilter } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const { normalizeLanguage } = require('../utils/i18n');
const { queueMail } = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const notificationService = require('../services/notificationService');
const dashboardService = require('../services/dashboardService');
const { recordAudit } = require('../services/auditService');
const { SNAPSHOT_KEY_REGEX, pipeSnapshot } = require('./s3Controller');
const { EMAIL_REGEX, normalizeEmail, findUserByEmail, safeUrl } = require('./shareController');

const MAX_DASHBOARDS_PER_OWNER = 50;
const MAX_CAMERAS = 50;
const MAX_WIDGETS = 20;
const MAX_SHARES = 50;
const WIDGET_ID_REGEX = /^[A-Za-z0-9_-]{1,40}$/;

const NOT_FOUND = { success: false, message: "Dashboard not found." };
const newPublicToken = () => crypto.randomBytes(18).toString('base64url');
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const dashboardTarget = (dashboard) => ({ type: 'dashboard', id: String(dashboard._id), label: dashboard.name });
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function sharesOf(dashboard) {
    return (dashboard.sharedWith || []).map(sh => ({
        email: sh.email,
        userId: sh.userId ? String(sh.userId) : null,
        status: sh.userId ? 'active' : 'pending',
        sharedAt: sh.sharedAt
    }));
}

function ownerOf(dashboard) {
    const owner = dashboard.ownerId;
    return owner && owner.email
        ? { id: String(owner._id), email: owner.email, name: owner.name || owner.email.split('@')[0] }
        : { id: String(owner), email: '', name: '' };
}

function toSummary(dashboard, user) {
    return {
        id: String(dashboard._id),
        name: dashboard.name,
        description: dashboard.description,
        visibility: dashboard.visibility,
        owner: ownerOf(dashboard),
        access: dashboardService.accessOf(user, dashboard),
        canEdit: dashboardService.canEditDashboard(user, dashboard),
        cameraCount: (dashboard.cameraSerials || []).length,
        widgetCount: (dashboard.widgets || []).length,
        updatedAt: dashboard.updatedAt
    };
}

function toDetail(dashboard, user) {
    const detail = {
        ...toSummary(dashboard, user),
        cameraSerials: dashboard.cameraSerials,
        widgets: (dashboard.widgets || []).map(w => ({
            id: w.id,
            type: w.type,
            title: w.title,
            cameraSerials: w.cameraSerials,
            rangeDays: w.rangeDays,
            layout: { x: w.layout?.x ?? 0, y: w.layout?.y ?? 0, w: w.layout?.w ?? 12, h: w.layout?.h ?? 4 }
        }))
    };
    // Share list and public link only for people who can change them
    if (detail.canEdit) {
        detail.sharedWith = sharesOf(dashboard);
        detail.publicToken = dashboard.visibility === 'public' ? dashboard.publicToken : null;
    }
    return detail;
}

async function findDashboard(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    return Dashboard.findById(id).populate('ownerId', 'email name role disabled');
}

/**
 * Validate a create/update body against the editor's cameras.
 * Returns { value } or { error, code?, cameras? }.
 */
async function validateInput(body, { editor, owner, partial = false, current = null }) {
    const value = {};

    if (!partial || body.name !== undefined) {
        const name = text(body.name, 80);
        if (!name) return { error: "Please enter a dashboard name." };
        value.name = name;
    }
    if (body.description !== undefined) {
        if (typeof body.description !== 'string' || body.description.length > 500) return { error: "Description must be at most 500 characters." };
        value.description = body.description.trim();
    }

    if (!partial || body.cameraSerials !== undefined) {
        const serials = body.cameraSerials ?? [];
        if (!Array.isArray(serials) || serials.some(s => typeof s !== 'string')) return { error: "cameraSerials must be a list of camera serials." };
        const unique = [...new Set(serials.map(s => s.trim()).filter(Boolean))];
        if (unique.length > MAX_CAMERAS) return { error: `A dashboard can use at most ${MAX_CAMERAS} cameras.` };
        // The editor must be able to see every camera they put on the dashboard
        const visible = unique.length
            ? await Camera.find({ deviceSerial: { $in: unique }, ...viewFilter(editor) }).select('deviceSerial')
            : [];
        const visibleSet = new Set(visible.map(c => c.deviceSerial));
        const missing = unique.filter(s => !visibleSet.has(s));
        if (missing.length) return { error: "Some cameras were not found.", code: 'CAMERA_NOT_FOUND', cameras: missing };
        value.cameraSerials = unique;
    }
    const cameraSet = new Set(value.cameraSerials ?? current?.cameraSerials ?? []);

    if (!partial || body.widgets !== undefined) {
        const widgets = body.widgets ?? [];
        if (!Array.isArray(widgets) || widgets.length > MAX_WIDGETS) return { error: `A dashboard can have at most ${MAX_WIDGETS} widgets.` };
        const ids = new Set();
        value.widgets = [];
        for (const w of widgets) {
            if (!w || typeof w !== 'object') return { error: "Invalid widget." };
            if (typeof w.id !== 'string' || !WIDGET_ID_REGEX.test(w.id) || ids.has(w.id)) return { error: "Each widget needs a unique id." };
            if (!WIDGET_TYPES.includes(w.type)) return { error: `Widget type must be one of ${WIDGET_TYPES.join(', ')}.` };
            const serials = w.cameraSerials ?? [];
            if (!Array.isArray(serials) || serials.some(s => typeof s !== 'string' || !cameraSet.has(s))) {
                return { error: "Widget cameras must be cameras of the dashboard." };
            }
            const rangeDays = w.rangeDays ?? 7;
            if (!isInt(rangeDays, 1, 365)) return { error: "rangeDays must be between 1 and 365." };
            const layout = { x: 0, y: 0, w: 12, h: 4, ...(w.layout || {}) };
            if (!isInt(layout.x, 0, 23) || !isInt(layout.y, 0, 1000) || !isInt(layout.w, 1, 24) || !isInt(layout.h, 1, 20) || layout.x + layout.w > 24) {
                return { error: "Invalid widget layout." };
            }
            ids.add(w.id);
            value.widgets.push({
                id: w.id,
                type: w.type,
                title: text(w.title, 80),
                cameraSerials: [...new Set(serials)],
                rangeDays,
                layout: { x: layout.x, y: layout.y, w: layout.w, h: layout.h }
            });
        }
    }

    if (body.visibility !== undefined) {
        if (!['private', 'public'].includes(body.visibility)) return { error: "visibility must be private or public." };
        value.visibility = body.visibility;
    }

    // A public link may only show the owner's own cameras (an admin owner: any camera)
    const visibility = value.visibility ?? current?.visibility ?? 'private';
    if (visibility === 'public') {
        const serials = [...cameraSet];
        const publishable = new Set(await dashboardService.ownerPublishableSerials(owner, serials));
        const foreign = serials.filter(s => !publishable.has(s));
        if (foreign.length) {
            return {
                error: "A public dashboard can only include cameras you own.",
                code: 'PUBLIC_FOREIGN_CAMERA',
                cameras: foreign
            };
        }
    }
    return { value };
}

const sendValidationError = (res, result) =>
    res.status(400).json({ success: false, message: result.error, ...(result.code ? { code: result.code } : {}), ...(result.cameras ? { cameras: result.cameras } : {}) });

/**
 * GET /api/dashboards: dashboards I own or that are shared with me (admins: all)
 */
async function listDashboards(req, res) {
    try {
        const dashboards = await Dashboard.find(dashboardService.dashboardViewFilter(req.user))
            .populate('ownerId', 'email name')
            .sort({ updatedAt: -1 })
            .limit(500);
        res.json({ success: true, dashboards: dashboards.map(d => toSummary(d, req.user)) });
    } catch (err) {
        sendServerError(res, err, { context: 'List dashboards' });
    }
}

/**
 * POST /api/dashboards (admin, manager)
 */
async function createDashboard(req, res) {
    try {
        const count = await Dashboard.countDocuments({ ownerId: req.user.id });
        if (count >= MAX_DASHBOARDS_PER_OWNER) {
            return res.status(400).json({ success: false, message: `You can have at most ${MAX_DASHBOARDS_PER_OWNER} dashboards.` });
        }
        const owner = await User.findById(req.user.id).select('role disabled');
        const result = await validateInput(req.body || {}, { editor: req.user, owner });
        if (result.error) return sendValidationError(res, result);

        const dashboard = new Dashboard({ ...result.value, ownerId: req.user.id });
        if (dashboard.visibility === 'public') dashboard.publicToken = newPublicToken();
        await dashboard.save();
        recordAudit(req, { action: 'dashboard.created', target: dashboardTarget(dashboard), details: { visibility: dashboard.visibility } });
        if (dashboard.visibility === 'public') recordAudit(req, { action: 'dashboard.published', target: dashboardTarget(dashboard) });
        await dashboard.populate('ownerId', 'email name role disabled');
        res.status(201).json({ success: true, dashboard: toDetail(dashboard, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Create dashboard' });
    }
}

/**
 * GET /api/dashboards/:id
 */
async function getDashboard(req, res) {
    try {
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);

        // Names of the cameras this viewer gets data for (for legends and pickers)
        const serials = await dashboardService.effectiveSerials(dashboard, req.user);
        const cameras = serials.length
            ? await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName status')
            : [];
        res.json({
            success: true,
            dashboard: toDetail(dashboard, req.user),
            cameras: cameras.map(c => ({ deviceSerial: c.deviceSerial, deviceName: c.deviceName, status: c.status }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Get dashboard' });
    }
}

/**
 * PUT /api/dashboards/:id  (partial update)
 */
async function updateDashboard(req, res) {
    try {
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        if (!dashboardService.canEditDashboard(req.user, dashboard)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot edit this dashboard." });
        }

        const result = await validateInput(req.body || {}, { editor: req.user, owner: dashboard.ownerId, partial: true, current: dashboard });
        if (result.error) return sendValidationError(res, result);

        const wasPublic = dashboard.visibility === 'public';
        Object.assign(dashboard, result.value);
        if (dashboard.visibility === 'public' && !dashboard.publicToken) dashboard.publicToken = newPublicToken();
        // Going private kills the old link
        if (dashboard.visibility === 'private') dashboard.publicToken = undefined;
        await dashboard.save();
        const isPublic = dashboard.visibility === 'public';
        if (isPublic !== wasPublic) {
            recordAudit(req, { action: isPublic ? 'dashboard.published' : 'dashboard.unpublished', target: dashboardTarget(dashboard) });
        }
        res.json({ success: true, dashboard: toDetail(dashboard, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Update dashboard' });
    }
}

/**
 * DELETE /api/dashboards/:id
 */
async function deleteDashboard(req, res) {
    try {
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        if (!dashboardService.canEditDashboard(req.user, dashboard)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot delete this dashboard." });
        }
        await Dashboard.deleteOne({ _id: dashboard._id });
        recordAudit(req, { action: 'dashboard.deleted', target: dashboardTarget(dashboard), details: { owner: dashboard.ownerId?.email || '' } });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete dashboard' });
    }
}

/**
 * GET /api/dashboards/:id/data: data for every widget
 */
async function getDashboardData(req, res) {
    try {
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        const serials = await dashboardService.effectiveSerials(dashboard, req.user);
        const widgets = await dashboardService.computeWidgetData(dashboard, serials, {
            imageUrl: (key) => `/api/s3/${key}`
        });
        res.json({ success: true, generatedAt: new Date(), widgets });
    } catch (err) {
        sendServerError(res, err, { context: 'Dashboard data' });
    }
}

/**
 * POST /api/dashboards/:id/public-token: new public link (the old one stops working)
 */
async function rotatePublicToken(req, res) {
    try {
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        if (!dashboardService.canEditDashboard(req.user, dashboard)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot edit this dashboard." });
        }
        if (dashboard.visibility !== 'public') {
            return res.status(400).json({ success: false, message: "The dashboard is not public." });
        }
        dashboard.publicToken = newPublicToken();
        await dashboard.save();
        recordAudit(req, { action: 'dashboard.link_rotated', target: dashboardTarget(dashboard) });
        res.json({ success: true, publicToken: dashboard.publicToken });
    } catch (err) {
        sendServerError(res, err, { context: 'Rotate dashboard link' });
    }
}

/**
 * POST /api/dashboards/:id/share { email }
 */
async function shareDashboard(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        if (!dashboardService.canEditDashboard(req.user, dashboard)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot share this dashboard." });
        }
        if (dashboard.ownerId.email?.toLowerCase() === email) {
            return res.status(400).json({ success: false, code: 'SHARE_WITH_OWNER', message: "This person already owns the dashboard." });
        }
        if (dashboard.sharedWith.some(sh => sh.email === email)) {
            return res.status(409).json({ success: false, code: 'ALREADY_SHARED', message: "The dashboard is already shared with this email." });
        }
        if (dashboard.sharedWith.length >= MAX_SHARES) {
            return res.status(400).json({ success: false, message: `A dashboard can be shared with at most ${MAX_SHARES} people.` });
        }

        const recipient = await findUserByEmail(email);
        dashboard.sharedWith.push({ userId: recipient?._id || null, email, sharedAt: new Date() });
        await dashboard.save();
        recordAudit(req, { action: 'dashboard.shared', target: dashboardTarget(dashboard), details: { email, invited: !recipient } });

        const sharer = req.user.name || req.user.email;
        const params = { dashboardName: dashboard.name };
        if (recipient) {
            await notificationService.notifyUser({
                userId: recipient._id,
                type: 'dashboard_shared',
                params: { ...params, sharer, dashboardId: String(dashboard._id) }
            });
            queueMail(emailTemplates.shareEmail({
                kind: 'dashboardShared',
                to: recipient.email,
                user: recipient,
                language: normalizeLanguage(recipient.language),
                sharer,
                params,
                url: safeUrl(`/dashboards/${dashboard._id}`)
            }));
        } else {
            queueMail(emailTemplates.shareEmail({
                kind: 'dashboardInvite',
                to: email,
                language: normalizeLanguage(req.user.language),
                sharer,
                params,
                url: safeUrl('/auth/login', { mode: 'register', email })
            }));
        }
        res.json({ success: true, invited: !recipient, shares: sharesOf(dashboard) });
    } catch (err) {
        sendServerError(res, err, { context: 'Share dashboard' });
    }
}

/**
 * DELETE /api/dashboards/:id/share { email }
 */
async function unshareDashboard(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        if (!dashboardService.canEditDashboard(req.user, dashboard)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot share this dashboard." });
        }
        const before = dashboard.sharedWith.length;
        dashboard.sharedWith = dashboard.sharedWith.filter(sh => sh.email !== email);
        if (dashboard.sharedWith.length === before) {
            return res.status(404).json({ success: false, message: "This dashboard is not shared with that email." });
        }
        await dashboard.save();
        recordAudit(req, { action: 'dashboard.unshared', target: dashboardTarget(dashboard), details: { email } });
        res.json({ success: true, shares: sharesOf(dashboard) });
    } catch (err) {
        sendServerError(res, err, { context: 'Unshare dashboard' });
    }
}

// --- Public link (no sign-in) ----------------------------------------------

const TOKEN_REGEX = /^[A-Za-z0-9_-]{16,64}$/;

async function findPublicDashboard(token) {
    if (typeof token !== 'string' || !TOKEN_REGEX.test(token)) return null;
    const dashboard = await Dashboard.findOne({ publicToken: token, visibility: 'public' }).populate('ownerId', 'name email role disabled');
    // A disabled or deleted owner takes their public dashboards offline
    if (!dashboard || !dashboard.ownerId?.email || dashboard.ownerId.disabled) return null;
    return dashboard;
}

/**
 * GET /api/public/dashboards/:token: dashboard layout and data, read-only
 */
async function getPublicDashboard(req, res) {
    try {
        const dashboard = await findPublicDashboard(req.params.token);
        if (!dashboard) return res.status(404).json(NOT_FOUND);
        const serials = await dashboardService.effectiveSerials(dashboard, null);
        const base = `/api/public/dashboards/${encodeURIComponent(req.params.token)}/images/`;
        const [widgets, cameras] = await Promise.all([
            dashboardService.computeWidgetData(dashboard, serials, { imageUrl: (key) => base + key }),
            serials.length ? Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName status') : []
        ]);
        const owner = dashboard.ownerId;
        res.json({
            success: true,
            generatedAt: new Date(),
            dashboard: {
                name: dashboard.name,
                description: dashboard.description,
                // Display name only: no email on a public page
                ownerName: owner.name || '',
                updatedAt: dashboard.updatedAt,
                widgets: toDetail(dashboard, { id: null, role: 'user' }).widgets
            },
            cameras: cameras.map(c => ({ deviceSerial: c.deviceSerial, deviceName: c.deviceName, status: c.status })),
            widgets
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Public dashboard' });
    }
}

/**
 * GET /api/public/dashboards/:token/images/*key: snapshot image of a camera on that public dashboard
 */
async function streamPublicImage(req, res) {
    try {
        const key = Array.isArray(req.params.key) ? req.params.key.join('/') : String(req.params.key || '');
        const match = key.match(SNAPSHOT_KEY_REGEX);
        const dashboard = match ? await findPublicDashboard(req.params.token) : null;
        const serials = dashboard ? await dashboardService.effectiveSerials(dashboard, null) : [];
        if (!match || !serials.includes(match[1])) {
            return res.status(404).json({ success: false, message: "File not found" });
        }
        return pipeSnapshot(res, key, { cacheControl: 'private, max-age=3600' });
    } catch (err) {
        sendServerError(res, err, { context: 'Public dashboard image' });
    }
}

/**
 * Turn pending dashboard invitations for this (now verified) email into access.
 */
async function claimPendingDashboardShares(user) {
    const email = String(user.email || '').toLowerCase();
    if (!email) return 0;
    const result = await Dashboard.updateMany(
        { sharedWith: { $elemMatch: { email, userId: null } } },
        { $set: { 'sharedWith.$[invite].userId': user._id } },
        { arrayFilters: [{ 'invite.email': email, 'invite.userId': null }] }
    );
    return result.modifiedCount || 0;
}

module.exports = {
    listDashboards,
    createDashboard,
    getDashboard,
    updateDashboard,
    deleteDashboard,
    getDashboardData,
    rotatePublicToken,
    shareDashboard,
    unshareDashboard,
    getPublicDashboard,
    streamPublicImage,
    claimPendingDashboardShares
};
