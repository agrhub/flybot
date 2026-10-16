const env = require('../config/env');
const { isAdmin } = require('../constants/roles');

/**
 * What an account may use — the one place every demo / plan limit is read from (camera claims,
 * photos a day, live view minutes, deep analysis, the unclaimed-camera cap). Today every account
 * is on the "free" demo plan with the DEMO_* defaults, except the operator's accounts (admins and
 * DEMO_EXEMPT_EMAILS), which are "unlimited". When subscription plans (FREE / PRO / ENTERPRISE)
 * arrive, only this module changes: callers ask for entitlements, never for roles.
 *
 * Limits are numbers; `null` means no limit.
 */
const UNLIMITED = Object.freeze({
    plan: 'unlimited',
    // Self-registered (demo) cameras this account may claim
    maxCameras: null,
    // Photos per camera in any 24 hours (self-registered cameras)
    snapshotsPerDay: null,
    // Minutes of live view per request (self-registered cameras)
    liveMinutes: null,
    // LLM deep analysis (analyze_photo_deep) of claimed cameras
    deepAnalysis: true
});

function operatorAccount(user) {
    if (!user) return false;
    return isAdmin(user) || env.DEMO_EXEMPT_EMAILS.includes(String(user.email || '').toLowerCase());
}

/** The entitlements of `user` ({ role, email } or a User document; null = no account). */
function getEntitlements(user) {
    if (operatorAccount(user)) return { ...UNLIMITED };
    return {
        plan: 'free',
        maxCameras: env.DEMO_MAX_CAMERAS_PER_USER,
        snapshotsPerDay: env.DEMO_MAX_SNAPSHOTS_PER_DAY,
        liveMinutes: env.DEMO_LIVE_MINUTES,
        deepAnalysis: true
    };
}

/** Entitlements of a camera's owner (loaded by id); an unowned camera gets the free plan. */
async function entitlementsOfOwner(camera) {
    if (!camera?.userId) return getEntitlements(null);
    const { User } = require('../models');
    const owner = await User.findById(camera.userId).select('role email').lean();
    return getEntitlements(owner);
}

/**
 * Limits that belong to the system rather than an account: cameras waiting to be claimed, and
 * how often an unclaimed camera may upload.
 */
function systemLimits() {
    return {
        maxUnclaimed: env.DEMO_MAX_UNCLAIMED,
        unclaimedPhotoEveryMinutes: 60,
        unclaimedPhotoTtlHours: 24,
        unclaimedCameraTtlDays: 7
    };
}

/** `asked`, capped by a limit (null = no cap). */
const capped = (asked, limit) => (limit === null || limit === undefined ? asked : Math.min(asked, limit));

module.exports = {
    getEntitlements,
    entitlementsOfOwner,
    systemLimits,
    capped
};
