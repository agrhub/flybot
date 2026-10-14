const mongoose = require('mongoose');
const { Organization, Camera, Farm } = require('../models');
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
const { orgOverview } = require('../services/orgOverviewService');
const { remindMembers } = require('../services/orgReminderService');
const { inviteQuota } = require('../middlewares/rateLimit');
const { avatarUrlsFor } = require('../services/avatarService');
const { EMAIL_REGEX, normalizeEmail, findUserByEmail, safeUrl, emailsWithAccount, sendConfirmReminder } = require('./shareController');

const MAX_ORGS_PER_USER = 20;
const MAX_MEMBERS = 200;
const MAX_CAMERAS_PER_REQUEST = 200;
const NOT_FOUND = { success: false, message: "Organization not found." };

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const orgTarget = (org) => ({ type: 'organization', id: String(org._id), label: org.name });

async function toClientOrg(org, user) {
    const invited = org.members.filter(m => !m.userId).map(m => m.email);
    const [cameras, farms, withAccount, avatars] = await Promise.all([
        Camera.find({ orgId: org._id }).select('deviceSerial deviceName status userId').lean(),
        Farm.countDocuments({ orgId: org._id }),
        emailsWithAccount(invited),
        avatarUrlsFor(org.members.map(m => m.userId))
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
            addedAt: m.addedAt,
            avatar: (m.userId && avatars.get(String(m.userId))) || ''
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

const MAX_BULK = 50;

/**
 * POST /api/orgs/:id/members/bulk { emails: [..] or "a@x, b@y", role }: invite many people at
 * once (a cooperative's growers). One result per address: added (access now), invited (no
 * confirmed account yet), already, invalid, full (member limit) or limit (daily invitations).
 */
async function addMembersBulk(req, res) {
    try {
        const role = req.body.role || 'member';
        if (!validRole(role)) return res.status(400).json({ success: false, message: "Invalid role." });
        const raw = Array.isArray(req.body.emails) ? req.body.emails
            : typeof req.body.emails === 'string' ? req.body.emails.split(/[\s,;]+/) : null;
        if (!raw) return res.status(400).json({ success: false, message: "Send a list of email addresses." });
        const emails = [...new Set(raw.filter(e => typeof e === 'string').map(normalizeEmail).filter(Boolean))];
        if (!emails.length) return res.status(400).json({ success: false, message: "Send a list of email addresses." });
        if (emails.length > MAX_BULK) return res.status(400).json({ success: false, message: `At most ${MAX_BULK} addresses at a time.` });
        const org = await loadOrg(req, res, { manage: true });
        if (!org) return;
        if (role === 'owner' && !orgService.isOrgOwner(req.user, org)) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Only owners can add owners." });
        }

        const results = [];
        const added = [];
        for (const email of emails) {
            if (!EMAIL_REGEX.test(email) || email.length > 254) { results.push({ email, status: 'invalid' }); continue; }
            if (org.members.some(m => m.email === email)) { results.push({ email, status: 'already' }); continue; }
            if (org.members.length >= MAX_MEMBERS) { results.push({ email, status: 'full' }); continue; }
            if (!inviteQuota.take(String(req.user.id))) { results.push({ email, status: 'limit' }); continue; }
            const recipient = await findUserByEmail(email);
            // Only a confirmed address gets access right away
            const active = !!recipient?.emailVerified;
            org.members.push({ userId: active ? recipient._id : null, email, role, addedBy: req.user.id, addedAt: new Date() });
            added.push({ email, recipient, active });
            results.push({ email, status: active ? 'added' : 'invited' });
        }

        if (added.length) {
            await org.save();
            await orgService.syncOrgShares(org);
            recordAudit(req, { action: 'org.members_added', target: orgTarget(org), details: { role, count: added.length, emails: added.map(a => a.email) } });
            const sharer = req.user.name || req.user.email;
            const params = { orgName: org.name };
            for (const { email, recipient, active } of added) {
                if (active) await notificationService.notifyUser({ userId: recipient._id, type: 'org_joined', params: { ...params, sharer } });
                if (recipient) {
                    mailService.queueMail(emailTemplates.shareEmail({ kind: 'orgShared', to: recipient.email, user: recipient, language: normalizeLanguage(recipient.language), sharer, params, url: safeUrl('/settings', { tab: 'organizations' }) }));
                } else {
                    mailService.queueMail(emailTemplates.shareEmail({ kind: 'orgInvite', to: email, language: normalizeLanguage(req.user.language), sharer, params, url: safeUrl('/auth/login', { mode: 'register', email }) }));
                }
            }
        }
        res.json({ success: true, results, organization: await toClientOrg(org, req.user) });
    } catch (err) {
        sendServerError(res, err, { context: 'Add organization members' });
    }
}

/**
 * POST /api/orgs/:id/members/remind { email }: owners and managers send the confirmation email
 * again to a member who has an account but has not confirmed its address yet.
 */
async function remindMember(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        const org = await loadOrg(req, res, { manage: true });
        if (!org) return;
        const member = org.members.find(m => m.email === email);
        if (!member) return res.status(404).json({ success: false, message: "Member not found." });
        if (member.userId) {
            return res.status(400).json({ success: false, code: 'ALREADY_ACTIVE', message: "This person already has access." });
        }
        const [status, body] = await sendConfirmReminder(email);
        if (status === 200) recordAudit(req, { action: 'org.member_reminded', target: orgTarget(org), details: { email } });
        res.status(status).json(body);
    } catch (err) {
        sendServerError(res, err, { context: 'Remind organization member' });
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

/**
 * GET /api/orgs/:id/overview?days=7|30: each member's traps side by side (owners and managers)
 */
async function getOverview(req, res) {
    try {
        const org = await loadOrg(req, res, { manage: true });
        if (!org) return;
        res.json({ success: true, organization: { id: String(org._id), name: org.name }, overview: await orgOverview(org, Number(req.query.days)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Organization overview' });
    }
}

/**
 * POST /api/orgs/:id/remind { userIds }: ask members to check their traps and log their work
 * (owners and managers). Per member: sent, already (reminded today) or skipped (no traps here).
 */
async function remindLog(req, res) {
    try {
        const ids = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.filter(id => typeof id === 'string'))] : [];
        if (!ids.length) return res.status(400).json({ success: false, message: "Choose the members to remind." });
        if (ids.length > MAX_MEMBERS) return res.status(400).json({ success: false, message: `At most ${MAX_MEMBERS} members at a time.` });
        const org = await loadOrg(req, res, { manage: true });
        if (!org) return;
        const results = await remindMembers(org, req.user, ids);
        const sent = results.filter(r => r.status === 'sent').length;
        if (sent) recordAudit(req, { action: 'org.log_reminded', target: orgTarget(org), details: { count: sent } });
        res.json({ success: true, results });
    } catch (err) {
        sendServerError(res, err, { context: 'Remind organization members' });
    }
}

module.exports = {
    remindLog,
    getOverview,
    addMembersBulk,
    listOrgs,
    createOrg,
    updateOrg,
    deleteOrg,
    addMember,
    remindMember,
    updateMember: (req, res) => changeMember(req, res, false),
    removeMember: (req, res) => changeMember(req, res, true),
    setCameras
};
