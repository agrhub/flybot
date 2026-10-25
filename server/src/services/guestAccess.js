const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User } = require('../models');

/**
 * Guest access (Admin > System > Demo access): a "Guest access" button on the sign-in page signs in
 * to ONE shared account (User.guest) that sees the demo cameras and the simulated demo farm, so
 * customers' own accounts never need to. It is read-only by construction:
 *  - nobody knows its password (random) and its address receives no mail; no alerts or reports;
 *  - every write is refused (403 GUEST_READ_ONLY) except signing out, the dashboard's AI diagnosis
 *    (read-only), talking to the assistant, whose chat history is kept per guest session (visitors
 *    never see each other's questions), and the guest's own reports: up to MAX_GUEST_REPORTS per
 *    session, seen and changed by that session only, never shared by email or scheduled, and removed
 *    at sign-out or by cleanupGuestReports once the session has ended;
 *  - a guest session lasts GUEST_SESSION_MS and is never extended;
 *  - signing in is rate limited per address and in total (middlewares/rateLimit.js guestLimiter).
 */
const GUEST_EMAIL = 'guest@flybot.invalid';
const GUEST_SESSION_MS = 2 * 3600 * 1000;

// What a guest may still send (path without the query): sign out, the assistant, the dashboard's
// AI diagnosis (a POST only for its options; it computes and saves nothing), and opening a stream
const GUEST_WRITES = [
    /^\/api\/auth\/logout$/,
    /^\/api\/ai\/chat(\/stream)?$/,
    /^\/api\/ai\/chat\/(feedback|clear)$/,
    /^\/api\/ai\/diagnose$/,
    // Live view and recorded video of the demo cameras the admin opened them for (each checks the
    // camera's permissions, services/demoView.js): they start and stop a stream, they change nothing
    /^\/api\/live(\/disable)?$/,
    /^\/api\/(records|playback)$/,
    /^\/api\/cameras\/[A-Za-z0-9_-]{1,64}\/live\/request$/,
    // The guest's own reports: create, change, delete, a new public link (dashboardController checks
    // that the report is this session's); sharing by email, sending and schedules stay closed
    /^\/api\/dashboards(\/[a-f0-9]{24}(\/public-token)?)?$/
];
const MAX_GUEST_REPORTS = 5;
// Reads that hand out the account itself
const GUEST_BLOCKED_READS = [
    /^\/api\/auth\/export$/,
    /^\/api\/integrations(\/|$)/
];

/** The shared guest account (made on first use). */
async function guestUser() {
    const existing = await User.findOne({ email: GUEST_EMAIL });
    if (existing) return existing;
    try {
        return await User.create({
            email: GUEST_EMAIL,
            password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
            name: 'Guest',
            role: 'user',
            guest: true,
            emailVerified: false,
            language: 'en',
            notificationPrefs: { email: false, telegram: false, weeklyReport: false, morningBrief: false, vietgapMonthly: false, orgDigest: false }
        });
    } catch (err) {
        // Two first visitors at once: the other one made it
        if (err.code === 11000) return User.findOne({ email: GUEST_EMAIL });
        throw err;
    }
}

/** May a guest send this request? */
function guestMayRequest(method, path) {
    const clean = String(path || '').split('?')[0];
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return !GUEST_BLOCKED_READS.some(r => r.test(clean));
    return GUEST_WRITES.some(r => r.test(clean));
}

/**
 * Remove the reports of guest sessions that ended (expired, signed out, or guest access turned off).
 * Returns how many were removed.
 */
async function cleanupGuestReports(now = new Date()) {
    const { Dashboard, Session } = require('../models');
    const sessions = await Dashboard.distinct('guestSession', { guestSession: { $exists: true, $ne: null } });
    if (!sessions.length) return 0;
    const open = (await require('./settingsService').getSettings()).guestAccessEnabled;
    const live = open
        ? new Set((await Session.find({ _id: { $in: sessions.filter(id => /^[a-f0-9]{24}$/.test(id)) }, revokedAt: null, expiresAt: { $gt: now } }).select('_id').lean()).map(s => String(s._id)))
        : new Set();
    const ended = sessions.filter(id => !live.has(id));
    if (!ended.length) return 0;
    return (await Dashboard.deleteMany({ guestSession: { $in: ended } })).deletedCount || 0;
}

/** A guest's chat conversation is its own: the client's id within the guest session. */
const guestChatSession = (sessionId, chatId) => `g${String(sessionId).slice(-12)}-${chatId}`.slice(0, 100);

module.exports = {
    GUEST_EMAIL,
    GUEST_SESSION_MS,
    guestUser,
    guestMayRequest,
    MAX_GUEST_REPORTS,
    cleanupGuestReports,
    guestChatSession
};
