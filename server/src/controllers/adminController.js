const mongoose = require('mongoose');
const { User, Camera, Session, Notification, AuthToken, Dashboard, AuditLog, PushSubscription, Farm, Plot, Organization, ApiKey, Webhook } = require('../models');
const { ROLES, roleOf } = require('../constants/roles');
const { sendServerError } = require('../utils/http');
const { recordAudit, AUDIT_ACTIONS, CATEGORIES } = require('../services/auditService');
const trainingSync = require('../services/trainingSync');

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

        const previousRole = roleOf(target);
        const wasDisabled = !!target.disabled;
        if (role !== undefined) target.role = role;
        if (disabled !== undefined) {
            target.disabled = disabled;
            if (disabled) {
                // Sign the account out everywhere
                target.tokenVersion = (target.tokenVersion || 0) + 1;
                await Session.updateMany({ userId: target._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
                // ...and stop alerts to their phones
                await PushSubscription.deleteMany({ userId: target._id });
            }
        }
        await target.save();

        const auditTarget = { type: 'user', id: String(target._id), label: target.email };
        if (role !== undefined && role !== previousRole) {
            recordAudit(req, { action: 'user.role_changed', target: auditTarget, details: { from: previousRole, to: role } });
        }
        if (disabled !== undefined && disabled !== wasDisabled) {
            recordAudit(req, { action: disabled ? 'user.disabled' : 'user.enabled', target: auditTarget });
        }

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
            Dashboard.updateMany({ 'sharedWith.userId': target._id }, { $pull: { sharedWith: { userId: target._id } } }),
            Dashboard.deleteMany({ ownerId: target._id }),
            Farm.updateMany({ 'sharedWith.userId': target._id }, { $pull: { sharedWith: { userId: target._id } } }),
            Organization.updateMany({ 'members.userId': target._id }, { $pull: { members: { userId: target._id } } }),
            Session.deleteMany({ userId: target._id }),
            Notification.deleteMany({ userId: target._id }),
            AuthToken.deleteMany({ userId: target._id }),
            PushSubscription.deleteMany({ userId: target._id }),
            ApiKey.deleteMany({ userId: target._id }),
            Webhook.deleteMany({ userId: target._id })
        ]);
        // Their farms go too (they own no cameras any more, so the plots are empty)
        const ownedFarms = await Farm.find({ ownerId: target._id }).select('_id').lean();
        if (ownedFarms.length) {
            const farmIds = ownedFarms.map(f => f._id);
            await Camera.updateMany({ 'sharedWith.viaFarm': { $in: farmIds } }, { $pull: { sharedWith: { viaFarm: { $in: farmIds } } } });
            await Plot.deleteMany({ farmId: { $in: farmIds } });
            await Farm.deleteMany({ _id: { $in: farmIds } });
        }
        // Organizations they were in: empty ones go, ownerless ones get a new owner
        await Organization.deleteMany({ members: { $size: 0 } });
        for (const org of await Organization.find({ 'members.role': { $ne: 'owner' } })) {
            const next = org.members.find(m => m.role === 'manager' && m.userId) || org.members.find(m => m.userId);
            if (next) {
                next.role = 'owner';
                await org.save();
                await require('../services/orgService').syncOrgShares(org);
            }
        }
        await User.deleteOne({ _id: target._id });
        recordAudit(req, { action: 'user.deleted', target: { type: 'user', id: String(target._id), label: target.email }, details: { role: roleOf(target) } });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin delete user' });
    }
}

/**
 * GET /api/admin/cameras?q=&page=&limit=: every camera with its owner and share count
 */
async function listCameras(req, res) {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
        const filter = {};
        if (typeof req.query.q === 'string' && req.query.q.trim()) {
            const pattern = new RegExp(escapeRegex(req.query.q.trim().slice(0, 100)), 'i');
            // Match serial/name, or the owner's email
            const owners = await User.find({ email: pattern }).select('_id');
            filter.$or = [{ deviceSerial: pattern }, { deviceName: pattern }, { userId: { $in: owners.map(o => o._id) } }];
        }
        const [total, cameras] = await Promise.all([
            Camera.countDocuments(filter),
            Camera.find(filter).populate('userId', 'email name role').sort({ addedAt: -1 }).skip((page - 1) * limit).limit(limit)
        ]);
        res.json({
            success: true,
            total,
            page,
            limit,
            cameras: cameras.map(c => ({
                deviceSerial: c.deviceSerial,
                deviceName: c.deviceName,
                status: c.status,
                addedAt: c.addedAt,
                lastCaptureAt: c.lastCaptureAt,
                owner: c.userId && c.userId.email
                    ? { id: String(c.userId._id), email: c.userId.email, name: c.userId.name || '', role: roleOf(c.userId) }
                    : null,
                sharedCount: (c.sharedWith || []).length
            }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin list cameras' });
    }
}

/**
 * PUT /api/admin/cameras/:deviceSerial/owner  { email, keepPreviousOwnerAccess = true }
 * The new owner must be a manager or admin (owners manage their cameras).
 */
async function transferCamera(req, res) {
    try {
        const { deviceSerial } = req.params;
        const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
        const keepAccess = req.body.keepPreviousOwnerAccess !== false;

        const camera = await Camera.findOne({ deviceSerial });
        if (!camera) return res.status(404).json({ success: false, message: "Camera not found." });
        const newOwner = email ? await User.findOne({ email }).collation({ locale: 'en', strength: 2 }) : null;
        if (!newOwner) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: "No account with this email." });
        if (!['admin', 'manager'].includes(roleOf(newOwner))) {
            return res.status(400).json({ success: false, code: 'NOT_MANAGER', message: "The new owner must be a manager or an admin." });
        }
        if (String(camera.userId) === String(newOwner._id)) {
            return res.status(400).json({ success: false, message: "This account already owns the camera." });
        }

        const previousOwner = camera.userId ? await User.findById(camera.userId).select('email') : null;
        // The new owner no longer needs a share entry
        camera.sharedWith = camera.sharedWith.filter(sh => String(sh.userId) !== String(newOwner._id) && sh.email !== newOwner.email.toLowerCase());
        if (keepAccess && previousOwner && !camera.sharedWith.some(sh => String(sh.userId) === String(previousOwner._id))) {
            camera.sharedWith.push({ userId: previousOwner._id, email: previousOwner.email.toLowerCase(), sharedBy: req.user.id, sharedAt: new Date() });
        }
        camera.userId = newOwner._id;
        await camera.save();
        // The plot belongs to the previous owner's farm
        await require('../services/farmService').unassignCameras({ _id: camera._id });
        recordAudit(req, {
            action: 'camera.transferred',
            target: { type: 'camera', id: camera.deviceSerial, label: camera.deviceName },
            details: { from: previousOwner?.email || '', to: newOwner.email, keptAccess: keepAccess }
        });

        res.json({ success: true, owner: { id: String(newOwner._id), email: newOwner.email }, sharedCount: camera.sharedWith.length });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin transfer camera' });
    }
}

/**
 * GET/PUT /api/admin/settings: system-wide settings
 */
async function getSystemSettings(req, res) {
    try {
        const { getSettings } = require('../services/settingsService');
        res.json({ success: true, settings: await getSettings() });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin get settings' });
    }
}

async function updateSystemSettings(req, res) {
    try {
        const { updateSettings } = require('../services/settingsService');
        const result = await updateSettings(req.body, req.user.id);
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        recordAudit(req, { action: 'settings.updated', target: { type: 'settings', id: 'global', label: 'System settings' }, details: req.body });
        res.json({ success: true, settings: result.settings });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin update settings' });
    }
}

// ---------- Audit log ----------

const MAX_EXPORT_ROWS = 5000;

function auditFilter(query) {
    const filter = {};
    if (CATEGORIES.includes(query.category)) filter.category = query.category;
    if (AUDIT_ACTIONS.includes(query.action)) filter.action = query.action;
    if (typeof query.q === 'string' && query.q.trim()) {
        const pattern = new RegExp(escapeRegex(query.q.trim().slice(0, 100)), 'i');
        filter.$or = [{ actorEmail: pattern }, { targetLabel: pattern }, { targetId: pattern }, { ip: pattern }];
    }
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if ((from && !isNaN(from)) || (to && !isNaN(to))) {
        filter.createdAt = {};
        if (from && !isNaN(from)) filter.createdAt.$gte = from;
        if (to && !isNaN(to)) filter.createdAt.$lte = to;
    }
    return filter;
}

const toAuditEntry = (e) => ({
    id: String(e._id),
    action: e.action,
    category: e.category,
    actor: { id: e.actorId ? String(e.actorId) : null, email: e.actorEmail },
    target: { type: e.targetType, id: e.targetId, label: e.targetLabel },
    details: e.details || null,
    ip: e.ip,
    userAgent: e.userAgent,
    createdAt: e.createdAt
});

/**
 * GET /api/admin/audit?category=&action=&q=&from=&to=&page=&limit=
 */
async function listAuditLog(req, res) {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_PAGE_SIZE);
        const filter = auditFilter(req.query);
        const [total, entries] = await Promise.all([
            AuditLog.countDocuments(filter),
            AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean()
        ]);
        res.json({ success: true, total, page, limit, actions: AUDIT_ACTIONS, entries: entries.map(toAuditEntry) });
    } catch (err) {
        sendServerError(res, err, { context: 'Admin audit log' });
    }
}

// Spreadsheet apps run cells starting with = + - @ as formulas: prefix them
const csvCell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * GET /api/admin/audit/export: the same filters, as CSV (newest first, at most 5000 rows)
 */
async function exportAuditLog(req, res) {
    try {
        const entries = await AuditLog.find(auditFilter(req.query)).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean();
        const header = ['time', 'action', 'actor', 'target_type', 'target_id', 'target', 'details', 'ip'];
        const rows = entries.map(e => [
            e.createdAt.toISOString(), e.action, e.actorEmail, e.targetType, e.targetId, e.targetLabel,
            e.details ? JSON.stringify(e.details) : '', e.ip
        ].map(csvCell).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.attachment(`flybot-audit-${new Date().toISOString().slice(0, 10)}.csv`);
        // BOM so Excel reads UTF-8 (Vietnamese names) correctly
        res.send('﻿' + [header.join(','), ...rows].join('\r\n'));
    } catch (err) {
        sendServerError(res, err, { context: 'Admin audit export' });
    }
}

/**
 * GET /api/admin/training-sync: state of the Roboflow retraining upload
 * POST /api/admin/training-sync/run: upload the next batch now (also retries failed ones)
 */
async function getTrainingSync(req, res) {
    try {
        res.json({ success: true, sync: await trainingSync.stats() });
    } catch (err) {
        sendServerError(res, err, { context: 'Training sync status' });
    }
}

async function runTrainingSync(req, res) {
    try {
        if (!trainingSync.isConfigured()) {
            return res.status(400).json({ success: false, message: 'Roboflow upload is not configured (ROBOFLOW_UPLOAD_PROJECT).' });
        }
        const retried = await trainingSync.retryFailed();
        const result = await trainingSync.syncPending({ force: true });
        res.json({ success: true, retried, result, sync: await trainingSync.stats() });
    } catch (err) {
        sendServerError(res, err, { context: 'Training sync run' });
    }
}

module.exports = {
    getTrainingSync,
    runTrainingSync,
    listAuditLog,
    exportAuditLog,
    listUsers,
    updateUser,
    deleteUser,
    listCameras,
    transferCamera,
    getSystemSettings,
    updateSystemSettings,
    toAdminUser
};
