const crypto = require('crypto');
const { AuthToken } = require('../models');
const { APP_BASE_URL } = require('../config/env');

const PASSWORD_RESET_TTL_MINUTES = 30;
const EMAIL_VERIFY_TTL_HOURS = 48;

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Create a one-time token and return the raw value (only ever sent by email).
 * Any earlier unused token of the same type for this user is revoked.
 */
async function createToken(userId, type, ttlMs) {
    await AuthToken.deleteMany({ userId, type, usedAt: null });
    const raw = crypto.randomBytes(32).toString('base64url');
    await AuthToken.create({
        userId,
        type,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + ttlMs)
    });
    return raw;
}

/**
 * Atomically mark a valid token as used and return it, or null if it is
 * unknown, expired or already used (so a link works exactly once).
 */
async function consumeToken(raw, type) {
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return null;
    const now = new Date();
    return AuthToken.findOneAndUpdate(
        { tokenHash: hashToken(raw), type, usedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
        { new: true }
    );
}

/**
 * Absolute link into the web app for emails.
 */
function appUrl(pathname, query = {}) {
    let base = APP_BASE_URL;
    if (!base) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('APP_BASE_URL must be set to send email links');
        }
        base = 'http://localhost:3000'; // Vite dev server
    }
    // Relative path so an APP_BASE_URL with a sub-path (https://x.com/app) is kept
    const url = new URL(pathname.replace(/^\/+/, ''), base + '/');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
}

module.exports = {
    PASSWORD_RESET_TTL_MINUTES,
    EMAIL_VERIFY_TTL_HOURS,
    createToken,
    consumeToken,
    appUrl
};
