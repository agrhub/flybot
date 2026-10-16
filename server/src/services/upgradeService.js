const mongoose = require('mongoose');
const { UpgradeRequest, Organization, User } = require('../models');
const workspaceService = require('./workspaceService');
const { isAdmin } = require('../constants/roles');

/**
 * Upgrade requests (models/UpgradeRequest.js): a person asks for a bigger plan or more cameras
 * for their workspace, or (APP_MODE hybrid) for a new organization; the admin approves (plan,
 * add-on cameras, expiry, paid) or rejects with a note. Payment is manual. In APP_MODE b2b a
 * member's request goes to the organization's owner first (pending_owner), who forwards it.
 * Admins get an in-app notification (and email / Telegram as their settings say); the requester
 * hears back the same way.
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
const PLANS = ['free', 'pro', 'enterprise'];
const fail = (status, code, message) => ({ status, body: { success: false, code, message } });
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function view(r, { admin = false } = {}) {
    const ws = r.workspaceId && typeof r.workspaceId === 'object' && r.workspaceId._id ? r.workspaceId : null;
    const by = r.requestedBy && typeof r.requestedBy === 'object' && r.requestedBy._id ? r.requestedBy : null;
    return {
        id: String(r._id),
        type: r.type,
        status: r.status,
        targetPlan: r.targetPlan,
        extraCameras: r.extraCameras || 0,
        message: r.message || '',
        reason: r.reason || '',
        organization: r.type === 'organization' ? { name: r.organization?.name || '', cameras: r.organization?.cameras ?? null, members: r.organization?.members ?? null, phone: admin ? (r.organization?.phone || '') : undefined } : null,
        workspace: ws ? { id: String(ws._id), name: ws.name, kind: ws.kind || 'organization', plan: ws.plan?.code || 'free' } : (r.workspaceId ? { id: String(r.workspaceId) } : null),
        requestedBy: by ? { id: String(by._id), email: by.email, name: by.name || by.email } : { id: String(r.requestedBy) },
        adminNote: r.adminNote || '',
        paid: admin ? !!r.paid : undefined,
        granted: r.granted?.plan ? { plan: r.granted.plan, addonCameras: r.granted.addonCameras ?? 0, expiresAt: r.granted.expiresAt || null, workspaceId: r.granted.workspaceId ? String(r.granted.workspaceId) : null } : null,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt || null
    };
}

async function notifyAdmins(request, requester) {
    const notificationService = require('./notificationService');
    const admins = await User.find({ role: 'admin', disabled: { $ne: true } }).select('_id').lean();
    for (const a of admins) {
        await notificationService.notifyUser({
            userId: a._id,
            type: 'upgrade_requested',
            params: {
                email: requester?.email || '',
                plan: (request.type === 'organization' ? 'organization' : request.targetPlan).toUpperCase(),
                workspace: request.type === 'organization' ? (request.organization?.name || '') : (request.workspaceName || '')
            }
        }).catch(err => console.warn('⚠️ Upgrade notice not sent:', err.message));
    }
}

async function notifyRequester(request, approved) {
    const userId = request.requestedBy?._id || request.requestedBy;
    const person = await User.findById(userId).select('language').lean();
    const { translate } = require('../utils/i18n');
    const outcome = translate(person?.language, `email.alerts.upgrade_outcome.${approved ? 'approved' : 'rejected'}`);
    await require('./notificationService').notifyUser({
        userId,
        type: 'upgrade_decided',
        params: {
            plan: String(request.granted?.plan || request.targetPlan || '').toUpperCase(),
            outcome,
            approved,
            note: request.adminNote || ''
        }
    }).catch(err => console.warn('⚠️ Upgrade answer not sent:', err.message));
}

/**
 * POST /api/upgrade-requests { type?: plan | organization, targetPlan?, extraCameras?, message?, reason?,
 *   organization?: { name, cameras, members, phone } } by the signed-in `user` for their current
 * workspace. Returns { status, body }.
 */
async function create(user, body) {
    const b = body && typeof body === 'object' ? body : {};
    const type = b.type === 'organization' ? 'organization' : 'plan';
    const mode = workspaceService.mode();
    const ws = user?.workspace || null;
    const doc = { requestedBy: idOf(user), type, message: text(b.message, 1000), reason: text(b.reason, 60) };

    if (type === 'organization') {
        if (mode !== 'hybrid') return fail(400, 'NOT_AVAILABLE', 'Organizations are not requested here.');
        const name = text(b.organization?.name, 120);
        if (!name) return fail(400, 'BAD_REQUEST', 'organization.name is required.');
        doc.organization = {
            name,
            cameras: int(b.organization?.cameras, 0, 100000) ?? undefined,
            members: int(b.organization?.members, 0, 100000) ?? undefined,
            phone: text(b.organization?.phone, 40) || undefined
        };
        doc.targetPlan = PLANS.includes(b.targetPlan) ? b.targetPlan : 'enterprise';
        doc.status = 'pending';
    } else {
        if (!ws) return fail(400, 'NO_WORKSPACE', 'You have no workspace to upgrade.');
        if (!PLANS.includes(b.targetPlan || 'pro')) return fail(400, 'BAD_REQUEST', 'targetPlan must be free, pro or enterprise.');
        doc.targetPlan = b.targetPlan || 'pro';
        doc.extraCameras = int(b.extraCameras ?? 0, 0, 10000);
        if (doc.extraCameras === null) return fail(400, 'BAD_REQUEST', 'extraCameras must be a whole number from 0 to 10000.');
        doc.workspaceId = ws.id;
        const leads = ['owner', 'manager'].includes(ws.role);
        // b2b: a member asks the organization's owner first
        if (!leads && mode !== 'b2b') return fail(403, 'FORBIDDEN', 'Only the workspace owner or a manager can ask for an upgrade.');
        doc.status = mode === 'b2b' && ws.role !== 'owner' ? 'pending_owner' : 'pending';
    }
    const open = await UpgradeRequest.exists({ requestedBy: doc.requestedBy, type, ...(doc.workspaceId ? { workspaceId: doc.workspaceId } : {}), status: { $in: ['pending_owner', 'pending'] } });
    if (open) return fail(409, 'ALREADY_PENDING', 'You already have a request waiting.');

    const request = await UpgradeRequest.create(doc);
    const requester = await User.findById(doc.requestedBy).select('email name').lean();
    if (request.status === 'pending') await notifyAdmins({ ...request.toObject(), workspaceName: ws?.name }, requester);
    else await notifyOwners(request, ws, requester);
    return { status: 201, body: { success: true, request: view(request.toObject()) } };
}

async function notifyOwners(request, ws, requester) {
    const org = ws ? await Organization.findById(ws.id).select('members name').lean() : null;
    const owners = (org?.members || []).filter(m => m.role === 'owner' && m.userId);
    for (const o of owners) {
        await require('./notificationService').notifyUser({
            userId: o.userId,
            type: 'upgrade_requested',
            params: { email: requester?.email || '', plan: String(request.targetPlan).toUpperCase(), workspace: org.name }
        }).catch(() => {});
    }
}

/** GET /api/upgrade-requests: the person's own, and (owner of a b2b organization) those waiting for them. */
async function listFor(user) {
    const id = idOf(user);
    const ownedOrgs = (await Organization.find({ members: { $elemMatch: { userId: id, role: 'owner' } } }).select('_id').lean()).map(o => o._id);
    const docs = await UpgradeRequest.find({ $or: [{ requestedBy: id }, { workspaceId: { $in: ownedOrgs }, status: 'pending_owner' }] })
        .sort({ createdAt: -1 }).limit(50).populate('workspaceId', 'name kind plan').populate('requestedBy', 'email name').lean();
    return docs.map(d => view(d));
}

/** The b2b organization owner passes a member's request on to the admin (or turns it down). */
async function ownerDecide(user, id, { forward, note }) {
    if (!mongoose.isValidObjectId(id)) return fail(404, 'NOT_FOUND', 'Request not found.');
    const request = await UpgradeRequest.findById(id);
    if (!request || request.status !== 'pending_owner') return fail(404, 'NOT_FOUND', 'Request not found.');
    const org = await Organization.findById(request.workspaceId).select('members name').lean();
    const isOwner = (org?.members || []).some(m => m.role === 'owner' && String(m.userId) === idOf(user));
    if (!isOwner && !isAdmin(user)) return fail(404, 'NOT_FOUND', 'Request not found.');
    if (forward) {
        request.status = 'pending';
        request.forwardedBy = idOf(user);
        await request.save();
        const requester = await User.findById(request.requestedBy).select('email').lean();
        await notifyAdmins({ ...request.toObject(), workspaceName: org?.name }, requester);
    } else {
        request.status = 'rejected';
        request.adminNote = text(note, 1000);
        request.decidedBy = idOf(user);
        request.decidedAt = new Date();
        await request.save();
        await notifyRequester(request, false);
    }
    return { status: 200, body: { success: true, request: view(request.toObject()) } };
}

/** DELETE-like: the requester withdraws a waiting request. */
async function cancel(user, id) {
    if (!mongoose.isValidObjectId(id)) return fail(404, 'NOT_FOUND', 'Request not found.');
    const request = await UpgradeRequest.findOneAndUpdate({ _id: id, requestedBy: idOf(user), status: { $in: ['pending_owner', 'pending', 'awaiting_payment'] } }, { $set: { status: 'cancelled' } }, { new: true }).lean();
    if (!request) return fail(404, 'NOT_FOUND', 'Request not found.');
    return { status: 200, body: { success: true, request: view(request) } };
}

// ---------- Admin ----------

async function adminList({ status = null, limit = 100 } = {}) {
    const filter = status ? { status } : {};
    const docs = await UpgradeRequest.find(filter).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 500))
        .populate('workspaceId', 'name kind plan').populate('requestedBy', 'email name').lean();
    return docs.map(d => view(d, { admin: true }));
}

const parseExpiry = (v) => {
    if (v === null || v === '' || v === undefined) return null;
    const d = new Date(v);
    return isNaN(d) ? undefined : d;
};

/**
 * Set a workspace's plan (admin): { plan, addonCameras?, expiresAt?, note? }. Returns the new
 * plan block or { error }.
 */
async function assignPlan(admin, workspaceId, body) {
    if (!mongoose.isValidObjectId(workspaceId)) return { error: 'Workspace not found.', status: 404 };
    const b = body && typeof body === 'object' ? body : {};
    if (!PLANS.includes(b.plan)) return { error: 'plan must be free, pro or enterprise.', status: 400 };
    const addon = b.addonCameras === undefined ? 0 : int(b.addonCameras, 0, 100000);
    if (addon === null) return { error: 'addonCameras must be a whole number from 0 to 100000.', status: 400 };
    const expiresAt = parseExpiry(b.expiresAt);
    if (expiresAt === undefined) return { error: 'expiresAt must be a date.', status: 400 };
    const plan = { code: b.plan, addonCameras: addon, expiresAt, assignedBy: idOf(admin), assignedAt: new Date(), note: text(b.note, 500) };
    const set = { plan };
    if (b.billingNote !== undefined) set.billingNote = text(b.billingNote, 1000);
    const ws = await Organization.findByIdAndUpdate(workspaceId, { $set: set }, { new: true }).lean();
    if (!ws) return { error: 'Workspace not found.', status: 404 };
    return { workspace: ws };
}

/**
 * Approve: { plan?, addonCameras?, expiresAt?, paid?, adminNote? }. A plan request sets its
 * workspace's plan; an organization request makes the organization with the requester as owner.
 */
async function approve(admin, id, body, req = null) {
    if (!mongoose.isValidObjectId(id)) return fail(404, 'NOT_FOUND', 'Request not found.');
    const b = body && typeof body === 'object' ? body : {};
    const request = await UpgradeRequest.findById(id);
    if (!request || request.status !== 'pending') return fail(404, 'NOT_FOUND', 'Request not found or not waiting.');
    const plan = PLANS.includes(b.plan) ? b.plan : request.targetPlan;
    const addonCameras = b.addonCameras === undefined ? (request.extraCameras || 0) : int(b.addonCameras, 0, 100000);
    if (addonCameras === null) return fail(400, 'BAD_REQUEST', 'addonCameras must be a whole number from 0 to 100000.');
    const expiresAt = parseExpiry(b.expiresAt);
    if (expiresAt === undefined) return fail(400, 'BAD_REQUEST', 'expiresAt must be a date.');

    // Pay online: the plan starts when the owner's payment arrives (services/billingService.js)
    if (b.payOnline === true) {
        if (request.type !== 'plan' || plan === 'free') return fail(400, 'BAD_REQUEST', 'Only a paid plan for a workspace can be paid online.');
        if (!require('./payments/config').paymentsEnabled()) return fail(400, 'PAYMENTS_OFF', 'Online payment is not available. Ask for an upgrade instead.');
        const prices = (await require('./planService').getPlan(plan)).prices;
        if (!Object.values(prices).some(p => p.month || p.year)) return fail(400, 'NOT_FOR_SALE', 'This plan has no online price. Set one in Admin, Plans.');
        request.status = 'awaiting_payment';
        request.adminNote = text(b.adminNote, 1000);
        request.decidedBy = idOf(admin);
        request.decidedAt = new Date();
        request.granted = { plan, addonCameras, workspaceId: request.workspaceId };
        await request.save();
        await notifyRequester(request, true);
        return { status: 200, body: { success: true, request: view(request.toObject(), { admin: true }) } };
    }

    let workspaceId = request.workspaceId;
    if (request.type === 'organization') {
        const requester = await User.findById(request.requestedBy).select('email');
        if (!requester) return fail(409, 'CONFLICT', 'The requester is gone.');
        const org = await Organization.create({
            name: request.organization?.name || 'Organization',
            kind: 'organization',
            members: [{ userId: requester._id, email: requester.email, role: 'owner', addedBy: idOf(admin) }],
            plan: { code: plan, addonCameras, expiresAt, assignedBy: idOf(admin), assignedAt: new Date(), note: text(b.adminNote, 500) }
        });
        workspaceId = org._id;
    } else {
        const result = await assignPlan(admin, workspaceId, { plan, addonCameras, expiresAt, note: text(b.adminNote, 500) });
        if (result.error) return fail(result.status || 400, 'BAD_REQUEST', result.error);
    }
    request.status = 'approved';
    request.adminNote = text(b.adminNote, 1000);
    request.paid = b.paid === true;
    request.decidedBy = idOf(admin);
    request.decidedAt = new Date();
    request.granted = { plan, addonCameras, expiresAt: expiresAt || undefined, workspaceId };
    await request.save();
    await notifyRequester(request, true);
    if (req) {
        require('./auditService').recordAudit(req, { action: 'workspace.plan_changed', target: { type: 'workspace', id: String(workspaceId), label: request.organization?.name || '' }, details: { plan, addonCameras, expiresAt, requestId: String(request._id), paid: request.paid } });
    }
    return { status: 200, body: { success: true, request: view(request.toObject(), { admin: true }) } };
}

async function reject(admin, id, body) {
    if (!mongoose.isValidObjectId(id)) return fail(404, 'NOT_FOUND', 'Request not found.');
    const request = await UpgradeRequest.findOne({ _id: id, status: { $in: ['pending', 'pending_owner'] } });
    if (!request) return fail(404, 'NOT_FOUND', 'Request not found or not waiting.');
    request.status = 'rejected';
    request.adminNote = text(body?.adminNote, 1000);
    request.decidedBy = idOf(admin);
    request.decidedAt = new Date();
    await request.save();
    await notifyRequester(request, false);
    return { status: 200, body: { success: true, request: view(request.toObject(), { admin: true }) } };
}

module.exports = {
    view,
    create,
    listFor,
    ownerDecide,
    cancel,
    adminList,
    assignPlan,
    approve,
    reject
};
