const { Camera } = require('../models');
const { isAdmin, roleOf } = require('../constants/roles');

/**
 * Camera access rules (one place for every controller, job and agent tool):
 *  - view:   the owner, people it is shared with, admins, and (signed-in requests only) the
 *            read-only demo cameras of services/demoView.js (req.user.demoSerials)
 *  - manage: admins, and managers who own it or are owner/manager of its organization
 *            (role "user" never manages; demo access never manages)
 * `user` is req.user ({ id, role }) or a User document.
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
const demoSerialsOf = (user) => (Array.isArray(user?.demoSerials) ? user.demoSerials : []);

function viewFilter(user) {
    // Self-registered cameras nobody claimed yet are hidden from every account (admins too)
    if (isAdmin(user)) return { unclaimed: { $ne: true } };
    const id = idOf(user);
    if (!id) return { _id: null }; // matches nothing
    const base = { $or: [{ userId: id }, { 'sharedWith.userId': id }] };
    // More than one workspace: only the current one's cameras (services/workspaceService.js)
    const scope = require('../services/workspaceService').scopeFilter(user, { ownerField: 'userId' });
    const own = scope ? { $and: [base, scope] } : base;
    // Demo cameras show in every workspace
    const demo = demoSerialsOf(user);
    return demo.length ? { $or: [own, { deviceSerial: { $in: demo }, unclaimed: { $ne: true } }] } : own;
}

/**
 * Does this person see the camera only through demo access (not its owner, not shared with
 * them, not an admin)? Such a viewer never manages it and opens live view only with demoLive.
 */
function isDemoOnly(user, camera) {
    if (!camera || isAdmin(user) || !demoSerialsOf(user).includes(camera.deviceSerial)) return false;
    const id = idOf(user);
    const ownerId = String(camera.userId?._id ?? camera.userId ?? '');
    if (ownerId === id) return false;
    return !(camera.sharedWith || []).some(sh => sh.userId && String(sh.userId?._id ?? sh.userId) === id);
}

/** May this person open live view / SD playback of the camera (demo viewers: when demoLive is on)? */
const canWatchLive = (user, camera) => !isDemoOnly(user, camera) || !!user?.demoLive;

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
    isDemoOnly,
    canWatchLive,
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
