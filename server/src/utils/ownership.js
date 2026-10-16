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
    // Self-registered cameras nobody claimed yet are hidden from every account (admins too)
    if (isAdmin(user)) return { unclaimed: { $ne: true } };
    const id = idOf(user);
    if (!id) return { _id: null }; // matches nothing
    const base = { $or: [{ userId: id }, { 'sharedWith.userId': id }] };
    // More than one workspace: only the current one's cameras (services/workspaceService.js)
    const scope = require('../services/workspaceService').scopeFilter(user, { ownerField: 'userId' });
    return scope ? { $and: [base, scope] } : base;
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
    if (camera.unclaimed) return false; // nobody's yet: only the claim flow touches it
    if (isAdmin(user)) return true;
    const id = idOf(user);
    // The camera's owner runs it (their workspace role decides whether they could add it)
    if (camera.userId && String(camera.userId) === id) return true;
    // Organization owners and managers (share entries kept by services/orgService.js)
    return (camera.sharedWith || []).some(sh => sh.viaOrg && String(sh.userId) === id && ['owner', 'manager'].includes(sh.orgRole));
}

/**
 * Actions that hand out or take away the camera itself (delete, share with outsiders, move it
 * to another organization): the owner (a manager) and admins only. Organization managers run
 * the camera day to day but cannot give it away.
 */
function isCameraOwner(user, camera) {
    if (!camera) return false;
    if (camera.unclaimed) return false; // nobody's yet: only the claim flow touches it
    if (isAdmin(user)) return true;
    return !!camera.userId && String(camera.userId) === idOf(user);
}

async function findOwnedCamera(user, deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial });
    return isCameraOwner(user, camera) ? camera : null;
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
    isCameraOwner,
    findOwnedCamera,
    findManageableCamera,
    canManageSerial
};
