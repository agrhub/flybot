const mongoose = require('mongoose');
const { Notification } = require('../models');
const { toClient } = require('../services/notificationService');
const sseHub = require('../realtime/sseHub');
const { sendServerError } = require('../utils/http');

const MAX_LIMIT = 50;

/**
 * GET /api/notifications?limit=20&before=<ISO date>
 */
async function listNotifications(req, res) {
    try {
        const userId = req.user.id;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
        const filter = { userId };
        if (req.query.before) {
            const before = new Date(req.query.before);
            if (Number.isNaN(before.getTime())) {
                return res.status(400).json({ success: false, message: "Invalid 'before' date." });
            }
            filter.createdAt = { $lt: before };
        }

        const [items, unreadCount] = await Promise.all([
            Notification.find(filter).sort({ createdAt: -1 }).limit(limit + 1),
            Notification.countDocuments({ userId, read: false })
        ]);

        res.json({
            success: true,
            notifications: items.slice(0, limit).map(toClient),
            hasMore: items.length > limit,
            unreadCount
        });
    } catch (err) {
        sendServerError(res, err, { context: 'List notifications' });
    }
}

/**
 * POST /api/notifications/read  { ids: [...] } or { all: true }
 */
async function markRead(req, res) {
    try {
        const userId = req.user.id;
        const { ids, all } = req.body;
        const filter = { userId, read: false };

        if (all !== true) {
            if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 ||
                !ids.every(id => typeof id === 'string' && mongoose.isValidObjectId(id))) {
                return res.status(400).json({ success: false, message: "Provide 'ids' (up to 100) or 'all: true'." });
            }
            filter._id = { $in: ids };
        }

        await Notification.updateMany(filter, { $set: { read: true } });
        const unreadCount = await Notification.countDocuments({ userId, read: false });
        res.json({ success: true, unreadCount });
    } catch (err) {
        sendServerError(res, err, { context: 'Mark notifications read' });
    }
}

/**
 * GET /api/notifications/stream  (Server-Sent Events, authenticated by the httpOnly cookie)
 */
function stream(req, res) {
    sseHub.addClient(req.user.id, req, res);
}

/**
 * GET /api/notifications/weekly-report: this week's report for me (preview)
 * POST /api/notifications/weekly-report: send it to me now on my channels
 */
async function weeklyReport(req, res) {
    try {
        const { User } = require('../models');
        const reportService = require('../services/reportService');
        const user = await User.findById(req.user.id);
        const report = await reportService.buildWeeklyReport(user);
        if (!report) return res.json({ success: true, report: null });
        let sent = null;
        if (req.method === 'POST') sent = await reportService.sendReport(user, report);
        res.json({ success: true, report, sent });
    } catch (err) {
        sendServerError(res, err, { context: 'Weekly report' });
    }
}

module.exports = {
    weeklyReport,
    listNotifications,
    markRead,
    stream
};
