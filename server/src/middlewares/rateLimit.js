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

/**
 * A keyed counter for limits checked inside code rather than as middleware
 * (e.g. the same quota for a REST endpoint and an AI agent tool).
 */
function createQuota({ windowMs, max }) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs).unref();
    return {
        // Counts one use; false when the key is over its limit
        take(key) {
            const now = Date.now();
            let entry = hits.get(key);
            if (!entry || entry.resetAt <= now) {
                entry = { count: 0, resetAt: now + windowMs };
                hits.set(key, entry);
            }
            entry.count++;
            return entry.count <= max;
        },
        retryAfterSeconds(key) {
            const entry = hits.get(key);
            return entry ? Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) : 0;
        }
    };
}

// Manual captures hit the camera and the AI API: at most 3 per camera per user per minute
const captureQuota = createQuota({ windowMs: 60 * 1000, max: 3 });
// "Email me" builds a report and its PDF: 5 per person per hour, from the page or the assistant
const reportSendQuota = createQuota({ windowMs: 60 * 60 * 1000, max: 5 });
// Organization invitations email each address: 100 addresses a day per person
const inviteQuota = createQuota({ windowMs: 24 * 60 * 60 * 1000, max: 100 });

const emailKey = (req) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '');

// Confirmation reminders actually sent: 3 per day to the same address, whoever sends them
const remindQuota = createQuota({ windowMs: 24 * 60 * 60 * 1000, max: 3 });

// Avatar changes: 20 per person per 10 minutes
const avatarLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, includeIp: false, keyFn: (req) => `avatar:${req.user?.id}` });

// "Download all my data" reads a person's whole history: 3 per person per hour
const dataExportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, includeIp: false, keyFn: (req) => `export:${req.user?.id}` });

module.exports = {
    rateLimit,
    dataExportLimiter,
    avatarLimiter,
    remindQuota,
    createQuota,
    captureQuota,
    reportSendQuota,
    inviteQuota,
    // Express middleware over captureQuota (user + camera)
    captureLimiter: (req, res, next) => {
        const key = `${req.user?.id}:${req.body?.deviceSerial}`;
        if (captureQuota.take(key)) return next();
        res.setHeader('Retry-After', captureQuota.retryAfterSeconds(key));
        return res.status(429).json({ success: false, message: 'Too many attempts. Please try again later.' });
    },
    // AI assistant: each message can run several model calls and tools
    chatLimiter: [
        rateLimit({ windowMs: 60 * 1000, max: 10, includeIp: false, keyFn: (req) => `chat:${req.user?.id || ''}` }),
        rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 300, includeIp: false, keyFn: (req) => `chat-day:${req.user?.id || ''}` })
    ],
    // Assistant confirm and rating clicks: 60 per person per minute
    chatActionLimiter: rateLimit({ windowMs: 60 * 1000, max: 60, includeIp: false, keyFn: (req) => `chat-action:${req.user?.id || ''}` }),
    // Summaries computed over many days and traps (farm comparison, effect by ingredient):
    // a page load needs one call, so 30 a minute per person is plenty
    analyticsLimiter: rateLimit({ windowMs: 60 * 1000, max: 30, includeIp: false, keyFn: (req) => `analytics:${req.user?.id || ''}` }),
    // Share invitations send email to any address: limit per sharer
    shareLimiter: rateLimit({ windowMs: 60 * 60 * 1000, max: 30, includeIp: false, keyFn: (req) => `share:${req.user?.id || ''}` }),
    // Express middleware over reportSendQuota (per user)
    reportSendLimiter: (req, res, next) => {
        const key = String(req.user?.id || '');
        if (reportSendQuota.take(key)) return next();
        res.setHeader('Retry-After', reportSendQuota.retryAfterSeconds(key));
        return res.status(429).json({ success: false, message: 'Too many attempts. Please try again later.' });
    },
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
