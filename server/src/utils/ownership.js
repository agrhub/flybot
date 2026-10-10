const { Camera } = require('../models');
const { isAdmin, roleOf } = require('../constants/roles');

/**
 * Camera access rules (one place for every controller, job and agent tool):
 *  - view:   the owner, people it is shared with, and admins
 *  - manage: admins, and managers who own it or are owner/manager of its organization
 *            (role "user" never manages)
 * `user` is req.user ({ id, role }) or a User document.
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');

function viewFilter(user) {
    if (isAdmin(user)) return {};
    const id = idOf(user);
    if (!id) return { _id: null }; // matches nothing
    return { $or: [{ userId: id }, { 'sharedWith.userId': id }] };
}

function viewableCameras(user, extra = {}) {
    return Camera.find({ ...extra, ...viewFilter(user) });
}

async function getViewableSerials(user) {
    const cams = await Camera.find(viewFilter(user)).select('deviceSerial');
    return cams.map(c => c.deviceSerial);
}

async function canViewSerial(user, deviceSerial) {
    if (!deviceSerial) return false;
    return !!(await Camera.exists({ deviceSerial, ...viewFilter(user) }));
}

function findViewableCamera(user, deviceSerial) {
    return Camera.findOne({ deviceSerial, ...viewFilter(user) });
}

function canManageCamera(user, camera) {
    if (!camera) return false;
    if (isAdmin(user)) return true;
    if (roleOf(user) !== 'manager') return false;
    const id = idOf(user);
    if (String(camera.userId) === id) return true;
    // Organization owners and managers (share entries kept by services/orgService.js)
    return (camera.sharedWith || []).some(sh => sh.viaOrg && String(sh.userId) === id && ['owner', 'manager'].includes(sh.orgRole));
}

async function findManageableCamera(user, deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial });
    return canManageCamera(user, camera) ? camera : null;
}

async function canManageSerial(user, deviceSerial) {
    return !!(await findManageableCamera(user, deviceSerial));
}

module.exports = {
    viewFilter,
    viewableCameras,
    getViewableSerials,
    canViewSerial,
    findViewableCamera,
    canManageCamera,
    findManageableCamera,
    canManageSerial
};
