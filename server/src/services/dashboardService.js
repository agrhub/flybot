const { Camera, Snapshot, User } = require('../models');
const { isAdmin, roleOf, canBuildDashboards } = require('../constants/roles');
const { viewFilter } = require('../utils/ownership');
const { pestCountExpr, normalizeSpeciesExpr, NON_PEST_LABELS } = require('../constants/species');
const { thresholdOf, riskLevel } = require('../constants/risk');
const { TIMEZONE } = require('./captureSchedule');

/**
 * Dashboard access rules:
 *  - view: the owner, people it is shared with, and admins (public ones: anyone with the link)
 *  - edit: admins, and the owner while they may build dashboards (admin/manager)
 * Camera data shown on a dashboard is limited to:
 *  - public link:  cameras the owner owns (an admin owner: any camera)
 *  - signed in:    the above, plus cameras the viewer can see anyway
 * so sharing a dashboard never leaks a camera that was only shared with its owner.
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
// ownerId may be populated
const ownerIdOf = (dashboard) => String(dashboard.ownerId?._id ?? dashboard.ownerId);

function dashboardViewFilter(user) {
    if (isAdmin(user)) return {};
    const id = idOf(user);
    if (!id) return { _id: null };
    return { $or: [{ ownerId: id }, { 'sharedWith.userId': id }] };
}

function canViewDashboard(user, dashboard) {
    if (!dashboard) return false;
    if (isAdmin(user)) return true;
    const id = idOf(user);
    return ownerIdOf(dashboard) === id || (dashboard.sharedWith || []).some(sh => sh.userId && String(sh.userId) === id);
}

function canEditDashboard(user, dashboard) {
    if (!dashboard) return false;
    if (isAdmin(user)) return true;
    return canBuildDashboards(user) && ownerIdOf(dashboard) === idOf(user);
}

function accessOf(user, dashboard) {
    if (ownerIdOf(dashboard) === idOf(user)) return 'owner';
    if ((dashboard.sharedWith || []).some(sh => sh.userId && String(sh.userId) === idOf(user))) return 'shared';
    return 'admin';
}

/**
 * Serials (among `serials`) the owner may publish: their own cameras, or any camera for an admin.
 */
async function ownerPublishableSerials(owner, serials) {
    if (!owner || owner.disabled || !serials.length) return [];
    const filter = { deviceSerial: { $in: serials } };
    if (roleOf(owner) !== 'admin') filter.userId = owner._id;
    const cams = await Camera.find(filter).select('deviceSerial');
    return cams.map(c => c.deviceSerial);
}

/**
 * Cameras whose data this audience may see on the dashboard. `viewer` is null for the public link.
 */
async function effectiveSerials(dashboard, viewer) {
    const serials = dashboard.cameraSerials || [];
    if (!serials.length) return [];
    const owner = await User.findById(ownerIdOf(dashboard)).select('role disabled');
    const allowed = new Set(await ownerPublishableSerials(owner, serials));
    if (viewer) {
        const own = await Camera.find({ deviceSerial: { $in: serials }, ...viewFilter(viewer) }).select('deviceSerial');
        own.forEach(c => allowed.add(c.deviceSerial));
    }
    // Keep the dashboard's order
    return serials.filter(s => allowed.has(s));
}

// --- Widget data -----------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(date); // YYYY-MM-DD
const sinceDays = (days) => new Date(Date.now() - days * DAY_MS);

const matchScans = (serials, days) => ({
    $match: { deviceSerial: { $in: serials }, aiProcessed: true, createdAt: { $gte: sinceDays(days) } }
});

// Sticky traps accumulate insects: per camera per day keep the peak scan, then add cameras up
const dailyPeakStages = [
    {
        $project: {
            deviceSerial: 1,
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TIMEZONE } },
            count: pestCountExpr()
        }
    },
    { $group: { _id: { day: '$day', camera: '$deviceSerial' }, peak: { $max: '$count' }, scans: { $sum: 1 } } }
];

async function latestPerCamera(serials) {
    if (!serials.length) return new Map();
    const rows = await Snapshot.aggregate([
        { $match: { deviceSerial: { $in: serials }, aiProcessed: true } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$deviceSerial', createdAt: { $first: '$createdAt' }, s3Key: { $first: '$s3Key' }, count: { $first: pestCountExpr() } } }
    ]);
    return new Map(rows.map(r => [r._id, r]));
}

async function kpiData(cameras, serials, days) {
    const [rows, latest] = await Promise.all([
        Snapshot.aggregate([matchScans(serials, days), ...dailyPeakStages]),
        latestPerCamera(serials)
    ]);
    const alertCameras = cameras.filter(c => (latest.get(c.deviceSerial)?.count || 0) >= thresholdOf(c)).length;
    return {
        cameras: cameras.length,
        online: cameras.filter(c => c.status === 1).length,
        alertCameras,
        scans: rows.reduce((sum, r) => sum + r.scans, 0),
        totalPests: rows.reduce((sum, r) => sum + r.peak, 0),
        peak: rows.reduce((max, r) => Math.max(max, r.peak), 0)
    };
}

async function trendData(serials, days) {
    const rows = await Snapshot.aggregate([
        matchScans(serials, days),
        ...dailyPeakStages,
        { $group: { _id: '$_id.day', value: { $sum: '$peak' } } }
    ]);
    const byDay = new Map(rows.map(r => [r._id, r.value]));
    // Every day of the window, so gaps show as zero
    const points = [];
    for (let i = days - 1; i >= 0; i--) {
        const date = dayKey(new Date(Date.now() - i * DAY_MS));
        points.push({ date, value: byDay.get(date) || 0 });
    }
    return { points };
}

async function speciesData(serials, days) {
    const rows = await Snapshot.aggregate([
        matchScans(serials, days),
        {
            $project: {
                deviceSerial: 1,
                day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TIMEZONE } },
                entries: { $objectToArray: { $ifNull: ['$aiResults.summary', {}] } }
            }
        },
        { $unwind: '$entries' },
        { $addFields: { species: normalizeSpeciesExpr('$entries.k') } },
        { $match: { species: { $nin: NON_PEST_LABELS } } },
        { $group: { _id: { day: '$day', camera: '$deviceSerial', species: '$species' }, peak: { $max: { $ifNull: ['$entries.v', 0] } } } },
        { $group: { _id: '$_id.species', value: { $sum: '$peak' } } },
        { $match: { value: { $gt: 0 } } },
        { $sort: { value: -1 } }
    ]);
    return { species: rows.map(r => ({ label: r._id, value: r.value })) };
}

async function cameraRankingData(cameras, serials, days) {
    const [rows, latest] = await Promise.all([
        Snapshot.aggregate([
            matchScans(serials, days),
            ...dailyPeakStages,
            { $group: { _id: '$_id.camera', total: { $sum: '$peak' }, peak: { $max: '$peak' } } }
        ]),
        latestPerCamera(serials)
    ]);
    const byCamera = new Map(rows.map(r => [r._id, r]));
    const ranking = cameras.map(c => {
        const latestCount = latest.get(c.deviceSerial)?.count || 0;
        return {
            deviceSerial: c.deviceSerial,
            deviceName: c.deviceName,
            total: byCamera.get(c.deviceSerial)?.total || 0,
            peak: byCamera.get(c.deviceSerial)?.peak || 0,
            latestCount,
            risk: riskLevel(latestCount, thresholdOf(c))
        };
    });
    ranking.sort((a, b) => b.total - a.total || b.latestCount - a.latestCount);
    return { cameras: ranking };
}

async function latestSnapshotData(cameras, serials, imageUrl) {
    const latest = await latestPerCamera(serials);
    return {
        snapshots: cameras.map(c => {
            const snap = latest.get(c.deviceSerial);
            const count = snap?.count || 0;
            return {
                deviceSerial: c.deviceSerial,
                deviceName: c.deviceName,
                status: c.status,
                createdAt: snap?.createdAt || null,
                count,
                risk: riskLevel(count, thresholdOf(c)),
                imageUrl: snap?.s3Key ? imageUrl(snap.s3Key) : null
            };
        })
    };
}

/**
 * Data for every widget, keyed by widget id. `serials` are the cameras this audience may see;
 * `imageUrl(s3Key)` builds the image link (signed-in proxy or public-link proxy).
 */
async function computeWidgetData(dashboard, serials, { imageUrl }) {
    const cameras = serials.length
        ? await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName status alertThreshold')
        : [];
    const cameraBySerial = new Map(cameras.map(c => [c.deviceSerial, c]));
    const allowed = new Set(serials);

    const entries = await Promise.all((dashboard.widgets || []).map(async (widget) => {
        const scoped = widget.cameraSerials?.length ? widget.cameraSerials.filter(s => allowed.has(s)) : serials;
        const scopedCameras = scoped.map(s => cameraBySerial.get(s)).filter(Boolean);
        const days = widget.rangeDays || 7;
        let data;
        switch (widget.type) {
            case 'kpi': data = await kpiData(scopedCameras, scoped, days); break;
            case 'trend': data = await trendData(scoped, days); break;
            case 'species': data = await speciesData(scoped, days); break;
            case 'cameraRanking': data = await cameraRankingData(scopedCameras, scoped, days); break;
            case 'latestSnapshot': data = await latestSnapshotData(scopedCameras, scoped, imageUrl); break;
            default: data = null;
        }
        return [widget.id, data];
    }));
    return Object.fromEntries(entries);
}

module.exports = {
    dashboardViewFilter,
    canViewDashboard,
    canEditDashboard,
    accessOf,
    ownerPublishableSerials,
    effectiveSerials,
    computeWidgetData
};
