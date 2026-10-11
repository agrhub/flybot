const crypto = require('crypto');
const mongoose = require('mongoose');
const { Dashboard, Camera, User } = require('../models');
const { WIDGET_TYPES, GRANULARITIES, CAMERA_STATUSES, RISK_FILTERS, SCHEDULE_FREQUENCIES, SCHEDULE_RECIPIENTS } = require('../models/Dashboard');
const reportScheduleService = require('../services/reportScheduleService');
const { viewFilter } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const { normalizeLanguage } = require('../utils/i18n');
const { queueMail } = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const notificationService = require('../services/notificationService');
const dashboardService = require('../services/dashboardService');
const { recordAudit } = require('../services/auditService');
const { createTtlCache } = require('../utils/ttlCache');
const { createLimiter } = require('../utils/concurrency');
const { SNAPSHOT_KEY_REGEX, pipeSnapshot } = require('./s3Controller');
const { EMAIL_REGEX, normalizeEmail, findUserByEmail, safeUrl } = require('./shareController');

const MAX_DASHBOARDS_PER_OWNER = 50;
const MAX_CAMERAS = 50;
const MAX_WIDGETS = 20;
const MAX_SHARES = 50;
const WIDGET_ID_REGEX = /^[A-Za-z0-9_-]{1,40}$/;
// Sharing can end at most this far ahead
const MAX_EXPIRY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const NOT_FOUND = { success: false, message: "Report not found." };
const newPublicToken = () => crypto.randomBytes(18).toString('base64url');
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const dashboardTarget = (dashboard) => ({ type: 'dashboard', id: String(dashboard._id), label: dashboard.name });
const scheduleKey = (sc) => (sc ? [sc.frequency || 'off', sc.weekday, sc.monthDay, sc.hour, sc.recipients].join('|') : 'off');
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
        expiresAt: dashboard.expiresAt || null,
        expired: dashboardService.isExpired(dashboard),
        updatedAt: dashboard.updatedAt
    };
}

// The saved default range, as the client sends it back
const rangeOf = (dashboard) => {
    const { preset = '7d', from, to } = dashboard.range || {};
    return preset === 'custom' ? { preset, from, to } : { preset };
};

function toDetail(dashboard, user) {
    const detail = {
        ...toSummary(dashboard, user),
        cameraSerials: dashboard.cameraSerials,
        range: rangeOf(dashboard),
        widgets: (dashboard.widgets || []).map(w => ({
            id: w.id,
            type: w.type,
            title: w.title,
            cameraSerials: w.cameraSerials,
            range: w.range?.preset ? (w.range.preset === 'custom' ? { preset: 'custom', from: w.range.from, to: w.range.to } : { preset: w.range.preset }) : null,
            granularity: w.granularity || 'auto',
            status: w.status || 'all',
            risk: w.risk || 'all',
            layout: { x: w.layout?.x ?? 0, y: w.layout?.y ?? 0, w: w.layout?.w ?? 12, h: w.layout?.h ?? 4 }
        }))
    };
    // Share list and public link only for people who can change them
    if (detail.canEdit) {
        const sc = dashboard.schedule || {};
        detail.schedule = {
            frequency: sc.frequency || 'off',
            weekday: sc.weekday ?? 1,
            monthDay: sc.monthDay ?? 1,
            hour: sc.hour ?? 7,
            recipients: sc.recipients || 'owner',
            lastSentAt: sc.lastSentAt || null
        };
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
        if (!name) return { error: "Please enter a report name." };
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
        if (unique.length > MAX_CAMERAS) return { error: `A report can use at most ${MAX_CAMERAS} cameras.` };
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
        if (!Array.isArray(widgets) || widgets.length > MAX_WIDGETS) return { error: `A report can have at most ${MAX_WIDGETS} widgets.` };
        const ids = new Set();
        value.widgets = [];
        for (const w of widgets) {
            if (!w || typeof w !== 'object') return { error: "Invalid widget." };
            if (typeof w.id !== 'string' || !WIDGET_ID_REGEX.test(w.id) || ids.has(w.id)) return { error: "Each widget needs a unique id." };
            if (!WIDGET_TYPES.includes(w.type)) return { error: `Widget type must be one of ${WIDGET_TYPES.join(', ')}.` };
            const serials = w.cameraSerials ?? [];
            if (!Array.isArray(serials) || serials.some(s => typeof s !== 'string' || !cameraSet.has(s))) {
                return { error: "Widget cameras must be cameras of the report." };
            }
            const layout = { x: 0, y: 0, w: 12, h: 4, ...(w.layout || {}) };
            if (!isInt(layout.x, 0, 23) || !isInt(layout.y, 0, 1000) || !isInt(layout.w, 1, 24) || !isInt(layout.h, 1, 20) || layout.x + layout.w > 24) {
                return { error: "Invalid widget layout." };
            }
            // The widget's own filters (all optional)
            let range;
            if (w.range) {
                const parsed = dashboardService.parseRange(w.range);
                if (parsed.error) return { error: parsed.error };
                range = parsed.range;
            }
            const granularity = w.granularity ?? 'auto';
            const status = w.status ?? 'all';
            const risk = w.risk ?? 'all';
            if (!GRANULARITIES.includes(granularity) || !CAMERA_STATUSES.includes(status) || !RISK_FILTERS.includes(risk)) {
                return { error: "Invalid widget filter." };
            }
            ids.add(w.id);
            value.widgets.push({
                id: w.id,
                type: w.type,
                title: text(w.title, 80),
                cameraSerials: [...new Set(serials)],
                range,
                granularity,
                status,
                risk,
                layout: { x: layout.x, y: layout.y, w: layout.w, h: layout.h }
            });
        }
    }

    if (body.visibility !== undefined) {
        if (!['private', 'public'].includes(body.visibility)) return { error: "visibility must be private or public." };
        value.visibility = body.visibility;
    }

    if (body.range !== undefined) {
        const parsed = dashboardService.parseRange(body.range);
        if (parsed.error) return { error: parsed.error };
        value.range = parsed.range;
    }

    if (body.schedule !== undefined) {
        const sc = body.schedule;
        const frequency = sc?.frequency ?? 'off';
        const weekday = sc?.weekday ?? 1;
        const monthDay = sc?.monthDay ?? 1;
        const hour = sc?.hour ?? 7;
        const recipients = sc?.recipients ?? 'owner';
        if (!sc || typeof sc !== 'object' || !SCHEDULE_FREQUENCIES.includes(frequency) || !SCHEDULE_RECIPIENTS.includes(recipients)
            || !isInt(weekday, 1, 7) || !isInt(monthDay, 1, 28) || !isInt(hour, 0, 23)) {
            return { error: "Invalid report schedule." };
        }
        value.schedule = { frequency, weekday, monthDay, hour, recipients };
    }

    if (body.expiresAt !== undefined) {
        if (body.expiresAt === null) {
            value.expiresAt = null;
        } else {
            const at = typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : null;
            if (!at || Number.isNaN(at.getTime())) return { error: "Invalid expiry date." };
            const unchanged = current?.expiresAt && new Date(current.expiresAt).getTime() === at.getTime();
            if (!unchanged && at.getTime() <= Date.now()) return { error: "The expiry date must be in the future." };
            if (at.getTime() > Date.now() + MAX_EXPIRY_MS) return { error: "The expiry date can be at most 5 years ahead." };
            value.expiresAt = at;
        }
    }

    // A public link may only show the owner's own cameras (an admin owner: any camera)
    const visibility = value.visibility ?? current?.visibility ?? 'private';
    if (visibility === 'public') {
        const serials = [...cameraSet];
        const publishable = new Set(await dashboardService.ownerPublishableSerials(owner, serials));
        const foreign = serials.filter(s => !publishable.has(s));
        if (foreign.length) {
            return {
                error: "A public report can only include cameras you own.",
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
            return res.status(400).json({ success: false, message: `You can have at most ${MAX_DASHBOARDS_PER_OWNER} reports.` });
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
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot edit this report." });
        }

        const result = await validateInput(req.body || {}, { editor: req.user, owner: dashboard.ownerId, partial: true, current: dashboard });
        if (result.error) return sendValidationError(res, result);

        const wasPublic = dashboard.visibility === 'public';
        const previousExpiry = dashboard.expiresAt ? new Date(dashboard.expiresAt).getTime() : null;
        const previousSchedule = scheduleKey(dashboard.schedule);
        const scheduleChanged = !!result.value.schedule && scheduleKey(result.value.schedule) !== previousSchedule;
        // A changed schedule starts from now: no email for a moment already past
        if (result.value.schedule) {
            result.value.schedule = { ...result.value.schedule, lastSentAt: scheduleChanged ? new Date() : dashboard.schedule?.lastSentAt ?? null };
        }
        Object.assign(dashboard, result.value);
        // Cameras taken off the report also leave its widgets
        if (result.value.cameraSerials && result.value.widgets === undefined) {
            const kept = new Set(result.value.cameraSerials);
            for (const widget of dashboard.widgets) widget.cameraSerials = (widget.cameraSerials || []).filter(serial => kept.has(serial));
        }
        if (dashboard.visibility === 'public' && !dashboard.publicToken) dashboard.publicToken = newPublicToken();
        // Going private kills the old link
        if (dashboard.visibility === 'private') dashboard.publicToken = undefined;
        await dashboard.save();
        const isPublic = dashboard.visibility === 'public';
        if (isPublic !== wasPublic) {
            recordAudit(req, { action: isPublic ? 'dashboard.published' : 'dashboard.unpublished', target: dashboardTarget(dashboard) });
        }
        if (scheduleChanged) {
            recordAudit(req, { action: 'dashboard.schedule_changed', target: dashboardTarget(dashboard), details: { frequency: dashboard.schedule.frequency, recipients: dashboard.schedule.recipients } });
        }
        const expiry = dashboard.expiresAt ? new Date(dashboard.expiresAt).getTime() : null;
        if (expiry !== previousExpiry) {
            recordAudit(req, { action: 'dashboard.expiry_changed', target: dashboardTarget(dashboard), details: { expiresAt: dashboard.expiresAt || null } });
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
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot delete this report." });
        }
        await Dashboard.deleteOne({ _id: dashboard._id });
        recordAudit(req, { action: 'dashboard.deleted', target: dashboardTarget(dashboard), details: { owner: dashboard.ownerId?.email || '' } });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete dashboard' });
    }
}

// ?range=30d, or ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD; none = the report's own range
function rangeFromQuery(query) {
    if (!query?.range) return { range: null };
    return dashboardService.parseRange({ preset: String(query.range), from: query.from, to: query.to });
}

/**
 * GET /api/dashboards/:id/data: data for every widget
 */
async function getDashboardData(req, res) {
    try {
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        const wanted = rangeFromQuery(req.query);
        if (wanted.error) return res.status(400).json({ success: false, message: wanted.error });
        const serials = await dashboardService.effectiveSerials(dashboard, req.user);
        const { range, widgets } = await dashboardService.computeWidgetData(dashboard, serials, {
            imageUrl: (key) => `/api/dashboards/${dashboard._id}/images/${key}`,
            range: wanted.range
        });
        res.json({ success: true, generatedAt: new Date(), range, widgets });
    } catch (err) {
        sendServerError(res, err, { context: 'Dashboard data' });
    }
}

/**
 * POST /api/dashboards/:id/send { range? }: email me the report with its PDF now
 */
async function sendDashboardNow(req, res) {
    try {
        const dashboard = await findDashboard(req.params.id);
        if (!dashboardService.canViewDashboard(req.user, dashboard)) return res.status(404).json(NOT_FOUND);
        const wanted = req.body?.range ? dashboardService.parseRange(req.body.range) : { range: null };
        if (wanted.error) return res.status(400).json({ success: false, message: wanted.error });
        const user = await User.findById(req.user.id).select('email name language role disabled emailVerified');
        if (!user?.emailVerified) {
            return res.status(400).json({ success: false, message: "Confirm your email address first." });
        }
        await reportScheduleService.sendReportTo(dashboard, user, { range: wanted.range });
        res.json({ success: true, email: user.email });
    } catch (err) {
        sendServerError(res, err, { context: 'Send report' });
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
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot edit this report." });
        }
        if (dashboard.visibility !== 'public') {
            return res.status(400).json({ success: false, message: "The report is not public." });
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
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot share this report." });
        }
        if (dashboard.ownerId.email?.toLowerCase() === email) {
            return res.status(400).json({ success: false, code: 'SHARE_WITH_OWNER', message: "This person already owns the report." });
        }
        if (dashboard.sharedWith.some(sh => sh.email === email)) {
            return res.status(409).json({ success: false, code: 'ALREADY_SHARED', message: "The report is already shared with this email." });
        }
        if (dashboard.sharedWith.length >= MAX_SHARES) {
            return res.status(400).json({ success: false, message: `A report can be shared with at most ${MAX_SHARES} people.` });
        }

        const recipient = await findUserByEmail(email);
        // Same rule as cameras: only a confirmed address gets access right away
        const active = !!recipient?.emailVerified;
        dashboard.sharedWith.push({ userId: active ? recipient._id : null, email, sharedAt: new Date() });
        await dashboard.save();
        recordAudit(req, { action: 'dashboard.shared', target: dashboardTarget(dashboard), details: { email, invited: !active } });

        const sharer = req.user.name || req.user.email;
        const params = { dashboardName: dashboard.name };
        if (active) {
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
                url: safeUrl(`/reports/${dashboard._id}`)
            }));
        } else if (recipient) {
            queueMail(emailTemplates.shareEmail({
                kind: 'dashboardShared',
                to: recipient.email,
                user: recipient,
                language: normalizeLanguage(recipient.language),
                sharer,
                params,
                url: safeUrl(`/reports/${dashboard._id}`)
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
        res.json({ success: true, invited: !active, shares: sharesOf(dashboard) });
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
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot share this report." });
        }
        const before = dashboard.sharedWith.length;
        dashboard.sharedWith = dashboard.sharedWith.filter(sh => sh.email !== email);
        if (dashboard.sharedWith.length === before) {
            return res.status(404).json({ success: false, message: "This report is not shared with that email." });
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
// Public pages can be opened by many people at once: compute each dashboard at most once a minute.
// Keyed by updatedAt, so an edit shows up immediately.
const publicDataCache = createTtlCache({ ttlMs: 60 * 1000, maxEntries: 200 });
// Anyone with a link can ask for any range: compute a few public reports at a time
const publicCompute = createLimiter(2, { maxQueue: 20 });

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
        if (dashboardService.isExpired(dashboard)) {
            return res.status(410).json({ success: false, code: 'EXPIRED', message: "This report link has expired." });
        }
        const wanted = rangeFromQuery(req.query);
        if (wanted.error) return res.status(400).json({ success: false, message: wanted.error });
        const rangeKey = wanted.range ? `${wanted.range.preset}:${wanted.range.from || ''}:${wanted.range.to || ''}` : 'default';
        const cacheKey = `${dashboard._id}:${dashboard.publicToken}:${new Date(dashboard.updatedAt).getTime()}:${rangeKey}`;
        const { widgets, range, cameras, generatedAt } = await publicDataCache.wrap(cacheKey, () => publicCompute(async () => {
            const serials = await dashboardService.effectiveSerials(dashboard, null);
            const base = `/api/public/dashboards/${encodeURIComponent(req.params.token)}/images/`;
            const [computed, cameraDocs] = await Promise.all([
                dashboardService.computeWidgetData(dashboard, serials, { imageUrl: (key) => base + key, range: wanted.range }),
                serials.length ? Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName status').lean() : []
            ]);
            return { ...computed, cameras: cameraDocs, generatedAt: new Date() };
        }));
        const owner = dashboard.ownerId;
        res.json({
            success: true,
            generatedAt,
            dashboard: {
                name: dashboard.name,
                description: dashboard.description,
                // Display name only: no email on a public page
                ownerName: owner.name || '',
                updatedAt: dashboard.updatedAt,
                expiresAt: dashboard.expiresAt || null,
                range: rangeOf(dashboard),
                widgets: toDetail(dashboard, { id: null, role: 'user' }).widgets
            },
            range,
            cameras: cameras.map(c => ({ deviceSerial: c.deviceSerial, deviceName: c.deviceName, status: c.status })),
            widgets
        });
    } catch (err) {
        if (err.code === 'BUSY') return res.status(429).json({ success: false, message: "Too many requests. Please try again in a moment." });
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
        const found = match ? await findPublicDashboard(req.params.token) : null;
        const dashboard = found && !dashboardService.isExpired(found) ? found : null;
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
 * GET /api/dashboards/:id/images/*key: snapshot of a camera on a report this person may view.
 * A shared viewer sees the owner's cameras through the report, not through the camera itself.
 */
async function streamDashboardImage(req, res) {
    try {
        const key = Array.isArray(req.params.key) ? req.params.key.join('/') : String(req.params.key || '');
        const match = key.match(SNAPSHOT_KEY_REGEX);
        const dashboard = match ? await findDashboard(req.params.id) : null;
        const serials = dashboardService.canViewDashboard(req.user, dashboard) ? await dashboardService.effectiveSerials(dashboard, req.user) : [];
        if (!match || !serials.includes(match[1])) {
            return res.status(404).json({ success: false, message: "File not found" });
        }
        return pipeSnapshot(res, key, { cacheControl: 'private, max-age=3600' });
    } catch (err) {
        sendServerError(res, err, { context: 'Dashboard image' });
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
    streamDashboardImage,
    sendDashboardNow,
    claimPendingDashboardShares
};
