const mongoose = require('mongoose');
const { User, Camera, Session, Notification, AuthToken } = require('../models');
const { ROLES, roleOf } = require('../constants/roles');
const { sendServerError } = require('../utils/http');

const MAX_PAGE_SIZE = 100;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toAdminUser(user, cameraCount = 0) {
    return {
        id: user._id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        role: roleOf(user),
        disabled: !!user.disabled,
        emailVerified: !!user.emailVerified,
        createdAt: user.createdAt,
        cameraCount
    };
}

async function cameraCountsFor(userIds) {
    const rows = await Camera.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } }
    ]);
    return new Map(rows.map(r => [String(r._id), r.count]));
}

/**
 * GET /api/admin/users?q=&role=&page=&limit=
 */
async function listUsers(req, res) {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
        const filter = {};
        if (typeof req.query.q === 'string' && req.query.q.trim()) {
            const pattern = new RegExp(escapeRegex(req.query.q.trim().slice(0, 100)), 'i');
            filter.$or = [{ email: pattern }, { name: pattern }];
        }
        if (ROLES.includes(req.query.role)) filter.role = req.query.role;

        const [total, users] = await Promise.all([
            User.countDocuments(filter),
            User.find(filter).select('-password').sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit)
        ]);
        const counts = await cameraCountsFor(users.map(u => u._id));
        res.json({
            success: true,
            total,
            page,
            limit,
            users: users.map(u => toAdminUser(u, counts.get(String(u._id)) || 0))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin list users' });
    }
}

async function wouldRemoveLastAdmin(target) {
    if (roleOf(target) !== 'admin') return false;
    const otherAdmins = await User.countDocuments({ role: 'admin', disabled: { $ne: true }, _id: { $ne: target._id } });
    return otherAdmins === 0;
}

/**
 * PUT /api/admin/users/:userId  { role?, disabled? }
 */
async function updateUser(req, res) {
    try {
        const { userId } = req.params;
        const { role, disabled } = req.body;
        if (!mongoose.isValidObjectId(userId)) return res.status(404).json({ success: false, message: "User not found." });
        if (role !== undefined && !ROLES.includes(role)) {
            return res.status(400).json({ success: false, message: `role must be one of ${ROLES.join(', ')}.` });
        }
        if (disabled !== undefined && typeof disabled !== 'boolean') {
            return res.status(400).json({ success: false, message: "disabled must be true or false." });
        }

        const target = await User.findById(userId);
        if (!target) return res.status(404).json({ success: false, message: "User not found." });

        const isSelf = String(target._id) === String(req.user.id);
        if (isSelf && (role !== undefined && role !== roleOf(target) || disabled === true)) {
            return res.status(400).json({ success: false, code: 'SELF_CHANGE', message: "You cannot change your own role or disable your own account." });
        }
        const losesAdmin = (role !== undefined && role !== 'admin') || disabled === true;
        if (losesAdmin && await wouldRemoveLastAdmin(target)) {
            return res.status(400).json({ success: false, code: 'LAST_ADMIN', message: "At least one active admin is required." });
        }

        if (role !== undefined) target.role = role;
        if (disabled !== undefined) {
            target.disabled = disabled;
            if (disabled) {
                // Sign the account out everywhere
                target.tokenVersion = (target.tokenVersion || 0) + 1;
                await Session.updateMany({ userId: target._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
            }
        }
        await target.save();

        const counts = await cameraCountsFor([target._id]);
        res.json({ success: true, user: toAdminUser(target, counts.get(String(target._id)) || 0) });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin update user' });
    }
}

/**
 * DELETE /api/admin/users/:userId
 * Refused while the user still owns cameras (transfer them first).
 */
async function deleteUser(req, res) {
    try {
        const { userId } = req.params;
        if (!mongoose.isValidObjectId(userId)) return res.status(404).json({ success: false, message: "User not found." });
        if (String(userId) === String(req.user.id)) {
            return res.status(400).json({ success: false, code: 'SELF_CHANGE', message: "You cannot delete your own account." });
        }
        const target = await User.findById(userId);
        if (!target) return res.status(404).json({ success: false, message: "User not found." });
        if (await wouldRemoveLastAdmin(target)) {
            return res.status(400).json({ success: false, code: 'LAST_ADMIN', message: "At least one active admin is required." });
        }
        const owned = await Camera.countDocuments({ userId: target._id });
        if (owned > 0) {
            return res.status(409).json({
                success: false,
                code: 'OWNS_CAMERAS',
                cameraCount: owned,
                message: `This user owns ${owned} camera(s). Transfer them to another account first.`
            });
        }

        await Promise.all([
            Camera.updateMany({ 'sharedWith.userId': target._id }, { $pull: { sharedWith: { userId: target._id } } }),
            Session.deleteMany({ userId: target._id }),
            Notification.deleteMany({ userId: target._id }),
            AuthToken.deleteMany({ userId: target._id })
        ]);
        await User.deleteOne({ _id: target._id });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin delete user' });
    }
}

module.exports = {
    listUsers,
    updateUser,
    deleteUser,
    toAdminUser
};
