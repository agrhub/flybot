const { Treatment, Camera, User } = require('../models');
const { getViewableSerials } = require('../utils/ownership');
const notificationService = require('./notificationService');
const { FARM_OFFSET_MS, farmDateTime } = require('../utils/farmTime');

/**
 * Pre-harvest intervals (PHI) of the logged treatments: which areas cannot be harvested yet,
 * and a reminder on the morning harvest is allowed again.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// The longest interval accepted when logging a treatment
const MAX_PHI_DAYS = 365;
// A reminder that could not go out (server down) is still sent this long after the date
const LATE_REMINDER_MS = 3 * DAY_MS;

/** When harvest is allowed again after this treatment, or null without an interval. */
function harvestAllowedFrom(treatment) {
    if (!Number.isInteger(treatment.preHarvestDays)) return null;
    return new Date(new Date(treatment.at).getTime() + treatment.preHarvestDays * DAY_MS);
}


/** The end of the farm day `now` falls in. */
function endOfFarmDay(now) {
    const local = new Date(now.getTime() + FARM_OFFSET_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - FARM_OFFSET_MS - 1);
}

async function trapNames(serials) {
    const cameras = await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName').lean();
    return new Map(cameras.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
}

/**
 * Treatments on the viewer's traps still inside their interval, the soonest to end first.
 */
async function activeWithholding(user, now = new Date()) {
    const visible = await getViewableSerials(user);
    if (!visible.length) return [];
    const rows = await Treatment.find({
        cameraSerials: { $in: visible },
        preHarvestDays: { $gt: 0 },
        at: { $gte: new Date(now.getTime() - MAX_PHI_DAYS * DAY_MS), $lte: now }
    }).lean();
    const active = rows
        .map(r => ({ row: r, until: harvestAllowedFrom(r) }))
        .filter(({ until }) => until > now)
        .sort((a, b) => a.until - b.until);
    if (!active.length) return [];
    const seen = new Set(visible);
    const names = await trapNames([...new Set(active.flatMap(({ row }) => row.cameraSerials.filter(s => seen.has(s))))]);
    return active.map(({ row, until }) => ({
        id: String(row._id),
        type: row.type,
        product: row.product,
        area: row.area,
        at: row.at,
        preHarvestDays: row.preHarvestDays,
        harvestAllowedFrom: until,
        traps: row.cameraSerials.filter(s => seen.has(s)).map(s => names.get(s) || s)
    }));
}

/**
 * Who hears that harvest is allowed: everyone who sees one of the treated traps and has not
 * muted all of the ones they see. Returns [{ userId, serials }].
 */
async function recipientsOf(treatment) {
    const cameras = await Camera.find({ deviceSerial: { $in: treatment.cameraSerials } }).select('deviceSerial userId sharedWith').lean();
    const byUser = new Map();
    for (const camera of cameras) {
        for (const id of [camera.userId, ...(camera.sharedWith || []).map(sh => sh.userId)].filter(Boolean).map(String)) {
            if (!byUser.has(id)) byUser.set(id, []);
            byUser.get(id).push(camera.deviceSerial);
        }
    }
    if (!byUser.size) return [];
    const users = await User.find({ _id: { $in: [...byUser.keys()] }, disabled: { $ne: true } }).select('notificationPrefs.mutedCameras').lean();
    return users
        .map(u => {
            const muted = new Set(u.notificationPrefs?.mutedCameras || []);
            return { userId: String(u._id), serials: byUser.get(String(u._id)).filter(s => !muted.has(s)) };
        })
        .filter(r => r.serials.length);
}

/**
 * Morning job: for every treatment whose interval ends today (or ended in the last days without
 * a reminder), tell the people who see its traps. Each treatment is claimed before sending, so
 * two servers never both send it. Returns { sent } (treatments reminded).
 */
async function sendHarvestReminders(now = new Date()) {
    const endOfToday = endOfFarmDay(now);
    const candidates = await Treatment.find({
        preHarvestDays: { $gt: 0 },
        harvestNotifiedAt: null,
        at: { $gte: new Date(now.getTime() - MAX_PHI_DAYS * DAY_MS - LATE_REMINDER_MS), $lte: now }
    }).lean();
    let sent = 0;
    for (const treatment of candidates) {
        const until = harvestAllowedFrom(treatment);
        if (until > endOfToday || until < new Date(now.getTime() - LATE_REMINDER_MS)) continue;
        const claimed = await Treatment.updateOne({ _id: treatment._id, harvestNotifiedAt: null }, { $set: { harvestNotifiedAt: now } });
        if (!claimed.modifiedCount) continue;
        try {
            const recipients = await recipientsOf(treatment);
            const names = await trapNames(treatment.cameraSerials);
            for (const { userId, serials } of recipients) {
                const traps = serials.map(s => names.get(s) || s).join(', ');
                await notificationService.notifyUser({
                    userId,
                    type: 'harvest_ready',
                    params: {
                        treatmentId: String(treatment._id),
                        product: treatment.product || '',
                        // Without an area name, the traps say where
                        area: treatment.area || traps,
                        traps,
                        date: farmDateTime(until),
                        days: treatment.preHarvestDays
                    }
                });
            }
            sent++;
        } catch (err) {
            console.error(`⚠️ Harvest reminder failed (${treatment._id}):`, err.message);
        }
    }
    if (sent) console.log(`🧺 Harvest reminders sent: ${sent}`);
    return { sent };
}

module.exports = {
    harvestAllowedFrom,
    activeWithholding,
    sendHarvestReminders
};
