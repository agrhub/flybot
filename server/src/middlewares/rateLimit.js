/**
 * Simple fixed-window in-memory rate limiter (single-process; use a shared store if running multiple instances).
 * Keyed by client IP plus an optional extra key (e.g. the submitted email);
 * with includeIp: false, by the extra key alone.
 */
function rateLimit({ windowMs, max, keyFn = () => '', includeIp = true, message = 'Too many attempts. Please try again later.' }) {
    const hits = new Map(); // key -> { count, resetAt }

    // Drop expired entries so the map can't grow without bound
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs).unref();

    return (req, res, next) => {
        const now = Date.now();
        const key = includeIp ? `${req.ip}|${keyFn(req)}` : keyFn(req);
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count++;

        if (entry.count > max) {
            res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
            return res.status(429).json({ success: false, message });
        }
        next();
    };
}

const emailKey = (req) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '');

module.exports = {
    rateLimit,
    // 10 login attempts per IP+email per 15 minutes, and 50 per IP overall
    loginLimiter: [
        rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }),
        rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyFn: emailKey })
    ],
    registerLimiter: rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }),
    passwordChangeLimiter: rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyFn: (req) => req.user?.id || '' }),
    // Reset emails: 3 per address per hour, 10 per IP per hour (limits mail bombing)
    forgotPasswordLimiter: [
        rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }),
        // Per address regardless of IP, so rotating IPs cannot flood one inbox
        rateLimit({ windowMs: 60 * 60 * 1000, max: 3, keyFn: emailKey, includeIp: false })
    ],
    // Token redemption (reset password / verify email): slows guessing
    tokenLimiter: rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }),
    resendVerificationLimiter: rateLimit({ windowMs: 60 * 60 * 1000, max: 3, keyFn: (req) => req.user?.id || '' })
};
