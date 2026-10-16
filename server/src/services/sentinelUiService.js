/**
 * Server side of the FlyBot Sentinel operator console (routes/sentinelUiRoutes.js).
 *
 * Calls the Sentinel UI API (flybot-sentinel docs/UI_API.md) with the operator token from
 * SENTINEL_UI_TOKEN. The token is only ever sent upstream: answers to the browser are rebuilt
 * from the upstream JSON (or image bytes), never forwarded with upstream headers.
 */
const env = require('../config/env');
const { canViewSentinel, canDecideSentinel } = require('../constants/roles');

// Every upstream call answers (headers and JSON body) within this time
const UPSTREAM_TIMEOUT_MS = 5000;
// Evidence images: headers within UPSTREAM_TIMEOUT_MS, whole body within this
const MEDIA_TOTAL_TIMEOUT_MS = 30000;
// Larger files are refused (frames are ~0.5 MB, clips a few MB)
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
// Prefixes UI_API.md allows for /ui/evidence
const EVIDENCE_PREFIXES = ['frames/', 'clips/', 'evidence/', 'density/', 'bench/'];

const isEnabled = () => !!(env.SENTINEL_UI_URL && env.SENTINEL_UI_TOKEN);

/** What the signed-in person may do in the Sentinel console (for the client's menu). */
function accessFor(user) {
    const enabled = isEnabled();
    return {
        sentinelEnabled: enabled && canViewSentinel(user),
        sentinelCanDecide: enabled && canDecideSentinel(user)
    };
}

class SentinelUpstreamError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const clip = (value, max = 300) => String(value ?? '').slice(0, max);

/**
 * Map an upstream failure to the answer FlyBot gives. Never 401: the client signs the person
 * out on a 401, and a bad Sentinel token is FlyBot's configuration, not the person's session.
 */
function mapUpstreamError(status) {
    if (status === 401) {
        return new SentinelUpstreamError(502, 'SENTINEL_AUTH', 'FlyBot could not sign in to Sentinel. Check SENTINEL_UI_TOKEN.');
    }
    // 403: the token is a read-only (judge) token
    if (status === 403) {
        return new SentinelUpstreamError(502, 'SENTINEL_FORBIDDEN', "Sentinel refused this action for FlyBot's token.");
    }
    // Sentinel's own texts are not passed on (English only, and may name AWS resources)
    if (status === 400) return new SentinelUpstreamError(400, 'BAD_REQUEST', 'Sentinel refused the request.');
    if (status === 404) return new SentinelUpstreamError(404, 'NOT_FOUND', 'Not found.');
    if (status === 409) return new SentinelUpstreamError(409, 'CONFLICT', 'This approval was already decided.');
    if (status === 429) {
        return new SentinelUpstreamError(503, 'SENTINEL_BUSY', 'Sentinel is busy. Please try again shortly.');
    }
    return new SentinelUpstreamError(502, 'SENTINEL_UPSTREAM', 'Sentinel is not answering correctly. Please try again later.');
}

function networkError(err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        return new SentinelUpstreamError(504, 'SENTINEL_TIMEOUT', 'Sentinel did not answer in time.');
    }
    return new SentinelUpstreamError(502, 'SENTINEL_UNREACHABLE', 'Sentinel cannot be reached.');
}

function upstreamUrl(path, query = {}) {
    const url = new URL(`${env.SENTINEL_UI_URL}/${path}`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url;
}

/**
 * Call the UI API and return its parsed JSON. `path` is already validated and encoded
 * by the route (no leading slash), e.g. "traces/01JT..." .
 */
async function callJson(path, { method = 'GET', query, body } = {}) {
    const headers = { Authorization: `Bearer ${env.SENTINEL_UI_TOKEN}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    let data = null;
    try {
        res = await fetch(upstreamUrl(path, query), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
        const text = await res.text();
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = null;
            }
        }
    } catch (err) {
        throw networkError(err);
    }
    if (res.status < 200 || res.status >= 300) throw mapUpstreamError(res.status);
    if (!data || typeof data !== 'object') {
        throw new SentinelUpstreamError(502, 'SENTINEL_UPSTREAM', 'Sentinel is not answering correctly. Please try again later.');
    }
    return { status: res.status, data };
}

/** A key or s3:// ref the UI API serves through /ui/evidence. */
function isEvidenceKey(key) {
    if (typeof key !== 'string' || !key || key.length > 512) return false;
    if (/[\u0000-\u001f\\]/.test(key) || key.includes('..')) return false;
    const objectKey = key.startsWith('s3://') ? key.replace(/^s3:\/\/[^/]+\//, '') : key;
    return EVIDENCE_PREFIXES.some(prefix => objectKey.startsWith(prefix));
}

// Served inline: images and video only; anything else (bench JSON) goes out as a download
const INLINE_TYPE = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/i;

/**
 * Fetch one evidence object: the UI API gives a presigned URL (?json=1), which FlyBot reads
 * itself. Returns { contentType, contentLength, etag, lastModified, body (web ReadableStream) }.
 */
async function fetchEvidence(key) {
    const { data } = await callJson('evidence', { query: { key, json: 1 } });
    let target;
    try {
        target = new URL(data.url);
    } catch {
        throw new SentinelUpstreamError(502, 'SENTINEL_UPSTREAM', 'Sentinel is not answering correctly. Please try again later.');
    }
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))) {
        throw new SentinelUpstreamError(502, 'SENTINEL_UPSTREAM', 'Sentinel is not answering correctly. Please try again later.');
    }

    // Headers within the usual timeout; the body may take longer (a clip)
    const controller = new AbortController();
    const total = setTimeout(() => controller.abort(), MEDIA_TOTAL_TIMEOUT_MS);
    total.unref?.();
    let res;
    try {
        res = await fetch(target, {
            redirect: 'manual',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
        });
    } catch (err) {
        clearTimeout(total);
        throw networkError(err);
    }
    if (res.status !== 200 || !res.body) {
        clearTimeout(total);
        res.body?.cancel().catch(() => {});
        throw res.status === 404 || res.status === 403
            ? new SentinelUpstreamError(404, 'NOT_FOUND', 'This file is no longer available.')
            : new SentinelUpstreamError(502, 'SENTINEL_UPSTREAM', 'Sentinel storage is not answering correctly.');
    }
    const contentLength = Number(res.headers.get('content-length')) || null;
    if (contentLength && contentLength > MAX_MEDIA_BYTES) {
        clearTimeout(total);
        res.body.cancel().catch(() => {});
        throw new SentinelUpstreamError(502, 'SENTINEL_MEDIA_TOO_LARGE', 'This file is too large to show here.');
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    return {
        contentType: INLINE_TYPE.test(type) ? type.toLowerCase() : 'application/octet-stream',
        inline: INLINE_TYPE.test(type),
        contentLength,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        body: res.body,
        done: () => clearTimeout(total),
        abort: () => controller.abort()
    };
}

/** The approver name sent upstream: always the signed-in person, never what the browser typed. */
function deciderName(user) {
    const email = clip(user?.email, 254);
    const name = clip(user?.name, 80).replace(/[\u0000-\u001f<>]/g, '').trim();
    const full = name && email && name !== email ? `${name} <${email}>` : (email || name);
    if (full.length <= 80) return full;
    return (email.length <= 80 ? email : email.slice(0, 80)) || name.slice(0, 80);
}

module.exports = {
    isEnabled,
    accessFor,
    callJson,
    fetchEvidence,
    isEvidenceKey,
    deciderName,
    SentinelUpstreamError,
    UPSTREAM_TIMEOUT_MS,
    MAX_MEDIA_BYTES
};
