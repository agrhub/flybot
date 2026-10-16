const mongoose = require('mongoose');
const { Organization, User, Camera } = require('../models');
const workspaceService = require('../services/workspaceService');
const entitlements = require('../services/entitlements');
const planService = require('../services/planService');
const upgradeService = require('../services/upgradeService');
const { recordAudit } = require('../services/auditService');
const { sendServerError } = require('../utils/http');

/**
 * Workspaces, plans, entitlements and upgrade requests (API.md "Workspaces and plans").
 */
const send = (res, { status, body }) => res.status(status).json(body);

// ---------- The signed-in person ----------

/** GET /api/me/entitlements: the current workspace's plan limits and what it uses. */
async function getMyEntitlements(req, res) {
    try {
        const ws = req.user.workspace;
        const [ent, usage] = await Promise.all([
            entitlements.getEntitlements(req.user, ws),
            entitlements.usageOf(ws)
        ]);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, appMode: workspaceService.mode(), workspace: ws, entitlements: ent, usage });
    } catch (err) {
        sendServerError(res, err, { context: 'Entitlements' });
    }
}

/** GET /api/workspaces: the workspaces this person may switch between, and the current one. */
async function listMine(req, res) {
    try {
        const workspaces = await workspaceService.workspacesOf(req.user);
        res.json({ success: true, appMode: workspaceService.mode(), workspaces, current: req.user.workspace });
    } catch (err) {
        sendServerError(res, err, { context: 'Workspaces' });
    }
}

/** PUT /api/workspaces/current { workspaceId } */
async function setCurrent(req, res) {
    try {
        const ws = await workspaceService.setCurrent(req.user, String(req.body?.workspaceId || ''));
        if (!ws) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Workspace not found." });
        res.json({ success: true, workspace: ws });
    } catch (err) {
        sendServerError(res, err, { context: 'Switch workspace' });
    }
}

/** PUT /api/workspaces/:id/settings { allowMemberPersonalWorkspaces } (an organization's owner) */
async function updateSettings(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Workspace not found." });
        const org = await Organization.findById(req.params.id);
        const isOwner = org && (org.members || []).some(m => m.role === 'owner' && String(m.userId) === req.user.id);
        if (!org || (!isOwner && req.user.role !== 'admin')) return res.status(404).json({ success: false, message: "Workspace not found." });
        const value = req.body?.allowMemberPersonalWorkspaces;
        if (typeof value !== 'boolean') return res.status(400).json({ success: false, message: "allowMemberPersonalWorkspaces must be true or false." });
        if ((org.kind || 'organization') !== 'organization') return res.status(400).json({ success: false, message: "Only organizations have this setting." });
        org.settings = { ...(org.settings?.toObject?.() || org.settings || {}), allowMemberPersonalWorkspaces: value };
        await org.save();
        recordAudit(req, { action: 'workspace.settings_changed', target: { type: 'workspace', id: String(org._id), label: org.name }, details: { allowMemberPersonalWorkspaces: value } });
        res.json({ success: true, settings: { allowMemberPersonalWorkspaces: value } });
    } catch (err) {
        sendServerError(res, err, { context: 'Workspace settings' });
    }
}

// ---------- Plans (public) ----------

/** GET /api/plans: the visible plans for the pricing page (no sign-in), and APP_MODE. */
async function listPlans(req, res) {
    try {
        const mode = workspaceService.mode();
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, appMode: mode, pricing: mode !== 'b2b', plans: mode === 'b2b' ? [] : await planService.listPlans() });
    } catch (err) {
        sendServerError(res, err, { context: 'Plans' });
    }
}

// ---------- Upgrade requests ----------

async function createRequest(req, res) {
    try {
        const result = await upgradeService.create(req.user, req.body);
        if (result.status === 201) {
            const r = result.body.request;
            recordAudit(req, { action: 'workspace.upgrade_requested', target: { type: 'workspace', id: r.workspace?.id || '', label: r.organization?.name || '' }, details: { type: r.type, targetPlan: r.targetPlan, extraCameras: r.extraCameras, status: r.status } });
        }
        send(res, result);
    } catch (err) {
        sendServerError(res, err, { context: 'Upgrade request' });
    }
}

async function listRequests(req, res) {
    try {
        res.json({ success: true, requests: await upgradeService.listFor(req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Upgrade requests' });
    }
}

async function cancelRequest(req, res) {
    try {
        send(res, await upgradeService.cancel(req.user, req.params.id));
    } catch (err) {
        sendServerError(res, err, { context: 'Cancel upgrade request' });
    }
}

/** POST /api/upgrade-requests/:id/forward { forward: true | false, note? } (b2b organization owner) */
async function forwardRequest(req, res) {
    try {
        send(res, await upgradeService.ownerDecide(req.user, req.params.id, { forward: req.body?.forward !== false, note: req.body?.note }));
    } catch (err) {
        sendServerError(res, err, { context: 'Forward upgrade request' });
    }
}

// ---------- Admin ----------

async function adminListPlans(req, res) {
    try {
        res.json({ success: true, plans: await planService.listPlans({ all: true }) });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin plans' });
    }
}

async function adminUpdatePlan(req, res) {
    try {
        const result = await planService.updatePlan(String(req.params.code || ''), req.body, req.user);
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        recordAudit(req, { action: 'settings.updated', target: { type: 'plan', id: result.plan.code, label: result.plan.name }, details: { plan: result.plan.code } });
        res.json({ success: true, plan: result.plan });
    } catch (err) {
        sendServerError(res, err, { context: 'Update plan' });
    }
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** GET /api/admin/workspaces?q=&kind=&plan= */
async function adminListWorkspaces(req, res) {
    try {
        const filter = {};
        if (['personal', 'organization'].includes(req.query.kind)) filter.kind = req.query.kind === 'organization' ? { $in: ['organization', null] } : 'personal';
        if (['free', 'pro', 'enterprise'].includes(req.query.plan)) filter['plan.code'] = req.query.plan;
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
        if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), 'i') }, { 'members.email': new RegExp(escapeRegex(q.toLowerCase()), 'i') }];
        const docs = await Organization.find(filter).sort({ createdAt: -1 }).limit(200).lean();
        const counts = new Map((await Camera.aggregate([{ $match: { orgId: { $in: docs.map(d => d._id) } } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }])).map(c => [String(c._id), c.n]));
        res.json({
            success: true,
            workspaces: docs.map(d => ({
                id: String(d._id),
                name: d.name,
                kind: d.kind || 'organization',
                owner: (d.members || []).find(m => m.role === 'owner')?.email || null,
                members: (d.members || []).length,
                cameras: counts.get(String(d._id)) || 0,
                plan: { code: d.plan?.code || 'free', addonCameras: d.plan?.addonCameras || 0, expiresAt: d.plan?.expiresAt || null, note: d.plan?.note || '' },
                billingNote: d.billingNote || '',
                settings: { allowMemberPersonalWorkspaces: d.settings?.allowMemberPersonalWorkspaces !== false },
                createdAt: d.createdAt
            }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin workspaces' });
    }
}

/** PUT /api/admin/workspaces/:id/plan { plan, addonCameras?, expiresAt?, note?, billingNote? } */
async function adminAssignPlan(req, res) {
    try {
        const result = await upgradeService.assignPlan(req.user, req.params.id, req.body);
        if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
        const ws = result.workspace;
        recordAudit(req, { action: 'workspace.plan_changed', target: { type: 'workspace', id: String(ws._id), label: ws.name }, details: { plan: ws.plan.code, addonCameras: ws.plan.addonCameras, expiresAt: ws.plan.expiresAt ? new Date(ws.plan.expiresAt).toISOString() : '' } });
        res.json({ success: true, plan: ws.plan });
    } catch (err) {
        sendServerError(res, err, { context: 'Assign plan' });
    }
}

/** POST /api/admin/workspaces { name, ownerEmail, plan? }: a new organization (APP_MODE b2b / hybrid). */
async function adminCreateOrganization(req, res) {
    try {
        if (!workspaceService.organizationsAllowed()) return res.status(400).json({ success: false, message: "Organizations are off in this mode (APP_MODE=b2c)." });
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
        const email = typeof req.body?.ownerEmail === 'string' ? req.body.ownerEmail.trim().toLowerCase() : '';
        const plan = ['free', 'pro', 'enterprise'].includes(req.body?.plan) ? req.body.plan : 'enterprise';
        if (!name) return res.status(400).json({ success: false, message: "Please enter a name." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        const owner = await User.findOne({ email }).collation({ locale: 'en', strength: 2 }).select('_id email').lean();
        const org = await Organization.create({
            name,
            kind: 'organization',
            members: [{ userId: owner?._id || null, email, role: 'owner', addedBy: req.user.id }],
            plan: { code: plan, assignedBy: req.user.id, assignedAt: new Date() }
        });
        recordAudit(req, { action: 'workspace.created', target: { type: 'workspace', id: String(org._id), label: org.name }, details: { ownerEmail: email, plan, pending: !owner } });
        res.status(201).json({ success: true, workspace: { id: String(org._id), name: org.name, kind: 'organization', plan: org.plan.code, ownerPending: !owner } });
    } catch (err) {
        sendServerError(res, err, { context: 'Create organization' });
    }
}

async function adminListRequests(req, res) {
    try {
        const status = ['pending_owner', 'pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : null;
        res.json({ success: true, requests: await upgradeService.adminList({ status }) });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin upgrade requests' });
    }
}

async function adminApprove(req, res) {
    try {
        send(res, await upgradeService.approve(req.user, req.params.id, req.body, req));
    } catch (err) {
        sendServerError(res, err, { context: 'Approve upgrade' });
    }
}

async function adminReject(req, res) {
    try {
        send(res, await upgradeService.reject(req.user, req.params.id, req.body));
    } catch (err) {
        sendServerError(res, err, { context: 'Reject upgrade' });
    }
}

module.exports = {
    getMyEntitlements,
    listMine,
    setCurrent,
    updateSettings,
    listPlans,
    createRequest,
    listRequests,
    cancelRequest,
    forwardRequest,
    adminListPlans,
    adminUpdatePlan,
    adminListWorkspaces,
    adminAssignPlan,
    adminCreateOrganization,
    adminListRequests,
    adminApprove,
    adminReject
};
