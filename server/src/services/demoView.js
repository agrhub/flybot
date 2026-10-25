const crypto = require('crypto');
const { isAdmin } = require('../constants/roles');

/**
 * Read-only demo cameras for visitors (for example competition judges): the admin shares a few
 * cameras in Settings > System > Demo access (env DEMO_VIEW_* gives the first values) and the guest
 * account (or every account, or every account created on or after a date) may view them, as if they
 * were shared with it, without waiting for the owner to share them:
 *  - photos, counts, analytics, Sentinel traces and proposals, the chatbot: yes
 *    (utils/ownership.js viewFilter adds them for the signed-in request);
 *  - managing them (settings, capture, delete, share, maintenance, treatments, deciding a
 *    proposal): never, since the manage rules (canManageCamera, isCameraOwner) ignore this access;
 *  - the rest is chosen per camera (demoViewShares, see PERMISSIONS): live view, recorded video,
 *    the location, the device details and the real serial (off: an alias, middlewares/demoMask.js).
 * With demoViewSimulated the cameras and farms of the simulated demo organization (scripts/demo_sim.js)
 * are viewable the same way (req.user.demoOrgId), always labeled as simulated.
 * Nothing is written to the cameras or the accounts: turning it off removes the access at once
 * (within the settings cache, 30 s). Only signed-in requests get it (middlewares/auth.js sets
 * req.user.demoSerials): background jobs (weekly report, morning brief, alerts, webhooks) read
 * the account itself and never send anything about demo cameras.
 */

/**
 * What a visitor may do with one shared camera besides its photos and counts (always): each true
 * opens one more thing.
 *  - live:       live view (EZVIZ, KVS) and, for a sleeping CamOS camera, the live request
 *  - playback:   recorded video (EZVIZ SD card and cloud records)
 *  - location:   the map position, the address, the GPS fix
 *  - device:     the device details (CamOS status bar, battery, signal, network, firmware, its log)
 *  - realSerial: the real serial; off, every answer shows aliasOf(serial) instead
 */
const PERMISSIONS = ['live', 'playback', 'location', 'device', 'realSerial'];
const MAX_SHARES = 20;
const SERIAL_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The shared cameras as they were before per-camera permissions (demoViewCameras, demoViewLive):
 * what visitors had then, so existing settings keep their behaviour.
 */
function sharesFromList(serials, live) {
    return (Array.isArray(serials) ? serials : []).map(deviceSerial => ({
        deviceSerial, live: !!live, playback: !!live, location: true, device: true, realSerial: true
    }));
}

/** A share entry as stored: the serial and every permission as a boolean. */
const normalizeShare = (entry) => ({
    deviceSerial: String(entry.deviceSerial).trim(),
    ...Object.fromEntries(PERMISSIONS.map(key => [key, !!entry[key]]))
});

const isShareList = (value) => Array.isArray(value) && value.length <= MAX_SHARES && value.every(entry =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.deviceSerial === 'string' && SERIAL_RE.test(entry.deviceSerial.trim())
    && Object.keys(entry).every(key => key === 'deviceSerial' || (PERMISSIONS.includes(key) && typeof entry[key] === 'boolean')));

/**
 * The opaque name a camera has for visitors who may not see its serial: the same for everyone and
 * every time (a keyed hash of the serial), so links keep working; only the server maps it back.
 */
function aliasOf(serial) {
    const secret = require('../config/env').JWT_SECRET || 'flybot';
    return `DEMO-${crypto.createHmac('sha256', secret).update(`demo-alias:${serial}`).digest('hex').slice(0, 10).toUpperCase()}`;
}

/**
 * The demo serials, their permissions, the simulated organization (when shown) and whether any
 * live view is open to this account, from the effective settings. `simulatedOrgId`: the simulated
 * demo organization, if any. The guest account (services/guestAccess.js) gets them while guest
 * access is on; other accounts only when demo access is on and its audience includes them: "guest"
 * (nobody else, the default), "all", or "since" (accounts created on or after demoViewSince).
 */
function accessFor(userDoc, settings, simulatedOrgId = null) {
    const none = { serials: [], shares: {}, orgId: null, live: false };
    if (!userDoc || !settings || isAdmin(userDoc)) return none;
    const list = Array.isArray(settings.demoViewShares) ? settings.demoViewShares : sharesFromList(settings.demoViewCameras, settings.demoViewLive);
    const shares = Object.fromEntries(list.map(entry => [entry.deviceSerial, Object.fromEntries(PERMISSIONS.map(key => [key, !!entry[key]]))]));
    const serials = Object.keys(shares);
    const orgId = settings.demoViewSimulated && simulatedOrgId ? String(simulatedOrgId) : null;
    if (!serials.length && !orgId) return none;
    const access = { serials, shares, orgId, live: serials.some(serial => shares[serial].live) };
    if (userDoc.guest) return settings.guestAccessEnabled ? access : none;
    if (!settings.demoViewEnabled) return none;
    const audience = settings.demoViewAudience || 'guest';
    if (audience === 'guest') return none;
    if (audience === 'since' && settings.demoViewSince) {
        const created = userDoc.createdAt ? new Date(userDoc.createdAt).getTime() : NaN;
        if (!(created >= new Date(settings.demoViewSince).getTime())) return none;
    }
    return access;
}

/**
 * What this account must not see of the cameras it views only through demo access: the alias of
 * each hidden serial (aliases, and back: byAlias) and the permissions of each camera with something withheld (perms).
 * Cameras the account owns or that are shared with it are left alone. Null for most accounts.
 */
async function maskFor(user, access) {
    const restricted = Object.entries(access?.shares || {}).filter(([, p]) => !p.realSerial || !p.location || !p.device);
    if (!restricted.length) return null;
    const { Camera } = require('../models');
    const id = String(user?._id ?? user?.id ?? '');
    const own = new Set((await Camera.find({
        deviceSerial: { $in: restricted.map(([serial]) => serial) },
        $or: [{ userId: id }, { 'sharedWith.userId': id }]
    }).select('deviceSerial').lean()).map(c => c.deviceSerial));
    const mask = { aliases: new Map(), byAlias: new Map(), perms: new Map() };
    for (const [serial, perms] of restricted) {
        if (own.has(serial)) continue;
        if (!perms.realSerial) {
            mask.aliases.set(serial, aliasOf(serial));
            mask.byAlias.set(aliasOf(serial), serial);
        }
        mask.perms.set(serial, perms);
    }
    return mask.perms.size ? mask : null;
}

// Alias -> serial of every shared camera whose serial is hidden (the same for every account),
// rebuilt when the settings change
let aliasCache = { list: null, map: new Map() };
function serialsByAlias(settings) {
    const list = settings?.demoViewShares;
    if (aliasCache.list === list) return aliasCache.map;
    const map = new Map((Array.isArray(list) ? list : []).filter(e => !e.realSerial).map(e => [aliasOf(e.deviceSerial), e.deviceSerial]));
    aliasCache = { list, map };
    return map;
}

// The simulated demo organization's id, cached like the settings (it is made once by the seed)
const ORG_CACHE_MS = 30 * 1000;
let orgCache = { at: 0, id: null };
async function simulatedOrgId() {
    if (Date.now() - orgCache.at < ORG_CACHE_MS) return orgCache.id;
    const { Organization } = require('../models');
    const org = await Organization.findOne({ simulated: true }).select('_id').lean();
    orgCache = { at: Date.now(), id: org ? String(org._id) : null };
    return orgCache.id;
}
const clearCache = () => { orgCache = { at: 0, id: null }; };

/** Same, reading the settings (cached). Never fails: a problem means no demo access. */
async function demoAccessOf(userDoc) {
    try {
        const settings = await require('./settingsService').getSettings();
        return accessFor(userDoc, settings, settings.demoViewSimulated ? await simulatedOrgId() : null);
    } catch (err) {
        console.warn('⚠️ Demo access not resolved:', err.message);
        return { serials: [], shares: {}, orgId: null, live: false };
    }
}

/** Would an account made now get the demo (public: the sign-up page says so)? */
async function isOffered(now = new Date()) {
    try {
        const settings = await require('./settingsService').getSettings();
        const access = accessFor({ role: 'user', createdAt: now }, settings, settings.demoViewSimulated ? await simulatedOrgId() : null);
        return access.serials.length > 0 || !!access.orgId;
    } catch {
        return false;
    }
}

module.exports = {
    PERMISSIONS,
    MAX_SHARES,
    sharesFromList,
    normalizeShare,
    isShareList,
    aliasOf,
    accessFor,
    maskFor,
    serialsByAlias,
    simulatedOrgId,
    clearCache,
    demoAccessOf,
    isOffered
};
