const { Camera } = require('../models');
const { isAdmin, roleOf } = require('../constants/roles');

/**
 * Camera access rules (one place for every controller, job and agent tool):
 *  - view:   the owner, people it is shared with, admins, and (signed-in requests only) the
 *            read-only demo cameras of services/demoView.js (req.user.demoSerials, and every camera
 *            of the simulated demo organization, req.user.demoOrgId), with what each one opens to
 *            them (req.user.demoShares, demoPermsOf)
 *  - manage: admins, and managers who own it or are owner/manager of its organization
 *            (role "user" never manages; demo access never manages)
 * `user` is req.user ({ id, role }) or a User document.
 *
 * Simulated demo cameras (Camera.simulated, scripts/demo_sim.js) are seen in signed-in requests
 * only, always labeled: a User document (background jobs: reports, briefs, alerts, digests) never
 * sees them, so no email, message or report ever mixes them with real cameras.
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
const demoSerialsOf = (user) => (Array.isArray(user?.demoSerials) ? user.demoSerials : []);
const demoOrgOf = (user) => (user?.demoOrgId ? String(user.demoOrgId) : null);
const demoSharesOf = (user) => (user?.demoShares && typeof user.demoShares === 'object' ? user.demoShares : {});
// middlewares/auth.js always sets demoSerials on req.user; a User document has none
const isRequestUser = (user) => Array.isArray(user?.demoSerials);
const realOnly = (filter) => ({ $and: [filter, { simulated: { $ne: true } }] });

function viewFilter(user) {
    // Self-registered cameras nobody claimed yet are hidden from every account (admins too)
    if (isAdmin(user)) return isRequestUser(user) ? { unclaimed: { $ne: true } } : realOnly({ unclaimed: { $ne: true } });
    const id = idOf(user);
    if (!id) return { _id: null }; // matches nothing
    const base = { $or: [{ userId: id }, { 'sharedWith.userId': id }] };
    // More than one workspace: only the current one's cameras (services/workspaceService.js)
    const scope = require('../services/workspaceService').scopeFilter(user, { ownerField: 'userId' });
    const own = scope ? { $and: [base, scope] } : base;
    if (!isRequestUser(user)) return realOnly(own);
    // Demo cameras show in every workspace
    const demo = demoSerialsOf(user);
    const org = demoOrgOf(user);
    const extra = [
        ...(demo.length ? [{ deviceSerial: { $in: demo }, unclaimed: { $ne: true } }] : []),
        ...(org ? [{ orgId: org, simulated: true }] : [])
    ];
    return extra.length ? { $or: [own, ...extra] } : own;
}

/**
 * Does this person see the camera only through demo access (not its owner, not shared with
 * them, not an admin)? Such a viewer never manages it and opens only what demoPermsOf allows.
 */
function isDemoOnly(user, camera) {
    if (!camera || isAdmin(user)) return false;
    const viaSerial = demoSerialsOf(user).includes(camera.deviceSerial);
    const viaOrg = !!demoOrgOf(user) && !!camera.simulated && String(camera.orgId?._id ?? camera.orgId ?? '') === demoOrgOf(user);
    if (!viaSerial && !viaOrg) return false;
    const id = idOf(user);
    const ownerId = String(camera.userId?._id ?? camera.userId ?? '');
    if (ownerId === id) return false;
    return !(camera.sharedWith || []).some(sh => sh.userId && String(sh.userId?._id ?? sh.userId) === id);
}

// A simulated demo camera (made-up data, no device): everything but live view and recorded video
const SIMULATED_PERMS = Object.freeze({ live: false, playback: false, location: true, device: true, realSerial: true });
const NO_PERMS = Object.freeze({ live: false, playback: false, location: false, device: false, realSerial: false });

/**
 * What a person who sees the camera only through demo access may do with it (services/demoView.js
 * PERMISSIONS), or null for everyone else (owner, shared with them, admins): they have it all.
 */
function demoPermsOf(user, camera) {
    if (!isDemoOnly(user, camera)) return null;
    const shared = demoSharesOf(user)[camera.deviceSerial];
    if (shared) return shared;
    // Through the simulated organization only
    if (camera.simulated) return SIMULATED_PERMS;
    // An older request user with the serial list only
    return { ...NO_PERMS, live: !!user?.demoLive, playback: !!user?.demoLive, location: true, device: true, realSerial: true };
}

/** May this person see the camera's position, address and GPS fix? */
const canSeeLocation = (user, camera) => demoPermsOf(user, camera)?.location !== false;
/** ...its device details (CamOS status, battery, signal, network, firmware, log)? */
const canSeeDevice = (user, camera) => demoPermsOf(user, camera)?.device !== false;

/**
 * May this person open live view of the camera? Never for a simulated camera (there is no device)
 * or one an admin paused; demo viewers only when the admin opened it for that camera.
 */
const canWatchLive = (user, camera) => !camera?.simulated && !camera?.adminDisabled?.at && demoPermsOf(user, camera)?.live !== false;
/** ...its recorded video (EZVIZ SD card and cloud records)? Same rule, with the playback permission. */
const canWatchPlayback = (user, camera) => !camera?.simulated && !camera?.adminDisabled?.at && demoPermsOf(user, camera)?.playback !== false;

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
    demoPermsOf,
    canSeeLocation,
    canSeeDevice,
    canWatchLive,
    canWatchPlayback,
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
