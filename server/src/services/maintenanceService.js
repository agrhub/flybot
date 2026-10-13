const { Camera, Snapshot, MaintenanceEvent } = require('../models');
const notificationService = require('./notificationService');

const DAY_MS = 24 * 60 * 60 * 1000;
// Reminder choices offered in the app (0 = off)
const CARD_REMINDER_DAYS = [0, 3, 5, 7, 10, 14, 21, 30];
const DEFAULT_CARD_REMINDER_DAYS = 7;

// A new card starts near zero: a drop to a quarter or less of a reasonably full card
const DETECT_MIN_PREVIOUS = 8;
const DETECT_RATIO = 0.25;
// Ignore drops right after a recorded change (the next scans of the same new card)
const DETECT_QUIET_MS = 12 * 60 * 60 * 1000;

const cameraName = (camera) => camera.deviceName || camera.deviceSerial;

/**
 * When the card on this camera is due for replacement (null when reminders are off).
 */
function cardDueAt(camera) {
    // Lure traps have no sticky card to replace
    if (camera?.trapKind === 'lure') return null;
    const days = camera.cardReminderDays ?? DEFAULT_CARD_REMINDER_DAYS;
    if (!days) return null;
    const since = camera.cardReplacedAt || camera.addedAt;
    return since ? new Date(new Date(since).getTime() + days * DAY_MS) : null;
}

async function syncCardReplacedAt(deviceSerial) {
    const latest = await MaintenanceEvent.findOne({ deviceSerial, type: 'card_replaced' }).sort({ at: -1 }).select('at').lean();
    await Camera.updateOne({ deviceSerial }, { $set: { cardReplacedAt: latest?.at || null } });
    return latest?.at || null;
}

/**
 * Record one event. `user` is req.user (null for automatic detections).
 */
async function recordEvent({ deviceSerial, type, at = new Date(), note = '', source = 'manual', user = null }) {
    const event = await MaintenanceEvent.create({
        deviceSerial,
        type,
        at,
        note: String(note || '').slice(0, 300),
        source,
        userId: user?.id || null,
        userEmail: user?.email || ''
    });
    if (type === 'card_replaced') await syncCardReplacedAt(deviceSerial);
    return event;
}

async function deleteEvent(event) {
    await MaintenanceEvent.deleteOne({ _id: event._id });
    if (event.type === 'card_replaced') await syncCardReplacedAt(event.deviceSerial);
}

/**
 * After an AI result: a sharp drop from the previous scan most likely means a new card.
 * Records it (source "detected") and tells the people who see the camera. Never throws.
 */
async function detectCardChange(deviceSerial, snapshot, count) {
    try {
        // Without glue the count goes up and down all day: a drop is not a new card
        if (await Camera.exists({ deviceSerial, trapKind: 'lure' })) return null;
        const previous = await Snapshot.findOne({
            deviceSerial,
            aiProcessed: true,
            createdAt: { $lt: snapshot.createdAt }
        }).sort({ createdAt: -1 }).select('aiResults.summary createdAt').lean();
        if (!previous) return null;
        const previousCount = notificationService.countPests(previous.aiResults?.summary);
        if (previousCount < DETECT_MIN_PREVIOUS || count > previousCount * DETECT_RATIO) return null;

        // Somewhere between the two scans; recorded at the new scan
        const recent = await MaintenanceEvent.exists({
            deviceSerial,
            type: 'card_replaced',
            at: { $gte: new Date(new Date(snapshot.createdAt).getTime() - DETECT_QUIET_MS) }
        });
        if (recent) return null;

        const event = await recordEvent({
            deviceSerial,
            type: 'card_replaced',
            at: snapshot.createdAt,
            source: 'detected',
            note: `${previousCount} → ${count}`
        });
        await notificationService.notifyCameraOwners(deviceSerial, 'card_change_detected', (camera) => ({
            deviceName: cameraName(camera),
            previous: previousCount,
            count
        }));
        return event;
    } catch (err) {
        console.error(`⚠️ Card change detection failed (${deviceSerial}):`, err.message);
        return null;
    }
}

/**
 * Daily: remind the people who see a camera when its card is due (once a day at most).
 */
async function sendCardReminders(now = new Date()) {
    const cameras = await Camera.find({ cardReminderDays: { $ne: 0 }, trapKind: { $ne: 'lure' } })
        .select('deviceSerial deviceName cardReplacedAt cardReminderDays addedAt trapKind').lean();
    let sent = 0;
    for (const camera of cameras) {
        const due = cardDueAt(camera);
        if (!due || due > now) continue;
        const since = camera.cardReplacedAt || camera.addedAt;
        const ageDays = Math.floor((now - new Date(since)) / DAY_MS);
        const created = await notificationService.notifyCameraOwners(camera.deviceSerial, 'card_due', () => ({
            deviceName: cameraName(camera),
            days: ageDays
        }));
        sent += created.length;
    }
    return sent;
}

module.exports = {
    CARD_REMINDER_DAYS,
    DEFAULT_CARD_REMINDER_DAYS,
    cardDueAt,
    recordEvent,
    deleteEvent,
    detectCardChange,
    sendCardReminders
};
