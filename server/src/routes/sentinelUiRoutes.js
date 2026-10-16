const express = require('express');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const router = express.Router();
const { authenticate } = require('../middlewares/auth');
const { rateLimit } = require('../middlewares/rateLimit');
const { canViewSentinel, canDecideSentinel } = require('../constants/roles');
const { sendServerError } = require('../utils/http');
const { recordAudit } = require('../services/auditService');
const sentinelUi = require('../services/sentinelUiService');

/**
 * FlyBot Sentinel operator console: /api/sentinel/ui/* → the Sentinel UI API (API.md "Sentinel console proxy").
 * FlyBot signs in for the person with its operator token; the browser only ever sees FlyBot's session.
 * Read: admins, managers, and "user" accounts with sentinelViewer (judges). Decide: admins and managers.
 * Only the routes below reach Sentinel; anything else answers 404 here.
 */

// Configuration first: off = every route answers 503, signed in or not (the client hides the menu)
router.use((req, res, next) => {
    if (sentinelUi.isEnabled()) return next();
    return res.status(503).json({ success: false, code: 'SENTINEL_DISABLED', message: 'The Sentinel console is not set up on this server.' });
});
router.use(authenticate);
router.use((req, res, next) => {
    if (canViewSentinel(req.user)) return next();
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'You do not have permission to do this.' });
});
// Per person: the pages poll summary/traces every 10-30 s; a traces page loads up to 20 thumbnails
const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, includeIp: false, keyFn: (req) => `sentinel-ui:${req.user.id}` });
const mediaLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, includeIp: false, keyFn: (req) => `sentinel-ui-media:${req.user.id}` });
const decideLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, includeIp: false, keyFn: (req) => `sentinel-ui-decide:${req.user.id}` });

const bad = (res, message) => res.status(400).json({ success: false, code: 'BAD_REQUEST', message });

function sendError(res, err, context) {
    if (err instanceof sentinelUi.SentinelUpstreamError) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    return sendServerError(res, err, { context });
}

// ---------- Query allow-list ----------
const SAFE = /^[A-Za-z0-9._:+-]+$/;
const QUERY_RULES = {
    hours: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 168,
    camera: (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v),
    since: (v) => v.length <= 40 && SAFE.test(v),
    until: (v) => v.length <= 40 && SAFE.test(v),
    loop: (v) => ['per_photo', 'daily_per_plot', 'followup'].includes(v),
    limit: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 100,
    cursor: (v) => v.length <= 2048 && /^[A-Za-z0-9._~:+/=%-]+$/.test(v),
    status: (v) => ['pending', 'approved', 'rejected', 'expired'].includes(v),
    date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
    name: (v) => /^[A-Za-z0-9._-]{1,128}$/.test(v) && !v.includes('..')
};

/** Keep only the allowed parameters of this route, each a single valid string; else a 400 message. */
function pickQuery(query, allowed) {
    const out = {};
    for (const key of allowed) {
        const value = query[key];
        if (value === undefined || value === '') continue;
        if (typeof value !== 'string' || !QUERY_RULES[key](value)) return { error: `Invalid ${key}.` };
        out[key] = value;
    }
    return { query: out };
}

/** GET route that forwards to `path(req)` with the allowed query parameters (then `shape`, if any). */
function proxyGet(allowed, path, shape) {
    return async (req, res) => {
        const picked = pickQuery(req.query, allowed);
        if (picked.error) return bad(res, picked.error);
        const target = path(req);
        if (!target) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
        try {
            const { status, data } = await sentinelUi.callJson(target, { query: picked.query });
            res.setHeader('Cache-Control', 'no-store');
            return res.status(status).json(shape ? shape(data, req) : data);
        } catch (err) {
            return sendError(res, err, 'Sentinel console');
        }
    };
}

// Path segments: validated, then encoded (daily/follow-up event ids contain ":")
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const APPROVAL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SERIAL = /^[A-Za-z0-9_-]{1,64}$/;
const segment = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? encodeURIComponent(value) : null);
const withSegment = (prefix, param, pattern) => (req) => {
    const seg = segment(req.params[param], pattern);
    return seg ? `${prefix}/${seg}` : null;
};

// FlyBot always calls with the operator token, so `role` says what this person may do
// ("judge" = read-only), as the Sentinel web app expects (UI_API.md)
router.get('/summary', readLimiter, proxyGet(['hours'], () => 'summary', (data, req) => ({ ...data, role: canDecideSentinel(req.user) ? 'operator' : 'judge' })));
router.get('/traces', readLimiter, proxyGet(['camera', 'since', 'until', 'loop', 'limit', 'cursor'], () => 'traces'));
router.get('/traces/:id', readLimiter, proxyGet([], withSegment('traces', 'id', EVENT_ID)));
router.get('/approvals', readLimiter, proxyGet(['status', 'limit', 'cursor'], () => 'approvals'));
// Read-only; the console polls it after a decision until the status changes
router.get('/approvals/:id', readLimiter, proxyGet([], withSegment('approvals', 'id', APPROVAL_ID)));
router.get('/devices', readLimiter, proxyGet([], () => 'devices'));
router.get('/devices/:serial', readLimiter, proxyGet([], withSegment('devices', 'serial', SERIAL)));
router.get('/density', readLimiter, proxyGet(['date'], () => 'density'));
router.get('/bench', readLimiter, proxyGet(['name'], () => 'bench'));

/**
 * POST /api/sentinel/ui/approvals/:id/decide  { decision: "approve" | "reject" }
 * `by` is always the signed-in person (anything the browser sends is ignored).
 */
router.post('/approvals/:id/decide', decideLimiter, async (req, res) => {
    if (!canDecideSentinel(req.user)) {
        return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'You do not have permission to do this.' });
    }
    const id = segment(req.params.id, APPROVAL_ID);
    if (!id) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) return bad(res, 'decision must be "approve" or "reject".');
    const by = sentinelUi.deciderName(req.user);
    try {
        const { status, data } = await sentinelUi.callJson(`approvals/${id}/decide`, { method: 'POST', body: { decision, by } });
        recordAudit(req, {
            action: 'sentinel.approval_decided',
            target: { type: 'sentinel_approval', id: req.params.id },
            details: { decision }
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(status).json({ ...data, by });
    } catch (err) {
        return sendError(res, err, 'Sentinel decide');
    }
});

/**
 * GET /api/sentinel/ui/evidence?key=<key or s3:// ref>
 * The image itself (FlyBot reads Sentinel's presigned URL), so it works as <img src> with the
 * session cookie and no Sentinel token or presigned URL reaches the browser.
 */
router.get('/evidence', mediaLimiter, async (req, res) => {
    const { key } = req.query;
    if (!sentinelUi.isEvidenceKey(key)) return bad(res, 'Invalid key.');
    let media;
    try {
        media = await sentinelUi.fetchEvidence(key);
    } catch (err) {
        return sendError(res, err, 'Sentinel evidence');
    }
    res.status(200);
    res.setHeader('Content-Type', media.contentType);
    if (media.contentLength) res.setHeader('Content-Length', String(media.contentLength));
    if (media.etag) res.setHeader('ETag', media.etag);
    if (media.lastModified) res.setHeader('Last-Modified', media.lastModified);
    // Evidence objects never change once written; per person (behind sign-in)
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', media.inline ? 'inline' : 'attachment');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    let bytes = 0;
    const limit = new Transform({
        transform(chunk, _enc, done) {
            bytes += chunk.length;
            if (bytes > sentinelUi.MAX_MEDIA_BYTES) return done(new Error('Sentinel evidence larger than allowed'));
            return done(null, chunk);
        }
    });
    try {
        await pipeline(Readable.fromWeb(media.body), limit, res);
    } catch (err) {
        media.abort();
        if (!res.headersSent) return sendError(res, err, 'Sentinel evidence');
        console.warn('⚠️ Sentinel evidence stream stopped:', err.message);
        res.destroy();
    } finally {
        media.done();
    }
});

// Anything else under /api/sentinel/ui never reaches Sentinel
router.use((req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' }));

module.exports = router;
