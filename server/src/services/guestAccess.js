const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User } = require('../models');

/**
 * Guest access (Admin > System > Demo access): a "Guest access" button on the sign-in page signs in
 * to ONE shared account (User.guest) that sees the demo cameras and the simulated demo farm, so
 * customers' own accounts never need to. It is read-only by construction:
 *  - nobody knows its password (random) and its address receives no mail; no alerts or reports;
 *  - every write is refused (403 GUEST_READ_ONLY) except signing out, the dashboard's AI diagnosis
 *    (read-only) and talking to the assistant, whose chat history is kept per guest session
 *    (visitors never see each other's questions);
 *  - a guest session lasts GUEST_SESSION_MS and is never extended;
 *  - signing in is rate limited per address and in total (middlewares/rateLimit.js guestLimiter).
 */
const GUEST_EMAIL = 'guest@flybot.invalid';
const GUEST_SESSION_MS = 2 * 3600 * 1000;

// What a guest may still send (path without the query): sign out, the assistant, and the
// dashboard's AI diagnosis (a POST only for its options; it computes and saves nothing)
const GUEST_WRITES = [
    /^\/api\/auth\/logout$/,
    /^\/api\/ai\/chat(\/stream)?$/,
    /^\/api\/ai\/chat\/(feedback|clear)$/,
    /^\/api\/ai\/diagnose$/
];
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

/** A guest's chat conversation is its own: the client's id within the guest session. */
const guestChatSession = (sessionId, chatId) => `g${String(sessionId).slice(-12)}-${chatId}`.slice(0, 100);

module.exports = {
    GUEST_EMAIL,
    GUEST_SESSION_MS,
    guestUser,
    guestMayRequest,
    guestChatSession
};
