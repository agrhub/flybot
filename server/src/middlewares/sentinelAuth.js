const crypto = require('crypto');
const env = require('../config/env');
const { sign } = require('../services/webhookService');

/**
 * FlyBot Sentinel internal API: every request is signed with SENTINEL_API_SECRET, the same
 * scheme as FlyBot's outgoing webhooks (services/webhookService.js sign):
 *
 *   X-Sentinel-Timestamp: unix seconds
 *   X-Sentinel-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *
 * rawBody is the exact request body ("" for a GET). The bare hex (without "sha256=") is accepted
 * too, and so are X-FlyBot-Timestamp / X-FlyBot-Signature when the X-Sentinel-* pair is absent
 * (the first Sentinel client used FlyBot's webhook header names). Requests more than MAX_SKEW_S from the server clock are refused, the comparison is
 * constant-time, and a signature is accepted only once for a write (POST), so a captured
 * request cannot be replayed within the window.
 */
const MAX_SKEW_S = 5 * 60;
const MIN_SECRET_LENGTH = 32;
const ACTOR = Object.freeze({ email: 'sentinel-agent' });

// POST signatures already used -> when they can be forgotten (the skew window has passed)
const usedSignatures = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [signature, until] of usedSignatures) if (until <= now) usedSignatures.delete(signature);
}, 60 * 1000).unref();

const HEX_SIGNATURE = /^(?:sha256=)?([0-9a-f]{64})$/i;

/**
 * Check one signature. Returns { ok: true } or { ok: false, code }.
 */
function verifySignature(secret, timestamp, rawBody, header, nowMs = Date.now()) {
    if (!header || !timestamp) return { ok: false, code: 'MISSING_SIGNATURE' };
    if (!/^\d{1,12}$/.test(String(timestamp))) return { ok: false, code: 'BAD_TIMESTAMP' };
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_S) return { ok: false, code: 'STALE_TIMESTAMP' };
    const given = HEX_SIGNATURE.exec(String(header).trim());
    if (!given) return { ok: false, code: 'BAD_SIGNATURE' };
    const expected = Buffer.from(sign(secret, timestamp, rawBody).slice('sha256='.length), 'hex');
    const actual = Buffer.from(given[1].toLowerCase(), 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { ok: false, code: 'BAD_SIGNATURE' };
    return { ok: true };
}

// English only: the caller is the Sentinel agent, not a person
const MESSAGES = {
    SENTINEL_DISABLED: 'The Sentinel API is not configured on this server.',
    JSON_REQUIRED: 'Send a JSON body (Content-Type: application/json).',
    MISSING_SIGNATURE: 'Missing X-Sentinel-Timestamp or X-Sentinel-Signature.',
    BAD_TIMESTAMP: 'X-Sentinel-Timestamp must be unix seconds.',
    STALE_TIMESTAMP: 'X-Sentinel-Timestamp is more than 5 minutes from the server time.',
    BAD_SIGNATURE: 'Invalid signature.',
    REPLAYED: 'This signed request was already used.'
};

function sentinelAuth(req, res, next) {
    const secret = env.SENTINEL_API_SECRET;
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
        return res.status(503).json({ success: false, code: 'SENTINEL_DISABLED', message: MESSAGES.SENTINEL_DISABLED });
    }
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && !req.is('application/json')) {
        return res.status(415).json({ success: false, code: 'JSON_REQUIRED', message: MESSAGES.JSON_REQUIRED });
    }
    // X-FlyBot-* (the names of FlyBot's own webhook headers) are read when the X-Sentinel-* pair is absent
    const sentinelPair = req.get('X-Sentinel-Timestamp') !== undefined || req.get('X-Sentinel-Signature') !== undefined;
    const timestamp = sentinelPair ? req.get('X-Sentinel-Timestamp') : req.get('X-FlyBot-Timestamp');
    const signature = sentinelPair ? req.get('X-Sentinel-Signature') : req.get('X-FlyBot-Signature');
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const check = verifySignature(secret, timestamp, rawBody, signature);
    if (check.ok && write) {
        const key = HEX_SIGNATURE.exec(String(signature).trim())[1].toLowerCase();
        if (usedSignatures.has(key)) Object.assign(check, { ok: false, code: 'REPLAYED' });
        else usedSignatures.set(key, Date.now() + 2 * MAX_SKEW_S * 1000);
    }
    if (!check.ok) {
        console.warn(`🛡️ Sentinel API refused ${req.method} ${req.originalUrl} from ${req.ip}: ${check.code}`);
        return res.status(401).json({ success: false, code: check.code, message: MESSAGES[check.code] });
    }
    req.sentinel = { actor: ACTOR };
    next();
}

module.exports = {
    MAX_SKEW_S,
    ACTOR,
    verifySignature,
    sentinelAuth
};
