const { Farm, Plot, Camera, User } = require('../models');
const { isAdmin, roleOf } = require('../constants/roles');
const notificationService = require('./notificationService');
const { latestProcessedByCamera } = require('./snapshotQueries');
const dailyStats = require('./dailyStats');
const { thresholdOf, riskLevel, worstRisk } = require('../constants/risk');

/**
 * Farms and plots.
 * Access: the owner (while admin/manager) and admins edit; people the farm is shared with view.
 * Sharing a farm = view access to every camera in it: each camera gets share entries marked
 * viaFarm, kept in step by syncFarmShares whenever the farm's shares or cameras change.
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
const ownerIdOf = (farm) => String(farm.ownerId?._id ?? farm.ownerId);

// orgId -> role, put on req.user by orgService.attachOrgRoles
const orgRoleIn = (user, farm) => (farm.orgId && user?.orgRoles?.get(String(farm.orgId))) || null;

// Simulated demo farms follow the camera rules of utils/ownership.js viewFilter: signed-in requests
// only (a User document in a background job never sees them), and the demo organization's farms
// for visitors with demo access (req.user.demoOrgId)
const isRequestUser = (user) => Array.isArray(user?.demoSerials);
const realOnly = (filter) => ({ $and: [filter, { simulated: { $ne: true } }] });

function farmViewFilter(user) {
    if (isAdmin(user)) return isRequestUser(user) ? {} : realOnly({});
    const id = idOf(user);
    if (!id) return { _id: null };
    const orgIds = [...(user.orgRoles?.keys() || [])];
    const base = { $or: [{ ownerId: id }, { 'sharedWith.userId': id }, ...(orgIds.length ? [{ orgId: { $in: orgIds } }] : [])] };
    const scope = require('./workspaceService').scopeFilter(user, { ownerField: 'ownerId' });
    const own = scope ? { $and: [base, scope] } : base;
    if (!isRequestUser(user)) return realOnly(own);
    return user.demoOrgId ? { $or: [own, { orgId: String(user.demoOrgId), simulated: true }] } : own;
}

function canViewFarm(user, farm) {
    if (!farm) return false;
    if (isAdmin(user)) return true;
    const id = idOf(user);
    // The simulated demo farm, for visitors with demo access (read-only: canEditFarm stays false)
    if (farm.simulated && user.demoOrgId && String(farm.orgId?._id ?? farm.orgId ?? '') === String(user.demoOrgId)) return true;
    return ownerIdOf(farm) === id || !!orgRoleIn(user, farm) || (farm.sharedWith || []).some(sh => sh.userId && String(sh.userId) === id);
}

// Sharing a farm with outsiders: its owner and admins (not organization managers)
function canShareFarm(user, farm) {
    if (!farm) return false;
    if (isAdmin(user)) return true;
    return ownerIdOf(farm) === idOf(user);
}

function canEditFarm(user, farm) {
    if (!farm) return false;
    if (isAdmin(user)) return true;
    // Its owner, and the owners and managers of its workspace
    return ownerIdOf(farm) === idOf(user) || ['owner', 'manager'].includes(orgRoleIn(user, farm));
}

/**
 * Cameras that may go into this farm's plots: the farm owner's own cameras and the cameras of
 * the farm's organization (an admin-owned farm may hold any camera).
 */
async function assignableFilter(farm) {
    const owner = await User.findById(ownerIdOf(farm)).select('role');
    if (roleOf(owner) === 'admin') return {};
    return farm.orgId ? { $or: [{ userId: ownerIdOf(farm) }, { orgId: farm.orgId }] } : { userId: ownerIdOf(farm) };
}

/**
 * Make the cameras' viaFarm share entries match the farm's share list.
 * Also removes them from cameras that left the farm.
 */
async function syncFarmShares(farm) {
    const farmId = farm._id;
    // Cameras no longer in this farm lose its shares
    await Camera.updateMany(
        { farmId: { $ne: farmId }, 'sharedWith.viaFarm': farmId },
        { $pull: { sharedWith: { viaFarm: farmId } } }
    );
    const cameras = await Camera.find({ farmId }).populate('userId', 'email');
    for (const camera of cameras) {
        const ownerEmail = camera.userId?.email?.toLowerCase();
        const desired = (farm.sharedWith || []).filter(sh => sh.email !== ownerEmail);
        const kept = (camera.sharedWith || []).filter(sh => !sh.viaFarm || String(sh.viaFarm) !== String(farmId));
        camera.sharedWith = [
            ...kept,
            ...desired.map(sh => ({ userId: sh.userId || null, email: sh.email, sharedBy: farm.ownerId?._id || farm.ownerId, sharedAt: sh.sharedAt, viaFarm: farmId }))
        ];
        await camera.save();
    }
    return cameras.length;
}

async function plotStats(plots, cameras) {
    const serials = cameras.map(c => c.deviceSerial);
    const [latest, rollup] = await Promise.all([
        latestProcessedByCamera(serials),
        dailyStats.rows(serials, dailyStats.startKeyForDays(7))
    ]);
    return plots.map(plot => {
        const own = cameras.filter(c => String(c.plotId) === String(plot._id));
        const counts = own.map(c => notificationService.countPests(latest.get(c.deviceSerial)?.summary));
        const total = counts.reduce((a, b) => a + b, 0);
        const ownSerials = new Set(own.map(c => c.deviceSerial));
        return {
            plotId: String(plot._id),
            cameras: own.length,
            online: own.filter(c => c.status === 1).length,
            latestTotal: total,
            latestAverage: own.length ? Math.round((total / own.length) * 10) / 10 : 0,
            latestMax: counts.length ? Math.max(...counts) : 0,
            risk: worstRisk(own.map((c, i) => riskLevel(counts[i], thresholdOf(c)))),
            insects7d: rollup.filter(r => ownSerials.has(r.deviceSerial)).reduce((s, r) => s + r.peak, 0)
        };
    });
}

/**
 * After an AI result: plot alert when the average latest count of the plot's traps
 * reaches the plot's threshold. Sent to the farm owner and the people it is shared with.
 */
async function checkPlotThreshold(deviceSerial) {
    try {
        const camera = await Camera.findOne({ deviceSerial }).select('plotId farmId').lean();
        if (!camera?.plotId) return [];
        const plot = await Plot.findById(camera.plotId).lean();
        if (!plot?.alertThreshold) return [];
        const farm = await Farm.findById(plot.farmId).lean();
        if (!farm) return [];
        const cameras = await Camera.find({ plotId: plot._id }).select('deviceSerial').lean();
        const latest = await latestProcessedByCamera(cameras.map(c => c.deviceSerial));
        const counts = cameras.map(c => notificationService.countPests(latest.get(c.deviceSerial)?.summary));
        const average = counts.length ? Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10 : 0;
        if (average < plot.alertThreshold) return [];

        const recipients = [farm.ownerId, ...(farm.sharedWith || []).map(sh => sh.userId)].filter(Boolean).map(String);
        const created = [];
        for (const userId of [...new Set(recipients)]) {
            const n = await notificationService.notifyUser({
                userId,
                type: 'plot_threshold',
                // Cool-down per plot
                deviceSerial: `plot:${plot._id}`,
                params: { plotName: plot.name, farmName: farm.name, farmId: String(farm._id), average, threshold: plot.alertThreshold }
            });
            if (n) created.push(n);
        }
        return created;
    } catch (err) {
        console.error(`⚠️ Plot alert check failed (${deviceSerial}):`, err.message);
        return [];
    }
}

/**
 * Take cameras out of their farm (plot deleted, farm deleted, camera moved to another owner).
 */
async function unassignCameras(filter) {
    const cameras = await Camera.find(filter).select('farmId').lean();
    const farmIds = [...new Set(cameras.filter(c => c.farmId).map(c => String(c.farmId)))];
    await Camera.updateMany(filter, { $set: { farmId: null, plotId: null } });
    for (const farmId of farmIds) {
        await Camera.updateMany({ farmId: { $ne: farmId }, 'sharedWith.viaFarm': farmId }, { $pull: { sharedWith: { viaFarm: farmId } } });
    }
}

module.exports = {
    farmViewFilter,
    canViewFarm,
    canShareFarm,
    canEditFarm,
    assignableFilter,
    syncFarmShares,
    plotStats,
    checkPlotThreshold,
    unassignCameras
};
