const env = require('../config/env');
const { Organization, User } = require('../models');

/**
 * Workspaces (models/Organization.js): every account's personal workspace and the
 * organizations it belongs to. The current workspace (the X-Workspace-Id header, else the
 * account's currentWorkspaceId, else the personal one, else the first) scopes cameras, farms,
 * dashboards, entitlements and usage. APP_MODE decides which kinds exist:
 *   b2c    personal workspaces only (organizations stay out of the switcher)
 *   b2b    organizations only (no personal workspaces are made)
 *   hybrid both (default)
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
const mode = () => env.APP_MODE;
const personalAllowed = () => mode() !== 'b2b';
const organizationsAllowed = () => mode() !== 'b2c';

const view = (org, userId) => {
    const role = (org.members || []).find(m => m.userId && String(m.userId) === userId)?.role || null;
    return {
        id: String(org._id),
        name: org.name,
        kind: org.kind || 'organization',
        role,
        plan: org.plan?.code || 'free'
    };
};

/** The account's personal workspace (made on first use in b2c / hybrid), or null. */
async function ensurePersonal(user) {
    const id = idOf(user);
    if (!id || !personalAllowed()) return null;
    const existing = await Organization.findOne({ kind: 'personal', members: { $elemMatch: { userId: id, role: 'owner' } } });
    if (existing) return existing;
    const account = user.email ? user : await User.findById(id).select('email name');
    if (!account) return null;
    const name = (account.name || String(account.email || '').split('@')[0] || 'Personal').slice(0, 80);
    return Organization.create({
        name,
        kind: 'personal',
        members: [{ userId: id, email: String(account.email || '').toLowerCase(), role: 'owner', addedBy: id }],
        plan: { code: 'free' }
    });
}

/**
 * The workspaces the account may switch between (as documents), personal first. A member of an
 * organization whose owner turned allowMemberPersonalWorkspaces off does not see their personal one.
 */
async function workspaceDocsOf(user, { create = true } = {}) {
    const id = idOf(user);
    if (!id) return [];
    if (create) await ensurePersonal(user);
    const docs = await Organization.find({ 'members.userId': id }).sort({ createdAt: 1 });
    const orgs = docs.filter(d => (d.kind || 'organization') === 'organization');
    const hidePersonal = orgs.some(o => o.settings?.allowMemberPersonalWorkspaces === false
        && (o.members || []).some(m => m.userId && String(m.userId) === id && m.role !== 'owner'));
    const personal = docs.filter(d => d.kind === 'personal' && !hidePersonal && personalAllowed());
    return [...personal, ...(organizationsAllowed() ? orgs : [])];
}

async function workspacesOf(user, opts) {
    const id = idOf(user);
    return (await workspaceDocsOf(user, opts)).map(d => view(d, id));
}

/** The current workspace document for the account (or null), from a requested id or the saved one. */
async function currentOf(user, requestedId = null, docs = null) {
    const list = docs || await workspaceDocsOf(user);
    if (!list.length) return null;
    const pick = (wanted) => wanted && list.find(d => String(d._id) === String(wanted));
    return pick(requestedId) || pick(user.currentWorkspaceId) || list.find(d => d.kind === 'personal') || list[0];
}

/**
 * Called by middlewares/auth.js authenticate: req.user.workspace ({ id, name, kind, role, plan }),
 * req.user.workspaceCount and req.user.workspaceIds. Never fails the request.
 */
async function attach(req, userDoc) {
    try {
        const docs = await workspaceDocsOf(userDoc);
        const requested = String(req.get?.('X-Workspace-Id') || '').trim();
        const current = await currentOf(userDoc, /^[a-f0-9]{24}$/i.test(requested) ? requested : null, docs);
        req.user.workspace = current ? view(current, idOf(userDoc)) : null;
        req.user.workspaceCount = docs.length;
        req.user.workspaceIds = docs.map(d => String(d._id));
    } catch (err) {
        console.warn('⚠️ Workspace not resolved:', err.message);
        req.user.workspace = null;
        req.user.workspaceCount = 0;
        req.user.workspaceIds = [];
    }
}

/** PUT /api/workspaces/current: remember the account's current workspace. Returns the view or null. */
async function setCurrent(user, workspaceId) {
    const docs = await workspaceDocsOf(user);
    const doc = docs.find(d => String(d._id) === String(workspaceId));
    if (!doc) return null;
    await User.updateOne({ _id: idOf(user) }, { $set: { currentWorkspaceId: doc._id } });
    return view(doc, idOf(user));
}

/** May this account add cameras / farms / dashboards in this workspace (its owner or a manager)? */
const canWorkIn = (workspace) => !!workspace && ['owner', 'manager'].includes(workspace.role);

/**
 * The extra filter that keeps a list to the current workspace (added only when the account has
 * more than one workspace, so a one-workspace account sees exactly what it saw before).
 * `ownerField`: the owner id field of the collection (userId for cameras, ownerId for farms and
 * dashboards); `directShares`: items shared with the person outside any organization show in
 * their personal workspace.
 */
function scopeFilter(user, { ownerField = 'userId', directShares = true } = {}) {
    const ws = user?.workspace;
    if (!ws || !(user.workspaceCount > 1)) return null;
    const id = idOf(user);
    if (ws.kind === 'personal') {
        return {
            $or: [
                { orgId: ws.id },
                { orgId: null, [ownerField]: id },
                ...(directShares ? [{ sharedWith: { $elemMatch: { userId: id, viaOrg: null } } }] : [])
            ]
        };
    }
    return { orgId: ws.id };
}

module.exports = {
    viewOf: view,
    mode,
    personalAllowed,
    organizationsAllowed,
    ensurePersonal,
    workspaceDocsOf,
    workspacesOf,
    currentOf,
    attach,
    setCurrent,
    canWorkIn,
    scopeFilter
};
