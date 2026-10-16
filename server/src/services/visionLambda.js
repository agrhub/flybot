const axios = require('axios');
const env = require('../config/env');
const { Camera, Snapshot } = require('../models');
const { pestCountOf } = require('../models/Snapshot');
const { trapKindOf } = require('../constants/trap');
const { FRUIT_FLY } = require('../constants/species');
const aws = require('../platforms/aws');

/**
 * AI_PROVIDER=opencv-lambda: the vision Lambda of flybot-aws (OpenCV 5 detection + the agent),
 * called synchronously per photo with the request of docs/CONTRACTS.md section 1.
 *
 * Transport: AWS SDK Lambda.Invoke (RequestResponse) with VISION_LAMBDA_NAME, or for local
 * development the same JSON posted to VISION_LAMBDA_URL (uv run python -m sentinel.lambda_local).
 * Photos travel by reference: bucket/key when the bucket is real S3 (PHOTOS_BY_REFERENCE),
 * otherwise a signed URL. On an error the photo is kept, the analysis marked failed, and the call
 * retried once after RETRY_DELAY_MS.
 */
const CONTRACT_VERSION = 1;
const RETRY_DELAY_MS = 30000;
const MAX_ATTEMPTS = 2;
// Days of history sent with each photo (counts of earlier photos of the same camera)
const HISTORY_DAYS = 14;
const HISTORY_MAX = 14;
const DEEP_KEPT = 10;
const MAX_BOXES = 2000;
// Count labels are stored as Map keys: no dots, no leading $
const LABEL = /^[^.$][^.]{0,59}$/;

let retryDelayMs = RETRY_DELAY_MS;
/** Tests: how long the one retry waits. */
function setRetryDelay(ms) {
    retryDelayMs = ms;
}

class VisionError extends Error {
    constructor(code, message, { status = null, cause = null } = {}) {
        super(message || code);
        this.name = 'VisionError';
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

const isConfigured = () => !!(env.VISION_LAMBDA_URL || env.VISION_LAMBDA_NAME);
const isLambdaProvider = () => env.AI_PROVIDER === 'opencv-lambda';

// ---------- Request ----------

/** Where the Lambda reads the photo: { s3Bucket, s3Key } or { url } (CONTRACTS: never inline). */
async function photoRef(snapshot) {
    if (!snapshot?.s3Key) return null;
    if (env.PHOTOS_BY_REFERENCE) return { s3Bucket: env.S3_BUCKET, s3Key: snapshot.s3Key };
    const url = await require('./s3Service').getSignedDownloadUrl(snapshot.s3Key, 3600);
    return url ? { url } : null;
}

/** The latest analyzed photo of the camera before this one. */
async function previousSnapshot(snapshot) {
    return Snapshot.findOne({ deviceSerial: snapshot.deviceSerial, aiProcessed: true, createdAt: { $lt: snapshot.createdAt } })
        .sort({ createdAt: -1 }).select('s3Key createdAt').lean();
}

/** Counts of the camera's earlier photos (last HISTORY_DAYS days, newest first, at most HISTORY_MAX). */
async function historyOf(snapshot) {
    const since = new Date(new Date(snapshot.createdAt).getTime() - HISTORY_DAYS * 24 * 3600 * 1000);
    const rows = await Snapshot.find({ deviceSerial: snapshot.deviceSerial, aiProcessed: true, createdAt: { $gte: since, $lt: snapshot.createdAt } })
        .sort({ createdAt: -1 }).limit(HISTORY_MAX).select('createdAt pestCount').lean();
    return rows.map(r => ({ capturedAt: new Date(r.createdAt).toISOString(), count: Number.isFinite(r.pestCount) ? r.pestCount : 0 }));
}

/**
 * The request body (CONTRACTS section 1). `mode` "detect" (every photo) or "deep" (a chatbot
 * question, `question` required).
 */
/** A self-registered camera without an owner yet. */
const isUnclaimed = (camera) => !!(camera?.selfRegistered && camera?.unclaimed);

async function buildRequest(snapshot, camera, { mode = 'detect', question = null, locale = 'vi', withHistory = true } = {}) {
    const photo = await photoRef(snapshot);
    if (!photo) throw new VisionError('bad_request', 'The photo has no storage key.');
    const prev = await previousSnapshot(snapshot);
    const prevPhoto = prev ? await photoRef(prev) : null;
    const request = {
        v: CONTRACT_VERSION,
        mode,
        photo,
        ...(prevPhoto ? { prevPhoto } : {}),
        camera: {
            id: camera.deviceSerial,
            name: camera.deviceName || camera.deviceSerial,
            trapKind: trapKindOf(camera),
            platform: camera.platform || 'ezviz',
            ...(Number.isFinite(camera.latitude) && Number.isFinite(camera.longitude) ? { location: { lat: camera.latitude, lng: camera.longitude } } : {})
        },
        capturedAt: new Date(snapshot.createdAt).toISOString(),
        locale: locale === 'en' ? 'en' : 'vi'
    };
    if (withHistory) request.history = await historyOf(snapshot);
    if (mode === 'deep') request.question = String(question || '').slice(0, 1000);
    // A self-registered camera nobody claimed yet (CONTRACTS 2a.3): the rule planner only, no LLM
    // (additive request keys; the Lambda ignores what it does not know)
    if (isUnclaimed(camera)) {
        request.camera.claimed = false;
        request.options = { planner: 'rule', llm: false };
    }
    return request;
}

// ---------- Transport ----------

/** The Lambda's error body, or a generic one. */
function errorOf(body, fallbackCode = 'internal', status = null) {
    const err = body && typeof body === 'object' ? body.error : null;
    const code = typeof err?.code === 'string' ? err.code : fallbackCode;
    const message = typeof err?.message === 'string' ? err.message : (typeof body?.errorMessage === 'string' ? body.errorMessage : `Vision Lambda error (${code})`);
    return new VisionError(code, message, { status });
}

const parseJson = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/**
 * One call. Returns the response object (v 1) or throws a VisionError
 * ({ code: photo_not_found | bad_request | model_unavailable | internal | not_configured | timeout | unreachable }).
 */
async function invoke(request) {
    if (env.VISION_LAMBDA_URL) {
        try {
            const res = await axios.post(env.VISION_LAMBDA_URL, request, {
                timeout: env.VISION_LAMBDA_TIMEOUT_S * 1000,
                headers: { 'Content-Type': 'application/json' },
                maxContentLength: 6 * 1024 * 1024,
                validateStatus: () => true
            });
            const body = typeof res.data === 'string' ? parseJson(res.data) : res.data;
            if (res.status >= 200 && res.status < 300 && body && !body.error) return checkResponse(body);
            throw errorOf(body, res.status >= 500 ? 'internal' : 'bad_request', res.status);
        } catch (err) {
            if (err instanceof VisionError) throw err;
            if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) throw new VisionError('timeout', 'The vision Lambda did not answer in time.', { cause: err });
            throw new VisionError('unreachable', `The vision Lambda cannot be reached: ${err.message}`, { cause: err });
        }
    }
    if (!env.VISION_LAMBDA_NAME) throw new VisionError('not_configured', 'Set VISION_LAMBDA_NAME or VISION_LAMBDA_URL.');
    const { InvokeCommand } = require('@aws-sdk/client-lambda');
    let res;
    try {
        res = await aws.getClient('lambda').send(new InvokeCommand({
            FunctionName: env.VISION_LAMBDA_NAME,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(request))
        }));
    } catch (err) {
        if (err?.name === 'TimeoutError' || /timeout/i.test(err?.message || '')) throw new VisionError('timeout', 'The vision Lambda did not answer in time.', { cause: err });
        if (err?.name === 'ResourceNotFoundException') throw new VisionError('not_configured', `Lambda ${env.VISION_LAMBDA_NAME} not found.`, { cause: err });
        throw new VisionError('unreachable', `Lambda invoke failed: ${err.message}`, { cause: err });
    }
    const text = res?.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
    const body = parseJson(text);
    if (res?.FunctionError || !body || body.error) throw errorOf(body, 'internal', res?.StatusCode || null);
    return checkResponse(body);
}

/** The response shape FlyBot relies on; anything missing becomes an "internal" error. */
function checkResponse(body) {
    if (!body || typeof body !== 'object') throw new VisionError('internal', 'Empty answer from the vision Lambda.');
    if (body.v !== undefined && Number(body.v) !== CONTRACT_VERSION) throw new VisionError('internal', `Unsupported contract version ${body.v}.`);
    if (!body.counts || typeof body.counts !== 'object') throw new VisionError('internal', 'The answer has no counts.');
    return body;
}

// ---------- Storing ----------

/** byClass with labels FlyBot can store (Map keys), the total under fruit_fly when there is no class list. */
function summaryOf(counts) {
    const byClass = counts?.byClass && typeof counts.byClass === 'object' ? counts.byClass : null;
    const out = {};
    if (byClass) {
        for (const [label, value] of Object.entries(byClass)) {
            if (!LABEL.test(label) || !Number.isFinite(Number(value))) continue;
            out[label] = Math.max(0, Math.round(Number(value)));
        }
    }
    if (!Object.keys(out).length) out[FRUIT_FLY] = Math.max(0, Math.round(Number(counts?.total) || 0));
    return out;
}

/** Normalised boxes {x, y, w, h, score, cls} -> aiResults.insects (pixels, [xmin, ymin, xmax, ymax]). */
function insectsOf(boxes, width, height) {
    if (!Array.isArray(boxes) || !width || !height) return [];
    return boxes.slice(0, MAX_BOXES).filter(b => b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)).map(b => ({
        name: typeof b.cls === 'string' && b.cls ? b.cls : FRUIT_FLY,
        confidence: Number.isFinite(b.score) ? Number(Number(b.score).toFixed(3)) : 1,
        bbox: [b.x * width, b.y * height, (b.x + b.w) * width, (b.y + b.h) * height].map(v => Math.round(v))
    }));
}

const clipJson = (value, max) => (value === undefined || value === null ? undefined : (Buffer.byteLength(JSON.stringify(value)) <= max ? value : { truncated: true }));

/** The $set for a detect answer (and the counts it makes the photo's result). */
function resultUpdate(response, { width, height, attempt, now = new Date() } = {}) {
    const summary = summaryOf(response.counts);
    const count = pestCountOf(summary);
    const model = response.model && typeof response.model === 'object' ? response.model : null;
    return {
        aiProcessed: true,
        aiProvider: 'opencv-lambda',
        pestCount: count,
        'aiResults.detected': count > 0,
        'aiResults.summary': summary,
        'aiResults.insects': insectsOf(response.boxes, width, height),
        'aiResults.raw_description': `OpenCV ${model?.name || 'lambda'} counted ${count} insect(s).`,
        lambda: {
            status: 'ok',
            attempts: attempt,
            analyzedAt: now,
            traceId: typeof response.traceId === 'string' ? response.traceId.slice(0, 100) : undefined,
            model: model || undefined,
            counts: clipJson(response.counts, 8 * 1024),
            boxes: clipJson(Array.isArray(response.boxes) ? response.boxes.slice(0, MAX_BOXES) : undefined, 256 * 1024),
            quality: clipJson(response.quality, 8 * 1024),
            diff: clipJson(response.diff, 8 * 1024),
            density: clipJson(response.density, 32 * 1024),
            proposals: clipJson(Array.isArray(response.proposals) ? response.proposals.slice(0, 10) : undefined, 16 * 1024),
            trace: clipJson(response.trace, 64 * 1024),
            evidence: clipJson(response.evidence, 16 * 1024),
            timings: clipJson(response.timings, 2 * 1024),
            width: width || undefined,
            height: height || undefined
        }
    };
}

/** Width and height of the photo: from the buffer given, else read back from storage. */
async function sizeOf(snapshot, buffer) {
    const { readImageSize } = require('./aiService');
    let bytes = buffer;
    if (!bytes) {
        try {
            bytes = await require('./s3Service').readS3Buffer(snapshot.s3Key);
        } catch (err) {
            console.warn(`⚠️ Photo ${snapshot.s3Key} not read for its size: ${err.message}`);
            return { width: snapshot.lambda?.width || null, height: snapshot.lambda?.height || null };
        }
    }
    const size = readImageSize(bytes);
    return { width: size?.width || null, height: size?.height || null };
}

const retryTimers = new Map();

/**
 * Analyze one stored photo (detect mode). Returns { ok: true, response } once the result is
 * stored, or { ok: false, error } (the photo is marked failed; the first failure schedules one
 * retry after retryDelayMs, whose success also runs the alerts and the webhook).
 */
async function analyzeSnapshot(snapshotId, { buffer = null, attempt = 1, locale = 'vi' } = {}) {
    const snapshot = await Snapshot.findById(snapshotId).lean();
    if (!snapshot) return { ok: false, error: new VisionError('photo_not_found', 'Photo not found.') };
    // A person's review is never overwritten by a late retry
    if (attempt > 1 && (snapshot.review?.status || snapshot.aiProcessed)) return { ok: false, error: new VisionError('bad_request', 'Already analyzed.') };
    const camera = await Camera.findOne({ deviceSerial: snapshot.deviceSerial }).lean();
    if (!camera) return { ok: false, error: new VisionError('bad_request', 'Camera not found.') };
    const now = new Date();
    try {
        const request = await buildRequest(snapshot, camera, { mode: 'detect', locale });
        const response = await invoke(request);
        const { width, height } = await sizeOf(snapshot, buffer);
        const update = resultUpdate(response, { width, height, attempt, now });
        await Snapshot.updateOne({ _id: snapshot._id }, { $set: update });
        const stored = await Snapshot.findById(snapshot._id);
        await require('./dailyStats').refreshForSnapshot(stored);
        console.log(`🤖 OpenCV Lambda processed snapshot ${snapshotId}: ${update.pestCount} insect(s), trace ${update.lambda.traceId || '-'} (attempt ${attempt})`);
        // The agent's proposals become confirm cards for the camera's owner (none without an owner)
        if (Array.isArray(response.proposals) && response.proposals.length && !isUnclaimed(camera)) {
            await require('./sentinelService').createLambdaProposals({ snapshot: stored, camera, proposals: response.proposals, traceId: update.lambda.traceId, evidence: response.evidence })
                .catch(err => console.error(`⚠️ Lambda proposals not stored (${snapshotId}):`, err.message));
        }
        return { ok: true, response, update };
    } catch (err) {
        const error = err instanceof VisionError ? err : new VisionError('internal', err.message, { cause: err });
        console.error(`❌ OpenCV Lambda failed for ${snapshotId} (attempt ${attempt}, ${error.code}): ${error.message}`);
        await Snapshot.updateOne({ _id: snapshot._id, aiProcessed: false }, {
            $set: { 'lambda.status': 'failed', 'lambda.attempts': attempt, 'lambda.error': { code: error.code, message: String(error.message).slice(0, 300), at: now } }
        }).catch(() => {});
        if (attempt < MAX_ATTEMPTS && error.code !== 'not_configured' && error.code !== 'photo_not_found') scheduleRetry(snapshotId, attempt + 1);
        return { ok: false, error };
    }
}

/** The retry itself: analyze again, then the alerts (latest photo only) and the webhook. */
async function runRetry(snapshotId, attempt) {
    retryTimers.delete(String(snapshotId));
    try {
        const result = await analyzeSnapshot(snapshotId, { attempt });
        if (!result.ok) return false;
        const snap = await Snapshot.findById(snapshotId).select('deviceSerial createdAt s3Key unclaimed').lean();
        if (!snap) return false;
        // A photo of an unclaimed camera alerts nobody and is not published
        if (snap.unclaimed) return true;
        const captureJob = require('../cron/captureJob');
        const newer = await Snapshot.exists({ deviceSerial: snap.deviceSerial, createdAt: { $gt: snap.createdAt } });
        if (!newer) await captureJob.checkAlerts(snap.deviceSerial, snap._id);
        await require('./snapshotEvents').emitAnalyzed(snap._id);
        return true;
    } catch (err) {
        console.error(`❌ OpenCV Lambda retry crashed (${snapshotId}):`, err.message);
        return false;
    }
}

/** The one retry after a failure, in the background (CONTRACTS: "retries once after 30 s"). */
function scheduleRetry(snapshotId, attempt) {
    const key = String(snapshotId);
    if (retryTimers.has(key)) return;
    const timer = setTimeout(() => runRetry(snapshotId, attempt), retryDelayMs);
    timer.unref?.();
    retryTimers.set(key, { timer, attempt });
}

/** Tests: retries still waiting. */
function pendingRetries() {
    return retryTimers.size;
}

/** Tests: run every waiting retry now instead of after the delay. */
async function flushRetries() {
    const waiting = [...retryTimers.entries()];
    for (const [key, { timer, attempt }] of waiting) {
        clearTimeout(timer);
        await runRetry(key, attempt);
    }
    return waiting.length;
}

/**
 * Deep mode: a question about one photo (the chatbot's analyze_photo_deep tool). Returns the
 * Lambda's answer; the question, answer and trace are kept on the photo (last DEEP_KEPT).
 */
async function deepAnalyze(snapshot, camera, { question, locale = 'vi' } = {}) {
    // CONTRACTS 2a.5: LLM deep analysis for claimed cameras only
    if (isUnclaimed(camera)) throw new VisionError('bad_request', 'Deep analysis needs a claimed camera.');
    const request = await buildRequest(snapshot, camera, { mode: 'deep', question, locale });
    const response = await invoke(request);
    const entry = {
        at: new Date(),
        question: String(question || '').slice(0, 1000),
        answer: typeof response.answer === 'string' ? response.answer.slice(0, 8000) : '',
        traceId: typeof response.traceId === 'string' ? response.traceId.slice(0, 100) : null,
        counts: clipJson(response.counts, 4 * 1024) ?? null,
        trace: clipJson(response.trace, 32 * 1024) ?? null,
        proposals: clipJson(Array.isArray(response.proposals) ? response.proposals.slice(0, 10) : undefined, 8 * 1024) ?? null
    };
    await Snapshot.updateOne({ _id: snapshot._id }, { $push: { 'lambda.deep': { $each: [entry], $slice: -DEEP_KEPT } } }).catch(err => console.warn('⚠️ Deep analysis not stored:', err.message));
    return { ...response, answer: entry.answer };
}

module.exports = {
    isUnclaimed,
    CONTRACT_VERSION,
    RETRY_DELAY_MS,
    MAX_ATTEMPTS,
    VisionError,
    isConfigured,
    isLambdaProvider,
    setRetryDelay,
    photoRef,
    buildRequest,
    invoke,
    checkResponse,
    summaryOf,
    insectsOf,
    resultUpdate,
    analyzeSnapshot,
    pendingRetries,
    flushRetries,
    deepAnalyze
};
