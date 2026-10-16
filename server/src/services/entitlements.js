const env = require('../config/env');
const { isAdmin } = require('../constants/roles');

/**
 * What a workspace may use: the one place every plan limit is read from (cameras, photos a day,
 * retention, LLM deep analyses a month, live view minutes, members, features) and the demo rules
 * of self-registered cameras. Values come from the workspace's plan (Organization.plan.code, as
 * the admin configured it in Admin > Plans, services/planService.js) plus its add-on cameras. A
 * paid plan past its expiry falls back to FREE (data kept, adding blocked). The platform's
 * operators (admins, DEMO_EXEMPT_EMAILS) have no limits. Callers ask for entitlements, never for
 * roles.
 *
 * Limits are numbers; null means no limit.
 */
const UNLIMITED_FEATURES = Object.freeze({ telegram: true, pdfReports: true, apiAndWebhooks: true });

function operatorAccount(user) {
    if (!user) return false;
    return isAdmin(user) || env.DEMO_EXEMPT_EMAILS.includes(String(user.email || '').toLowerCase());
}

const unlimited = (workspaceId = null) => ({
    plan: 'unlimited',
    planName: 'Unlimited',
    workspaceId,
    exempt: true,
    expired: false,
    maxCameras: null,
    snapshotsPerDay: null,
    retentionDays: null,
    deepAnalysisPerMonth: null,
    liveMinutes: null,
    maxMembers: null,
    features: { ...UNLIMITED_FEATURES }
});

const zeroIsUnlimited = (n) => (n === 0 ? null : n);
const idOf = (value) => (value ? String(value._id || value.id || value) : null);

/** The workspace document for a view, id or document (null when none). */
async function workspaceDoc(workspace) {
    if (!workspace) return null;
    if (workspace.members && workspace.plan !== undefined && workspace._id) return workspace;
    const id = idOf(workspace);
    if (!id || !/^[a-f0-9]{24}$/i.test(id)) return null;
    const { Organization } = require('../models');
    return Organization.findById(id).lean();
}

/**
 * Entitlements of `user` in `workspace` (a document, view or id; default: user.workspace, the
 * current one). Without a workspace (b2b account outside every organization) the FREE plan
 * applies with no cameras.
 */
async function getEntitlements(user, workspace = user?.workspace, now = new Date()) {
    const ws = await workspaceDoc(workspace);
    if (operatorAccount(user)) return unlimited(ws ? String(ws._id) : null);
    const planService = require('./planService');
    const assigned = ws?.plan?.code || 'free';
    const expired = assigned !== 'free' && !!ws?.plan?.expiresAt && new Date(ws.plan.expiresAt) <= now;
    const code = expired ? 'free' : assigned;
    const plan = await planService.getPlan(code);
    const addon = expired ? 0 : Math.max(0, Number(ws?.plan?.addonCameras) || 0);
    const maxCameras = ws ? zeroIsUnlimited(plan.maxCameras) : 0;
    return {
        plan: code,
        planName: plan.name,
        assignedPlan: assigned,
        workspaceId: ws ? String(ws._id) : null,
        exempt: false,
        expired,
        expiresAt: ws?.plan?.expiresAt || null,
        addonCameras: addon,
        maxCameras: maxCameras === null ? null : maxCameras + addon,
        snapshotsPerDay: plan.snapshotsPerDay,
        retentionDays: plan.retentionDays,
        deepAnalysisPerMonth: plan.deepAnalysisPerMonth,
        liveMinutes: plan.liveMinutesPerRequest,
        maxMembers: zeroIsUnlimited(plan.maxMembers),
        features: { ...plan.features }
    };
}

/** Entitlements that apply to a camera: its workspace's plan, for its owner (admins: unlimited). */
async function entitlementsOfCamera(camera) {
    const { User, Organization } = require('../models');
    const owner = camera?.userId ? await User.findById(camera.userId).select('role email').lean() : null;
    let ws = camera?.orgId ? await Organization.findById(camera.orgId).lean() : null;
    if (!ws && owner && !operatorAccount(owner)) ws = await require('./workspaceService').ensurePersonal({ _id: camera.userId, email: owner.email });
    return getEntitlements(owner, ws);
}

const month = (now = new Date()) => now.toISOString().slice(0, 7);

/** What the workspace uses now: cameras, members, deep analyses this month. */
async function usageOf(workspace, now = new Date()) {
    const ws = await workspaceDoc(workspace);
    if (!ws) return { cameras: 0, members: 0, deepAnalyses: 0, month: month(now) };
    const { Camera, UsageCounter } = require('../models');
    const [cameras, counter] = await Promise.all([
        Camera.countDocuments({ orgId: ws._id }),
        UsageCounter.findOne({ workspaceId: ws._id, month: month(now) }).lean()
    ]);
    return {
        cameras,
        members: (ws.members || []).length,
        deepAnalyses: counter?.deepAnalyses || 0,
        month: month(now)
    };
}

/** The 403 body when a limit stops something (the client turns it into the upgrade dialog). */
const upgradeRequired = (limit, { used = null, max = null, plan = null, message = null } = {}) => ({
    status: 403,
    body: {
        success: false,
        code: 'UPGRADE_REQUIRED',
        limit,
        used,
        max,
        plan,
        message: message || `Your plan's limit is reached (${limit}). Ask for an upgrade.`
    }
});

/** May one more camera go into this workspace? Returns null (yes) or the 403 answer. */
async function checkCameraLimit(user, workspace = user?.workspace) {
    const ent = await getEntitlements(user, workspace);
    if (ent.maxCameras === null) return null;
    const used = (await usageOf(workspace)).cameras;
    if (used < ent.maxCameras) return null;
    return upgradeRequired('cameras', { used, max: ent.maxCameras, plan: ent.plan, message: `Your plan allows ${ent.maxCameras} cameras in this workspace.` });
}

/** May one more person join this workspace? */
async function checkMemberLimit(user, workspace, adding = 1) {
    const ent = await getEntitlements(user, workspace);
    if (ent.maxMembers === null) return null;
    const used = (await usageOf(workspace)).members;
    if (used + adding <= ent.maxMembers) return null;
    return upgradeRequired('members', { used, max: ent.maxMembers, plan: ent.plan, message: `Your plan allows ${ent.maxMembers} people in this workspace.` });
}

/** Is a feature (telegram, pdfReports, apiAndWebhooks) in the plan? */
async function hasFeature(user, feature, workspace = user?.workspace) {
    const ent = await getEntitlements(user, workspace);
    return !!ent.features[feature];
}

/** One more LLM deep analysis for the camera's workspace this month? Returns null or the 403 answer. */
async function checkDeepAnalysis(user, camera) {
    const ent = operatorAccount(user) ? unlimited() : await entitlementsOfCamera(camera);
    if (ent.deepAnalysisPerMonth === null) return null;
    const usage = await usageOf(ent.workspaceId);
    if (ent.deepAnalysisPerMonth > 0 && usage.deepAnalyses < ent.deepAnalysisPerMonth) return null;
    return upgradeRequired('deepAnalysis', { used: usage.deepAnalyses, max: ent.deepAnalysisPerMonth, plan: ent.plan, message: `Your plan allows ${ent.deepAnalysisPerMonth} deep analyses a month.` });
}

/** Count one LLM deep analysis for the camera's workspace. */
async function recordDeepAnalysis(camera, now = new Date()) {
    const workspaceId = camera?.orgId || (await entitlementsOfCamera(camera)).workspaceId;
    if (!workspaceId) return;
    const { UsageCounter } = require('../models');
    await UsageCounter.updateOne({ workspaceId, month: month(now) }, { $inc: { deepAnalyses: 1 } }, { upsert: true }).catch(() => {});
}

/**
 * Cameras (of `serials`) that already took their plan's snapshotsPerDay in the last 24 hours:
 * the scheduled capture skips them until a photo drops out of the window.
 */
async function overDailyLimit(serials, now = new Date()) {
    if (!serials.length) return new Set();
    const { Camera, Snapshot } = require('../models');
    const cameras = await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial userId orgId').lean();
    const counts = new Map((await Snapshot.aggregate([
        { $match: { deviceSerial: { $in: serials }, createdAt: { $gt: new Date(now.getTime() - 24 * 3600 * 1000) } } },
        { $group: { _id: '$deviceSerial', n: { $sum: 1 } } }
    ])).map(c => [c._id, c.n]));
    const cache = new Map();
    const over = new Set();
    for (const camera of cameras) {
        const key = `${camera.orgId || ''}|${camera.userId || ''}`;
        if (!cache.has(key)) cache.set(key, entitlementsOfCamera(camera));
        const { snapshotsPerDay } = await cache.get(key);
        if (snapshotsPerDay !== null && (counts.get(camera.deviceSerial) || 0) >= snapshotsPerDay) over.add(camera.deviceSerial);
    }
    return over;
}

/**
 * May this account keep integrations (webhooks, API keys) running: an operator, or the owner or
 * manager of a workspace whose plan has apiAndWebhooks. Checked when a webhook would fire.
 */
async function integrationsAllowed(userId) {
    const { User, Organization } = require('../models');
    const user = await User.findById(userId).select('role email disabled').lean();
    if (!user || user.disabled) return false;
    if (operatorAccount(user)) return true;
    const workspaces = await Organization.find({ members: { $elemMatch: { userId, role: { $in: ['owner', 'manager'] } } } }).lean();
    for (const ws of workspaces) {
        if ((await getEntitlements(user, ws)).features.apiAndWebhooks) return true;
    }
    return false;
}

/**
 * Limits that belong to the system rather than a workspace: cameras waiting to be claimed, and
 * how often an unclaimed camera may upload.
 */
function systemLimits() {
    return {
        maxUnclaimed: env.DEMO_MAX_UNCLAIMED,
        unclaimedPhotoEveryMinutes: 60,
        unclaimedPhotoTtlHours: 24,
        unclaimedCameraTtlDays: 7
    };
}

/** `asked`, capped by a limit (null = no cap). */
const capped = (asked, limit) => (limit === null || limit === undefined ? asked : Math.min(asked, limit));

/**
 * Express middleware: the current workspace may take one more camera (POST /user/add-camera).
 * Also requires owner or manager rights in that workspace.
 */
function requireCameraSlot(req, res, next) {
    const ws = req.user?.workspace;
    if (!operatorAccount(req.user) && !require('./workspaceService').canWorkIn(ws)) {
        return res.status(403).json({ success: false, code: 'NO_WORKSPACE', message: 'You cannot add cameras in this workspace.' });
    }
    checkCameraLimit(req.user, ws)
        .then((blocked) => (blocked ? res.status(blocked.status).json(blocked.body) : next()))
        .catch(next);
}

/** Express middleware: owner or manager in the current workspace (farms, dashboards). */
function requireWorkspaceRole(req, res, next) {
    if (operatorAccount(req.user) || require('./workspaceService').canWorkIn(req.user?.workspace)) return next();
    return res.status(403).json({ success: false, code: 'NO_WORKSPACE', message: 'You cannot do this in this workspace.' });
}

/** Express middleware: a plan feature (apiAndWebhooks, pdfReports, telegram) in the current workspace. */
function requireFeature(feature) {
    return (req, res, next) => {
        hasFeature(req.user, feature)
            .then((ok) => {
                if (ok) return next();
                const blocked = upgradeRequired(feature, { message: 'This is not part of your plan. Ask for an upgrade.' });
                return res.status(blocked.status).json(blocked.body);
            })
            .catch(next);
    };
}

module.exports = {
    operatorAccount,
    getEntitlements,
    entitlementsOfCamera,
    usageOf,
    upgradeRequired,
    checkCameraLimit,
    checkMemberLimit,
    hasFeature,
    checkDeepAnalysis,
    recordDeepAnalysis,
    overDailyLimit,
    integrationsAllowed,
    systemLimits,
    capped,
    requireCameraSlot,
    requireWorkspaceRole,
    requireFeature
};
