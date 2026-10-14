const { Camera, Treatment, User } = require('../models');
const catchStats = require('./catchStats');
const { latestProcessedByCamera, latestSnapshotTimeByCamera } = require('./snapshotQueries');
const { thresholdOf } = require('../constants/risk');
const { isSticky } = require('../constants/trap');
const { ftdOver: ftdOf, ftdChange: change } = catchStats;
const { countPests } = require('./notificationService');

/**
 * A cooperative's growers side by side: for each member, the organization's cameras they own,
 * flies per trap per day (FTD) over a period against the period before, traps at their alert
 * threshold, cameras without a photo for a day, and the last treatment they logged. Members
 * whose traps are busy but who logged nothing in the period are flagged, for a field visit.
 */
const PERIODS = [7, 30];
const DEFAULT_PERIOD = 7;
const SILENT_MS = 24 * 60 * 60 * 1000;


async function orgOverview(org, days = DEFAULT_PERIOD, now = new Date()) {
    const period = PERIODS.includes(days) ? days : DEFAULT_PERIOD;
    const cameras = await Camera.find({ orgId: org._id })
        .select('deviceSerial deviceName userId alertThreshold trapKind status').lean();
    const serials = cameras.map(c => c.deviceSerial);
    const owners = [...new Set(cameras.map(c => String(c.userId)))];

    const [{ dayKeys, cameras: catches }, latest, lastPhoto, treatments, users] = await Promise.all([
        catchStats.catchesBySerial(serials, period * 2, now),
        latestProcessedByCamera(serials),
        latestSnapshotTimeByCamera(serials),
        Treatment.aggregate([
            { $match: { cameraSerials: { $in: serials } } },
            { $unwind: '$cameraSerials' },
            { $match: { cameraSerials: { $in: serials } } },
            { $group: { _id: '$cameraSerials', lastAt: { $max: '$at' } } }
        ]),
        User.find({ _id: { $in: owners } }).select('name email').lean()
    ]);
    const current = dayKeys.slice(-period);
    const previous = dayKeys.slice(-period * 2, -period);
    const lastTreatment = new Map(treatments.map(t => [t._id, t.lastAt]));
    const userById = new Map(users.map(u => [String(u._id), u]));
    const fromTime = new Date(`${current[0]}T00:00:00+07:00`).getTime();

    // One row per member; members without a camera here still show (with no figures)
    const rows = new Map();
    const rowFor = (userId, email) => {
        const key = userId ? String(userId) : `email:${email}`;
        if (!rows.has(key)) {
            const user = userId ? userById.get(String(userId)) : null;
            const member = org.members.find(m => (userId && String(m.userId) === String(userId)) || m.email === (user?.email || email));
            rows.set(key, {
                userId: userId ? String(userId) : null,
                name: user?.name || '',
                email: user?.email || email || member?.email || '',
                role: member?.role || null,
                // A camera left in the organization by someone who is no longer a member:
                // its figures count, but they are never reminded or listed for a visit
                member: !!member,
                serials: [],
                cameras: 0,
                silent: 0,
                atThreshold: 0,
                lastPhotoAt: null,
                lastTreatmentAt: null
            });
        }
        return rows.get(key);
    };
    for (const m of org.members) rowFor(m.userId, m.email);

    for (const cam of cameras) {
        const row = rowFor(cam.userId);
        row.serials.push(cam.deviceSerial);
        row.cameras++;
        const photoAt = lastPhoto.get(cam.deviceSerial) || null;
        if (!photoAt || now - new Date(photoAt) > SILENT_MS) row.silent++;
        if (photoAt && (!row.lastPhotoAt || photoAt > row.lastPhotoAt)) row.lastPhotoAt = photoAt;
        // Sticky traps: the latest count against the threshold; lure traps: today's catch
        const snap = latest.get(cam.deviceSerial);
        const level = isSticky(cam) ? (snap?.summary ? countPests(snap.summary) : 0) : (catches.get(cam.deviceSerial)?.total.get(dayKeys.at(-1)) ?? 0);
        if (level >= thresholdOf(cam)) row.atThreshold++;
        const treatedAt = lastTreatment.get(cam.deviceSerial);
        if (treatedAt && (!row.lastTreatmentAt || treatedAt > row.lastTreatmentAt)) row.lastTreatmentAt = treatedAt;
    }

    const members = [...rows.values()].map(({ serials: own, ...row }) => {
        const now7 = ftdOf(own, catches, current);
        const before = ftdOf(own, catches, previous);
        const treatedInPeriod = row.lastTreatmentAt && new Date(row.lastTreatmentAt).getTime() >= fromTime;
        return {
            ...row,
            ftd: now7.ftd,
            ftdPrevious: before.ftd,
            change: change(now7.ftd, before.ftd),
            total: now7.total,
            // Busy traps and nothing logged: worth a call or a visit
            needsVisit: row.member && row.atThreshold > 0 && !treatedInPeriod
        };
    }).sort((a, b) => (b.needsVisit - a.needsVisit) || ((b.ftd ?? -1) - (a.ftd ?? -1)) || a.email.localeCompare(b.email));

    const all = ftdOf(serials, catches, current);
    const allBefore = ftdOf(serials, catches, previous);
    return {
        days: period,
        from: current[0],
        to: current.at(-1),
        totals: {
            members: members.length,
            cameras: cameras.length,
            ftd: all.ftd,
            ftdPrevious: allBefore.ftd,
            change: change(all.ftd, allBefore.ftd),
            atThreshold: members.reduce((s, m) => s + m.atThreshold, 0),
            silent: members.reduce((s, m) => s + m.silent, 0),
            needsVisit: members.filter(m => m.needsVisit).length
        },
        members
    };
}

module.exports = {
    PERIODS,
    orgOverview
};
