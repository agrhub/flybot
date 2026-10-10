const mongoose = require('mongoose');
const { MaintenanceEvent } = require('../models');
const { MAINTENANCE_TYPES } = require('../models/MaintenanceEvent');
const { findViewableCamera, findManageableCamera } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const maintenanceService = require('../services/maintenanceService');

const MAX_LIST = 100;
// Back-dating is allowed (entered later), but not into the future or years back
const MAX_BACKDATE_MS = 90 * 24 * 60 * 60 * 1000;

const toClient = (e) => ({
    id: String(e._id),
    deviceSerial: e.deviceSerial,
    type: e.type,
    at: e.at,
    note: e.note,
    source: e.source,
    by: e.userEmail || null
});

/**
 * GET /api/user/camera/maintenance?deviceSerial=&limit=  (anyone who can see the camera)
 */
async function listEvents(req, res) {
    try {
        const camera = await findViewableCamera(req.user, req.query.deviceSerial);
        if (!camera) return res.status(404).json({ success: false, message: "Camera not found." });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIST);
        const events = await MaintenanceEvent.find({ deviceSerial: camera.deviceSerial }).sort({ at: -1 }).limit(limit).lean();
        res.json({
            success: true,
            card: {
                replacedAt: camera.cardReplacedAt || null,
                reminderDays: camera.cardReminderDays ?? maintenanceService.DEFAULT_CARD_REMINDER_DAYS,
                dueAt: maintenanceService.cardDueAt(camera)
            },
            events: events.map(toClient)
        });
    } catch (err) {
        sendServerError(res, err, { context: 'List maintenance' });
    }
}

/**
 * POST /api/user/camera/maintenance { deviceSerial, type, at?, note? }  (owners/admins)
 */
async function addEvent(req, res) {
    try {
        const { type, note } = req.body;
        if (!MAINTENANCE_TYPES.includes(type)) {
            return res.status(400).json({ success: false, message: `type must be one of ${MAINTENANCE_TYPES.join(', ')}.` });
        }
        if (note !== undefined && (typeof note !== 'string' || note.length > 300)) {
            return res.status(400).json({ success: false, message: "Note must be at most 300 characters." });
        }
        let at = new Date();
        if (req.body.at !== undefined) {
            at = new Date(req.body.at);
            if (isNaN(at) || at > new Date(Date.now() + 5 * 60 * 1000) || at < new Date(Date.now() - MAX_BACKDATE_MS)) {
                return res.status(400).json({ success: false, message: "Invalid date (up to 90 days back, not in the future)." });
            }
        }
        const camera = await findManageableCamera(req.user, req.body.deviceSerial);
        if (!camera) return res.status(404).json({ success: false, message: "Camera not found or you cannot manage it." });

        const event = await maintenanceService.recordEvent({ deviceSerial: camera.deviceSerial, type, at, note, user: req.user });
        res.status(201).json({ success: true, event: toClient(event) });
    } catch (err) {
        sendServerError(res, err, { context: 'Add maintenance' });
    }
}

/**
 * DELETE /api/user/camera/maintenance/:id  (owners/admins; e.g. a wrong automatic detection)
 */
async function deleteEvent(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Event not found." });
        const event = await MaintenanceEvent.findById(req.params.id);
        const camera = event ? await findManageableCamera(req.user, event.deviceSerial) : null;
        if (!camera) return res.status(404).json({ success: false, message: "Event not found." });
        await maintenanceService.deleteEvent(event);
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete maintenance' });
    }
}

module.exports = {
    listEvents,
    addEvent,
    deleteEvent
};
