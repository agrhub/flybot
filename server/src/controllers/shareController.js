const { User, Camera } = require('../models');
const { findManageableCamera } = require('../utils/ownership');
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

function sharesOf(camera) {
    return (camera.sharedWith || []).map(sh => ({
        email: sh.email,
        userId: sh.userId ? String(sh.userId) : null,
        status: sh.userId ? 'active' : 'pending',
        sharedAt: sh.sharedAt
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
        res.json({ success: true, shares: sharesOf(camera) });
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
        const camera = await findManageableCamera(req.user, req.body.deviceSerial);
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
        camera.sharedWith.push({ userId: recipient?._id || null, email, sharedBy: req.user.id, sharedAt: new Date() });
        await camera.save();

        recordAudit(req, {
            action: 'camera.shared',
            target: { type: 'camera', id: camera.deviceSerial, label: camera.deviceName },
            details: { email, invited: !recipient }
        });

        const sharer = req.user.name || req.user.email;
        const params = { deviceName: camera.deviceName || camera.deviceSerial };
        if (recipient) {
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

        res.json({ success: true, invited: !recipient, shares: sharesOf(camera) });
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
        const camera = await findManageableCamera(req.user, req.body.deviceSerial);
        if (!camera) return res.status(404).json({ success: false, message: "Camera not found or you cannot manage it." });
        const before = camera.sharedWith.length;
        camera.sharedWith = camera.sharedWith.filter(sh => sh.email !== email);
        if (camera.sharedWith.length === before) {
            return res.status(404).json({ success: false, message: "This camera is not shared with that email." });
        }
        await camera.save();
        recordAudit(req, { action: 'camera.unshared', target: { type: 'camera', id: camera.deviceSerial, label: camera.deviceName }, details: { email } });
        res.json({ success: true, shares: sharesOf(camera) });
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
    // Lazy: dashboardController requires this module
    const { claimPendingDashboardShares } = require('./dashboardController');
    await claimPendingDashboardShares(user);
    const result = await Camera.updateMany(
        { sharedWith: { $elemMatch: { email, userId: null } } },
        { $set: { 'sharedWith.$[invite].userId': user._id } },
        { arrayFilters: [{ 'invite.email': email, 'invite.userId': null }] }
    );
    return result.modifiedCount || 0;
}

module.exports = {
    listShares,
    addShare,
    removeShare,
    claimPendingShares,
    EMAIL_REGEX,
    normalizeEmail,
    findUserByEmail,
    safeUrl
};
