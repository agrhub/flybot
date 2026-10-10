const { Camera, User } = require('../models');
const { isAdmin, roleOf, canBuildDashboards } = require('../constants/roles');
const { viewFilter } = require('../utils/ownership');
const { thresholdOf, riskLevel } = require('../constants/risk');
const { latestProcessedByCamera } = require('./snapshotQueries');
const { countPests } = require('./notificationService');
const dailyStats = require('./dailyStats');

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

// Widgets read the daily rollup (services/dailyStats.js): "last N days" = N local days, today included.
// Sticky traps accumulate insects, so a camera's day counts with its peak scan; cameras add up.
const daysRows = (serials, days) => dailyStats.rows(serials, dailyStats.startKeyForDays(days));

// Latest processed snapshot per camera, with its pest count (one DISTINCT_SCAN query)
async function latestPerCamera(serials) {
    const latest = await latestProcessedByCamera(serials);
    for (const row of latest.values()) row.count = countPests(row.summary);
    return latest;
}

async function kpiData(cameras, serials, days, latest) {
    const rows = await daysRows(serials, days);
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
    const rows = await daysRows(serials, days);
    const byDay = new Map();
    for (const r of rows) byDay.set(r.day, (byDay.get(r.day) || 0) + r.peak);
    // Every day of the window, so gaps show as zero
    const points = [];
    for (let i = days - 1; i >= 0; i--) {
        const date = dailyStats.dayKeyOf(Date.now() - i * dailyStats.DAY_MS);
        points.push({ date, value: byDay.get(date) || 0 });
    }
    return { points };
}

async function speciesData(serials, days) {
    const rows = await daysRows(serials, days);
    return {
        species: dailyStats.speciesTotals(rows, 'peak')
            .filter(sp => sp.value > 0)
            .map(sp => ({ label: sp.name, value: sp.value }))
    };
}

async function cameraRankingData(cameras, serials, days, latest) {
    const rows = await daysRows(serials, days);
    const byCamera = new Map();
    for (const r of rows) {
        const entry = byCamera.get(r.deviceSerial) || { total: 0, peak: 0 };
        entry.total += r.peak;
        entry.peak = Math.max(entry.peak, r.peak);
        byCamera.set(r.deviceSerial, entry);
    }
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

async function latestSnapshotData(cameras, latest, imageUrl) {
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
    // Shared by the kpi, ranking and snapshot widgets: query once, only if one of them is present
    const needsLatest = (dashboard.widgets || []).some(w => ['kpi', 'cameraRanking', 'latestSnapshot'].includes(w.type));
    const latest = needsLatest ? await latestPerCamera(serials) : new Map();

    const entries = await Promise.all((dashboard.widgets || []).map(async (widget) => {
        const scoped = widget.cameraSerials?.length ? widget.cameraSerials.filter(s => allowed.has(s)) : serials;
        const scopedCameras = scoped.map(s => cameraBySerial.get(s)).filter(Boolean);
        const days = widget.rangeDays || 7;
        let data;
        switch (widget.type) {
            case 'kpi': data = await kpiData(scopedCameras, scoped, days, latest); break;
            case 'trend': data = await trendData(scoped, days); break;
            case 'species': data = await speciesData(scoped, days); break;
            case 'cameraRanking': data = await cameraRankingData(scopedCameras, scoped, days, latest); break;
            case 'latestSnapshot': data = await latestSnapshotData(scopedCameras, latest, imageUrl); break;
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
