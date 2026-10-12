const { User, Camera, Dashboard, Farm, Organization } = require('../models');
const { isAdmin } = require('../constants/roles');
const { remindQuota } = require('../middlewares/rateLimit');
const { findManageableCamera, findOwnedCamera } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const { normalizeLanguage } = require('../utils/i18n');
const { queueMail } = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const { appUrl } = require('../services/authTokenService');
const notificationService = require('../services/notificationService');
const { recordAudit } = require('../services/auditService');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SHARES_PER_CAMERA = 50;

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const findUserByEmail = (email) => User.findOne({ email }).collation({ locale: 'en', strength: 2 });

/**
 * Of the invited emails, those that already have an account (not confirmed yet: a confirmed
 * account is linked when invited or when it confirms).
 */
async function emailsWithAccount(emails) {
    if (!emails.length) return new Set();
    const users = await User.find({ email: { $in: emails } })
        .collation({ locale: 'en', strength: 2 }).select('email').lean();
    return new Set(users.map(u => String(u.email).toLowerCase()));
}

/**
 * Share lists as shown to the sharer: "unverified" instead of "pending" when the invitee has an
 * account but has not confirmed its email (access starts once they do).
 */
async function withAccountStatus(shares) {
    const found = await emailsWithAccount(shares.filter(s => s.status === 'pending').map(s => s.email));
    return shares.map(s => (s.status === 'pending' && found.has(String(s.email).toLowerCase()) ? { ...s, status: 'unverified' } : s));
}

/**
 * Send the confirmation email again to an invitee whose account is not confirmed.
 * At most 3 a day per address, counted only when one is sent. Returns [status, body].
 */
async function sendConfirmReminder(email) {
    const account = await findUserByEmail(email);
    if (!account) return [400, { success: false, code: 'NO_ACCOUNT', message: "This person has not created an account yet." }];
    if (account.emailVerified) return [400, { success: false, code: 'ALREADY_ACTIVE', message: "This person already has access." }];
    if (!remindQuota.take(email)) {
        return [429, { success: false, message: "A reminder was already sent to this address today. Please try again tomorrow." }];
    }
    // Lazy: authController requires this module
    await require('./authController').sendVerificationEmail(account);
    return [200, { success: true }];
}

/**
 * POST /api/user/share/remind { email }: whoever invited this email to a camera, report, farm or
 * organization they manage (or an admin) can send the confirmation email again.
 */
async function remindInvitee(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        if (!EMAIL_REGEX.test(email)) return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        const pending = { $elemMatch: { email, userId: null } };
        const allowed = isAdmin(req.user) || (await Promise.all([
            Camera.exists({ userId: req.user.id, sharedWith: pending }),
            Dashboard.exists({ ownerId: req.user.id, sharedWith: pending }),
            Farm.exists({ ownerId: req.user.id, sharedWith: pending }),
            Organization.exists({ members: { $all: [{ $elemMatch: { userId: req.user.id, role: { $in: ['owner', 'manager'] } } }, pending] } })
        ])).some(Boolean);
        // Same answer as "no invitation" so addresses cannot be probed
        if (!allowed) return res.status(404).json({ success: false, message: "Invitation not found." });
        const [status, body] = await sendConfirmReminder(email);
        if (status === 200) recordAudit(req, { action: 'user.confirm_reminded', target: { type: 'user', label: email } });
        res.status(status).json(body);
    } catch (err) {
        sendServerError(res, err, { context: 'Remind invitee' });
    }
}

function sharesOf(camera) {
    return (camera.sharedWith || []).map(sh => ({
        email: sh.email,
        userId: sh.userId ? String(sh.userId) : null,
        status: sh.userId ? 'active' : 'pending',
        sharedAt: sh.sharedAt,
        // Access through the camera's farm (managed on the farm page)
        viaFarm: sh.viaFarm ? String(sh.viaFarm) : null,
    // Access through the camera's organization (managed on the organization page)
    viaOrg: sh.viaOrg ? String(sh.viaOrg) : null
    }));
}

function safeUrl(path, query) {
    try {
        return appUrl(path, query);
    } catch (err) {
        console.warn('⚠️ Share email without link:', err.message);
        return null;
    }
}

/**
 * GET /api/user/camera/shares?deviceSerial=
 */
async function listShares(req, res) {
    try {
        const camera = await findManageableCamera(req.user, req.query.deviceSerial);
        if (!camera) return res.status(404).json({ success: false, message: "Camera not found or you cannot manage it." });
        res.json({ success: true, shares: await withAccountStatus(sharesOf(camera)) });
    } catch (err) {
        sendServerError(res, err, { context: 'List camera shares' });
    }
}

/**
 * POST /api/user/camera/share { deviceSerial, email }
 * Existing account: access right away (in-app notification + email).
 * Unknown email: pending invitation, activated when that person signs up and confirms the address.
 */
async function addShare(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        // Sharing hands the camera to someone else: owner or admin only
        const camera = await findOwnedCamera(req.user, req.body.deviceSerial);
        if (!camera) return res.status(404).json({ success: false, message: "Camera not found or you cannot manage it." });

        const owner = await User.findById(camera.userId).select('email');
        if (owner && owner.email.toLowerCase() === email) {
            return res.status(400).json({ success: false, code: 'SHARE_WITH_OWNER', message: "This person already owns the camera." });
        }
        if ((camera.sharedWith || []).some(sh => sh.email === email)) {
            return res.status(409).json({ success: false, code: 'ALREADY_SHARED', message: "The camera is already shared with this email." });
        }
        if ((camera.sharedWith || []).length >= MAX_SHARES_PER_CAMERA) {
            return res.status(400).json({ success: false, message: `A camera can be shared with at most ${MAX_SHARES_PER_CAMERA} people.` });
        }

        const recipient = await findUserByEmail(email);
        // Access starts only for a confirmed address: anyone can register an unconfirmed account
        // with someone else's email (it is claimed when the real owner confirms it)
        const active = !!recipient?.emailVerified;
        camera.sharedWith.push({ userId: active ? recipient._id : null, email, sharedBy: req.user.id, sharedAt: new Date() });
        await camera.save();

        recordAudit(req, {
            action: 'camera.shared',
            target: { type: 'camera', id: camera.deviceSerial, label: camera.deviceName },
            details: { email, invited: !active }
        });

        const sharer = req.user.name || req.user.email;
        const params = { deviceName: camera.deviceName || camera.deviceSerial };
        if (active) {
            await notificationService.notifyUser({
                userId: recipient._id,
                type: 'camera_shared',
                deviceSerial: camera.deviceSerial,
                params: { ...params, sharer }
            });
            queueMail(emailTemplates.shareEmail({
                kind: 'cameraShared',
                to: recipient.email,
                user: recipient,
                language: normalizeLanguage(recipient.language),
                sharer,
                params,
                url: safeUrl('/cameras')
            }));
        } else if (recipient) {
            // Has an account but has not confirmed the address yet
            queueMail(emailTemplates.shareEmail({
                kind: 'cameraShared',
                to: recipient.email,
                user: recipient,
                language: normalizeLanguage(recipient.language),
                sharer,
                params,
                url: safeUrl('/cameras')
            }));
        } else {
            queueMail(emailTemplates.shareEmail({
                kind: 'invite',
                to: email,
                language: normalizeLanguage(req.user.language),
                sharer,
                params,
                url: safeUrl('/auth/login', { mode: 'register', email })
            }));
        }

        res.json({ success: true, invited: !active, shares: await withAccountStatus(sharesOf(camera)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Share camera' });
    }
}

/**
 * DELETE /api/user/camera/share { deviceSerial, email }
 */
async function removeShare(req, res) {
    try {
        const email = normalizeEmail(req.body.email);
        // Sharing hands the camera to someone else: owner or admin only
        const camera = await findOwnedCamera(req.user, req.body.deviceSerial);
        if (!camera) return res.status(404).json({ success: false, message: "Camera not found or you cannot manage it." });
        const before = camera.sharedWith.length;
        camera.sharedWith = camera.sharedWith.filter(sh => sh.email !== email || sh.viaFarm || sh.viaOrg);
        if (camera.sharedWith.length === before) {
            if (camera.sharedWith.some(sh => sh.email === email && sh.viaOrg)) {
                return res.status(409).json({ success: false, code: 'VIA_ORG', message: "This person sees the camera through its organization. Remove them from the organization instead." });
            }
            if (camera.sharedWith.some(sh => sh.email === email)) {
                return res.status(409).json({ success: false, code: 'VIA_FARM', message: "This person sees the camera through its farm. Remove them from the farm instead." });
            }
            return res.status(404).json({ success: false, message: "This camera is not shared with that email." });
        }
        await camera.save();
        recordAudit(req, { action: 'camera.unshared', target: { type: 'camera', id: camera.deviceSerial, label: camera.deviceName }, details: { email } });
        res.json({ success: true, shares: await withAccountStatus(sharesOf(camera)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Unshare camera' });
    }
}

/**
 * Turn pending camera and dashboard invitations for this (now verified) email into real access.
 */
async function claimPendingShares(user) {
    const email = String(user.email || '').toLowerCase();
    if (!email) return 0;
    // Lazy: these controllers require this module
    const { claimPendingDashboardShares } = require('./dashboardController');
    const { claimPendingFarmShares } = require('./farmController');
    await claimPendingDashboardShares(user);
    await claimPendingFarmShares(user);
    await require('../services/orgService').claimPendingMembers(user);
    const result = await Camera.updateMany(
        { sharedWith: { $elemMatch: { email, userId: null } } },
        { $set: { 'sharedWith.$[invite].userId': user._id } },
        { arrayFilters: [{ 'invite.email': email, 'invite.userId': null }] }
    );
    return result.modifiedCount || 0;
}

module.exports = {
    listShares,
    remindInvitee,
    sendConfirmReminder,
    withAccountStatus,
    emailsWithAccount,
    addShare,
    removeShare,
    claimPendingShares,
    EMAIL_REGEX,
    normalizeEmail,
    findUserByEmail,
    safeUrl
};
