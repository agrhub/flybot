const mongoose = require('mongoose');
const { Organization, Camera, Farm, User } = require('../models');
const { ORG_ROLES } = require('../models/Organization');
const { isCameraOwner } = require('../utils/ownership');
const { isAdmin } = require('../constants/roles');
const { sendServerError } = require('../utils/http');
const { normalizeLanguage } = require('../utils/i18n');
const { recordAudit } = require('../services/auditService');
const mailService = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const notificationService = require('../services/notificationService');
const orgService = require('../services/orgService');
const { EMAIL_REGEX, normalizeEmail, findUserByEmail, safeUrl } = require('./shareController');

const MAX_ORGS_PER_USER = 20;
const MAX_MEMBERS = 200;
const MAX_CAMERAS_PER_REQUEST = 200;
const NOT_FOUND = { success: false, message: "Organization not found." };

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const orgTarget = (org) => ({ type: 'organization', id: String(org._id), label: org.name });

/**
 * Of the invited emails, those that already have an account (not yet confirmed: a confirmed
 * account is linked when invited or when it confirms).
 */
async function emailsWithAccount(emails) {
    if (!emails.length) return new Set();
    const users = await User.find({ email: { $in: emails } })
        .collation({ locale: 'en', strength: 2 }).select('email').lean();
    return new Set(users.map(u => String(u.email).toLowerCase()));
}

async function toClientOrg(org, user) {
    const invited = org.members.filter(m => !m.userId).map(m => m.email);
    const [cameras, farms, withAccount] = await Promise.all([
        Camera.find({ orgId: org._id }).select('deviceSerial deviceName status userId').lean(),
        Farm.countDocuments({ orgId: org._id }),
        emailsWithAccount(invited)
    ]);
    return {
        id: String(org._id),
        name: org.name,
        myRole: orgService.roleIn(org, user),
        canManage: orgService.canManageOrg(user, org),
        members: org.members.map(m => ({
            email: m.email,
            userId: m.userId ? String(m.userId) : null,
            role: m.role,
            // pending: no account yet; unverified: account exists, email not confirmed
            status: m.userId ? 'active' : (withAccount.has(String(m.email).toLowerCase()) ? 'unverified' : 'pending'),
            addedAt: m.addedAt
        })),
        cameras: cameras.map(c => ({ deviceSerial: c.deviceSerial, deviceName: c.deviceName, status: c.status })),
        farmCount: farms,
        createdAt: org.createdAt
    };
}

async function loadOrg(req, res, { manage = false } = {}) {
    const org = mongoose.isValidObjectId(req.params.id) ? await Organization.findById(req.params.id) : null;
    if (!orgService.canViewOrg(req.user, org)) {
        res.status(404).json(NOT_FOUND);
        return null;
    }
    if (manage && !orgService.canManageOrg(req.user, org)) {
        res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only owners and managers of the organization can do this." });
        return null;
    }
    return org;
}

/**
 * GET /api/orgs: organizations I belong to (admin: all)
 */
async function listOrgs(req, res) {
    try {
        const filter = isAdmin(req.user) ? {} : { 'members.userId': req.user.id };
        const orgs = await Organization.find(filter).sort({ name: 1 });
        res.json({ success: true, organizations: await Promise.all(orgs.map(o => toClientOrg(o, req.user))) });
    } catch (err) {
        sendServerError(res, err, { context: 'List organizations' });
    }
}

/**
 * POST /api/orgs { name }: managers and admins; the creator becomes owner
 */
async function createOrg(req, res) {
    try {
        const name = text(req.body.name, 100);
        if (!name) return res.status(400).json({ success: false, message: "Please enter a name." });
        const owned = await Organization.countDocuments({ members: { $elemMatch: { userId: req.user.id, role: 'owner' } } });
        if (owned >= MAX_ORGS_PER_USER) {
            return res.status(400).json({ success: false, message: `You can own at most ${MAX_ORGS_PER_USER} organizations.` });
        }
        const org = await orgService.createOrg(req.user, name);
        recordAudit(req, { action: 'org.created', target: orgTarget(org) });
        res.status(201).json({ success: true, organization: await toClientOrg(org, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Create organization' });
    }
}

/**
 * PUT /api/orgs/:id { name }: owners
 */
async function updateOrg(req, res) {
    try {
        const org = await loadOrg(req, res);
        if (!org) return;
        if (!orgService.isOrgOwner(req.user, org)) return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only owners can rename the organization." });
        const name = text(req.body.name, 100);
        if (!name) return res.status(400).json({ success: false, message: "Please enter a name." });
        org.name = name;
        await org.save();
        recordAudit(req, { action: 'org.updated', target: orgTarget(org) });
        res.json({ success: true, organization: await toClientOrg(org, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Update organization' });
    }
}

/**
 * DELETE /api/orgs/:id: owners. Cameras and farms stay with their owners, outside any organization.
 */
async function deleteOrg(req, res) {
    try {
        const org = await loadOrg(req, res);
        if (!org) return;
        if (!orgService.isOrgOwner(req.user, org)) return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only owners can delete the organization." });
        await Promise.all([
            Camera.updateMany({ orgId: org._id }, { $set: { orgId: null } }),
            Farm.updateMany({ orgId: org._id }, { $set: { orgId: null } })
        ]);
        await Camera.updateMany({ 'sharedWith.viaOrg': org._id }, { $pull: { sharedWith: { viaOrg: org._id } } });
        await org.deleteOne();
        recordAudit(req, { action: 'org.deleted', target: orgTarget(org) });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete organization' });
    }
}

const validRole = (role) => ORG_ROLES.includes(role);
const ownerCount = (org) => org.members.filter(m => m.role === 'owner').length;

/**
 * POST /api/orgs/:id/members { email, role }: owners and managers (only owners add owners)
 */
async function addMember(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        const role = req.body.role || 'member';
        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        if (!validRole(role)) return res.status(400).json({ success: false, message: "Invalid role." });
        const org = await loadOrg(req, res, { manage: true });
        if (!org) return;
        if (role === 'owner' && !orgService.isOrgOwner(req.user, org)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only owners can add owners." });
        }
        if (org.members.some(m => m.email === email)) {
            return res.status(409).json({ success: false, code: 'ALREADY_MEMBER', message: "This email is already a member." });
        }
        if (org.members.length >= MAX_MEMBERS) {
            return res.status(400).json({ success: false, message: `An organization can have at most ${MAX_MEMBERS} members.` });
        }
        const recipient = await findUserByEmail(email);
        // Only a confirmed address gets access right away
        const active = !!recipient?.emailVerified;
        org.members.push({ userId: active ? recipient._id : null, email, role, addedBy: req.user.id, addedAt: new Date() });
        await org.save();
        await orgService.syncOrgShares(org);
        recordAudit(req, { action: 'org.member_added', target: orgTarget(org), details: { email, role, invited: !active } });

        const sharer = req.user.name || req.user.email;
        const params = { orgName: org.name };
        if (active) {
            await notificationService.notifyUser({ userId: recipient._id, type: 'org_joined', params: { ...params, sharer } });
        }
        if (recipient) {
            mailService.queueMail(emailTemplates.shareEmail({ kind: 'orgShared', to: recipient.email, user: recipient, language: normalizeLanguage(recipient.language), sharer, params, url: safeUrl('/settings', { tab: 'organizations' }) }));
        } else {
            mailService.queueMail(emailTemplates.shareEmail({ kind: 'orgInvite', to: email, language: normalizeLanguage(req.user.language), sharer, params, url: safeUrl('/auth/login', { mode: 'register', email }) }));
        }
        res.json({ success: true, invited: !active, organization: await toClientOrg(org, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Add organization member' });
    }
}

/**
 * PUT /api/orgs/:id/members { email, role } and DELETE /api/orgs/:id/members { email }
 * Managers change members only; owners change anyone. The last owner stays.
 * Anyone may leave (delete themselves), except the last owner.
 */
async function changeMember(req, res, remove) {
    try {
        const email = normalizeEmail(req.body.email);
        const org = await loadOrg(req, res);
        if (!org) return;
        const member = org.members.find(m => m.email === email);
        if (!member) return res.status(404).json({ success: false, message: "This email is not a member." });

        const self = member.userId && String(member.userId) === String(req.user.id);
        const isOwner = orgService.isOrgOwner(req.user, org);
        const allowed = (remove && self) || isOwner || (orgService.canManageOrg(req.user, org) && member.role === 'member');
        if (!allowed) return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You cannot change this member." });

        if (!remove) {
            const role = req.body.role;
            if (!validRole(role)) return res.status(400).json({ success: false, message: "Invalid role." });
            if (role !== 'member' && !isOwner) return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only owners can give this role." });
            if (member.role === 'owner' && role !== 'owner' && ownerCount(org) === 1) {
                return res.status(400).json({ success: false, code: 'LAST_OWNER', message: "An organization needs at least one owner." });
            }
            member.role = role;
        } else {
            if (member.role === 'owner' && ownerCount(org) === 1) {
                return res.status(400).json({ success: false, code: 'LAST_OWNER', message: "An organization needs at least one owner." });
            }
            org.members = org.members.filter(m => m.email !== email);
        }
        await org.save();
        await orgService.syncOrgShares(org);
        recordAudit(req, { action: remove ? 'org.member_removed' : 'org.member_updated', target: orgTarget(org), details: { email, role: member.role } });
        res.json({ success: true, organization: await toClientOrg(org, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Change organization member' });
    }
}

/**
 * PUT /api/orgs/:id/cameras { add: [serial], remove: [serial] }: owners and managers,
 * for cameras they manage. A camera belongs to at most one organization.
 */
async function setCameras(req, res) {
    try {
        const list = (v) => (Array.isArray(v) ? [...new Set(v.filter(s => typeof s === 'string'))] : []);
        const add = list(req.body.add);
        const remove = list(req.body.remove);
        if (add.length + remove.length > MAX_CAMERAS_PER_REQUEST) {
            return res.status(400).json({ success: false, message: `At most ${MAX_CAMERAS_PER_REQUEST} cameras at a time.` });
        }
        const org = await loadOrg(req, res, { manage: true });
        if (!org) return;
        const cameras = await Camera.find({ deviceSerial: { $in: [...add, ...remove] } });
        // Only the camera's owner (or an admin) moves it, so an organization manager cannot take it
        if (cameras.length !== add.length + remove.length || cameras.some(c => !isCameraOwner(req.user, c))) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "You can only move cameras you own." });
        }
        if (cameras.some(c => remove.includes(c.deviceSerial) && String(c.orgId) !== String(org._id))) {
            return res.status(400).json({ success: false, message: "A camera to remove is not in this organization." });
        }
        const previousOrgs = new Set(cameras.filter(c => add.includes(c.deviceSerial) && c.orgId).map(c => String(c.orgId)));
        await Camera.updateMany({ deviceSerial: { $in: add } }, { $set: { orgId: org._id } });
        await Camera.updateMany({ deviceSerial: { $in: remove } }, { $set: { orgId: null } });
        await orgService.syncOrgShares(org);
        // Cameras that moved here lose the old organization's members
        for (const id of previousOrgs) {
            if (id === String(org._id)) continue;
            const old = await Organization.findById(id);
            if (old) await orgService.syncOrgShares(old);
        }
        recordAudit(req, { action: 'org.cameras_changed', target: orgTarget(org), details: { add, remove } });
        res.json({ success: true, organization: await toClientOrg(org, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Organization cameras' });
    }
}

module.exports = {
    listOrgs,
    createOrg,
    updateOrg,
    deleteOrg,
    addMember,
    updateMember: (req, res) => changeMember(req, res, false),
    removeMember: (req, res) => changeMember(req, res, true),
    setCameras
};
