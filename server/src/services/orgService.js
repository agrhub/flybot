const { Organization, Camera, Farm, User } = require('../models');
const { isAdmin, canAddCameras } = require('../constants/roles');

/**
 * Organizations (models/Organization.js).
 *
 * Camera access for members lives in each camera's share list as entries marked viaOrg
 * (with the member's orgRole), rebuilt by syncOrgShares whenever members or cameras change.
 * Farm access is checked from the user's organizations (attachOrgRoles puts them on req.user).
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
const MANAGING_ROLES = ['owner', 'manager'];

/** Map orgId -> role of this user in it. */
async function orgRolesOf(user) {
    const id = idOf(user);
    if (!id) return new Map();
    const orgs = await Organization.find({ 'members.userId': id }).select('members').lean();
    return new Map(orgs.map(org => [String(org._id), org.members.find(m => String(m.userId) === id)?.role || 'member']));
}

/** Express middleware: req.user.orgRoles for the farm access checks. */
async function attachOrgRoles(req, res, next) {
    try {
        if (req.user) req.user.orgRoles = await orgRolesOf(req.user);
        next();
    } catch (err) {
        next(err);
    }
}

const roleIn = (org, user) => {
    const id = idOf(user);
    return (org.members || []).find(m => m.userId && String(m.userId) === id)?.role || null;
};
const canViewOrg = (user, org) => !!org && (isAdmin(user) || !!roleIn(org, user));
// Owners and managers add/remove members and cameras (only owners touch other owners)
const canManageOrg = (user, org) => !!org && (isAdmin(user) || MANAGING_ROLES.includes(roleIn(org, user)));
const isOrgOwner = (user, org) => !!org && (isAdmin(user) || roleIn(org, user) === 'owner');

/**
 * Make the viaOrg share entries of the organization's cameras match its members.
 * Members without an account yet get access once they verify their email (claimPendingMembers).
 */
async function syncOrgShares(org) {
    const orgId = org._id;
    await Camera.updateMany(
        { orgId: { $ne: orgId }, 'sharedWith.viaOrg': orgId },
        { $pull: { sharedWith: { viaOrg: orgId } } }
    );
    const active = (org.members || []).filter(m => m.userId);
    const cameras = await Camera.find({ orgId });
    for (const camera of cameras) {
        const desired = active.filter(m => String(m.userId) !== String(camera.userId));
        const kept = (camera.sharedWith || []).filter(sh => !sh.viaOrg || String(sh.viaOrg) !== String(orgId));
        camera.sharedWith = [
            ...kept,
            ...desired.map(m => ({ userId: m.userId, email: m.email, sharedBy: m.addedBy || null, sharedAt: m.addedAt, viaOrg: orgId, orgRole: m.role }))
        ];
        await camera.save();
    }
    return cameras.length;
}

/** The organization new cameras and farms of this user go into: the first one they own. */
async function defaultOrgFor(user) {
    const id = idOf(user);
    if (!id) return null;
    const org = await Organization.findOne({ members: { $elemMatch: { userId: id, role: 'owner' } } }).sort({ createdAt: 1 }).select('_id').lean();
    return org?._id || null;
}

/**
 * Create an organization for a manager, with them as owner.
 */
async function createOrg(user, name) {
    const owner = await User.findById(idOf(user)).select('email');
    return Organization.create({
        name,
        members: [{ userId: owner._id, email: owner.email, role: 'owner', addedBy: owner._id }]
    });
}

/** Put a new camera into the user's default organization (and give its members access). */
async function adoptCamera(user, camera) {
    const orgId = await defaultOrgFor(user);
    if (!orgId) return null;
    camera.orgId = orgId;
    await camera.save();
    const org = await Organization.findById(orgId);
    if (org) await syncOrgShares(org);
    return orgId;
}

/**
 * Pending invitations for this (now verified) email become memberships.
 */
async function claimPendingMembers(user) {
    const email = String(user.email || '').toLowerCase();
    if (!email) return 0;
    const orgs = await Organization.find({ members: { $elemMatch: { email, userId: null } } });
    for (const org of orgs) {
        for (const m of org.members) if (m.email === email && !m.userId) m.userId = user._id;
        await org.save();
        await syncOrgShares(org);
    }
    return orgs.length;
}

/**
 * One organization per manager (or admin) who owns cameras or farms and is in none yet,
 * holding their cameras and farms. Run once (migrations.runOnce): later, a camera outside any
 * organization is there on purpose.
 */
async function migrateToOrganizations() {
    const owners = new Set([
        ...(await Camera.distinct('userId', { orgId: null })).filter(Boolean).map(String),
        ...(await Farm.distinct('ownerId', { orgId: null })).filter(Boolean).map(String)
    ]);
    let created = 0;
    for (const userId of owners) {
        const user = await User.findById(userId).select('email name role');
        if (!user || !canAddCameras(user)) continue;
        let orgId = await defaultOrgFor(user);
        if (!orgId) {
            const org = await createOrg(user, user.name || user.email.split('@')[0]);
            orgId = org._id;
            created++;
        }
        await Camera.updateMany({ userId: user._id, orgId: null }, { $set: { orgId } });
        await Farm.updateMany({ ownerId: user._id, orgId: null }, { $set: { orgId } });
        const org = await Organization.findById(orgId);
        if (org) await syncOrgShares(org);
    }
    if (created) console.log(`🏢 Organizations created for ${created} manager(s).`);
    return created;
}

module.exports = {
    MANAGING_ROLES,
    orgRolesOf,
    attachOrgRoles,
    roleIn,
    canViewOrg,
    canManageOrg,
    isOrgOwner,
    syncOrgShares,
    defaultOrgFor,
    createOrg,
    adoptCamera,
    claimPendingMembers,
    migrateToOrganizations
};
