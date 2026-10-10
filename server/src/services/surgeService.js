const { DailyStat, MaintenanceEvent, Camera } = require('../models');
const notificationService = require('./notificationService');
const { dayKeyOf, DAY_MS } = require('./dailyStats');

// Compare today's trap count with the count this many days earlier
const SURGE_DAYS = 3;
// A rise of at least 50%, at least this many insects more, and a count worth worrying about
const SURGE_RATIO = 1.5;
const SURGE_MIN_INCREASE = 3;
const SURGE_MIN_COUNT = 5;

/**
 * Has the count on the current sticky card jumped compared with a few days ago?
 * Uses the daily rollup (peak per day). Skipped when the card was replaced in between,
 * since a new card restarts the count. Returns the rise or null.
 */
async function detectSurge(deviceSerial, now = new Date()) {
    const todayKey = dayKeyOf(now);
    const baseKey = dayKeyOf(now.getTime() - SURGE_DAYS * DAY_MS);
    const rows = await DailyStat.find({ deviceSerial, day: { $in: [todayKey, baseKey] } }).select('day peak').lean();
    const today = rows.find(r => r.day === todayKey)?.peak;
    const base = rows.find(r => r.day === baseKey)?.peak;
    if (today === undefined || base === undefined) return null;
    if (today < SURGE_MIN_COUNT || today - base < SURGE_MIN_INCREASE || today < base * SURGE_RATIO) return null;

    const cardChanged = await MaintenanceEvent.exists({
        deviceSerial,
        type: 'card_replaced',
        at: { $gte: new Date(now.getTime() - (SURGE_DAYS + 1) * DAY_MS), $lte: now }
    });
    if (cardChanged) return null;
    return { previous: base, count: today, days: SURGE_DAYS, pct: base > 0 ? Math.round(((today - base) / base) * 100) : 100 };
}

/**
 * After an AI result: tell the camera's people about a sudden rise (once a day per camera).
 * Never throws.
 */
async function checkSurge(deviceSerial, now = new Date()) {
    try {
        const surge = await detectSurge(deviceSerial, now);
        if (!surge) return [];
        const camera = await Camera.findOne({ deviceSerial }).select('deviceName').lean();
        return await notificationService.notifyCameraOwners(deviceSerial, 'pest_surge', () => ({
            deviceName: camera?.deviceName || deviceSerial,
            ...surge
        }));
    } catch (err) {
        console.error(`⚠️ Surge check failed (${deviceSerial}):`, err.message);
        return [];
    }
}

module.exports = {
    SURGE_DAYS,
    detectSurge,
    checkSurge
};
