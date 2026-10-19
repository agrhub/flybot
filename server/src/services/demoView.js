const { isAdmin } = require('../constants/roles');

/**
 * Read-only demo cameras for visitors (for example competition judges): the admin names a few
 * cameras in Settings > System > Demo access (env DEMO_VIEW_* gives the first values) and every
 * account created on or after a date (or every account) may view them, as if they were shared
 * with it, without waiting for the owner to share them:
 *  - photos, counts, analytics, Sentinel traces and proposals, the chatbot: yes
 *    (utils/ownership.js viewFilter adds them for the signed-in request);
 *  - managing them (settings, capture, delete, share, maintenance, treatments, deciding a
 *    proposal): never, since the manage rules (canManageCamera, isCameraOwner) ignore this access;
 *  - live view and SD playback: only when the admin turns on demoViewLive.
 * Nothing is written to the cameras or the accounts: turning it off removes the access at once
 * (within the settings cache, 30 s). Only signed-in requests get it (middlewares/auth.js sets
 * req.user.demoSerials): background jobs (weekly report, morning brief, alerts, webhooks) read
 * the account itself and never send anything about demo cameras.
 */

/** The demo serials (and whether live view is open) for this account, from the effective settings. */
function accessFor(userDoc, settings) {
    const none = { serials: [], live: false };
    if (!userDoc || !settings?.demoViewEnabled || isAdmin(userDoc)) return none;
    const serials = Array.isArray(settings.demoViewCameras) ? settings.demoViewCameras : [];
    if (!serials.length) return none;
    if (settings.demoViewSince) {
        const created = userDoc.createdAt ? new Date(userDoc.createdAt).getTime() : NaN;
        if (!(created >= new Date(settings.demoViewSince).getTime())) return none;
    }
    return { serials: [...serials], live: !!settings.demoViewLive };
}

/** Same, reading the settings (cached). Never fails: a problem means no demo access. */
async function demoAccessOf(userDoc) {
    try {
        const settings = await require('./settingsService').getSettings();
        return accessFor(userDoc, settings);
    } catch (err) {
        console.warn('⚠️ Demo access not resolved:', err.message);
        return { serials: [], live: false };
    }
}

/** Would an account made now get the demo (public: the sign-up page says so)? */
async function isOffered(now = new Date()) {
    try {
        const settings = await require('./settingsService').getSettings();
        return accessFor({ role: 'user', createdAt: now }, settings).serials.length > 0;
    } catch {
        return false;
    }
}

module.exports = {
    accessFor,
    demoAccessOf,
    isOffered
};
