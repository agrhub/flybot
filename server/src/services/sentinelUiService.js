const mongoose = require('mongoose');
const env = require('../config/env');
const { Camera, Snapshot, SentinelProposal, User } = require('../models');
const { canViewSentinel, canDecideSentinel } = require('../constants/roles');
const { trapKindOf } = require('../constants/trap');
const { viewFilter } = require('../utils/ownership');
const { normalizeLanguage } = require('../utils/i18n');
const { reasonIn } = require('./sentinelService');

/**
 * Server side of the Sentinel console (routes/sentinelUiRoutes.js): the pages Overview, Traces,
 * Approvals and Devices, read from MongoDB. A "trace" is a photo analyzed by the vision Lambda
 * (Snapshot.lambda: counts, quality, diff, proposals, trace, evidence); an "approval" is a
 * SentinelProposal (the confirm card a person decides); a "device" is a camera.
 *
 * The answers keep the shape the console pages were written for (the previous Sentinel UI API),
 * so the pages did not change: event_id, approval_id, serial, snake_case fields.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
// Evidence pictures the console may show: FlyBot's photos and the Lambda's evidence objects
const EVIDENCE_KEY = /^(snapshots|evidence|frames)\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9_./-]{1,300}\.(jpe?g|png|webp)$/i;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const isEnabled = () => env.AI_PROVIDER === 'opencv-lambda' || env.SENTINEL_CONSOLE;

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

/** "Name <email>" of the person deciding, for the audit trail. */
function deciderName(user) {
    const name = String(user?.name || '').trim();
    const email = String(user?.email || '').trim();
    return name && email ? `${name} <${email}>` : (email || name || String(user?.id || ''));
}

// ---------- Scope ----------

/** The cameras this person may see (admins: all), by serial. */
async function visibleCameras(user) {
    const cameras = await Camera.find(viewFilter(user)).select('deviceSerial deviceName trapKind platform status device latitude longitude sentinelCaptures captureIntervalMinutes thumbnailUrl lastSync').lean();
    return new Map(cameras.map(c => [c.deviceSerial, c]));
}

const toPlain = (map) => (map instanceof Map ? Object.fromEntries(map) : { ...(map || {}) });
const iso = (d) => (d ? new Date(d).toISOString() : null);
const PROPOSAL_STATUS = { pending: 'pending', confirmed: 'approved', rejected: 'rejected', failed: 'rejected', expired: 'expired' };

// ---------- Traces (analyzed photos) ----------

const traceIdOf = (snap) => snap.lambda?.traceId || `snap_${snap._id}`;
const traceFilter = { $or: [{ 'lambda.status': { $in: ['ok', 'failed'] } }, { aiProvider: 'opencv-lambda' }] };

/** The viewer's language: the app's X-Language when it is one we have, else the account's. */
const languageFor = (user, lang) => normalizeLanguage(['vi', 'en'].includes(lang) ? lang : user?.language);

function decisionsOf(snap, lang) {
    return (snap.lambda?.proposals || []).map(p => ({
        rule: p.action || 'proposal',
        action: p.action || 'proposal',
        reasons: [reasonIn(p, lang), Number.isFinite(p.confidence) ? `confidence ${p.confidence}` : null].filter(Boolean),
        params: p.params || {}
    }));
}

/**
 * What the console draws on one of FlyBot's photos: the vision Lambda's boxes and the face regions
 * to blur (all normalised), with the photo's size for the frame. The Lambda stores no picture.
 */
function overlayOf(snap) {
    const lambda = snap?.lambda;
    if (!lambda) return null;
    const privacy = lambda.privacy || {};
    return {
        boxes: (Array.isArray(lambda.boxes) ? lambda.boxes : []).slice(0, 500).map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
        privacy: { regions: Array.isArray(privacy.regions) ? privacy.regions.slice(0, 50) : [], blurAll: !!privacy.blurAll },
        width: lambda.width || null,
        height: lambda.height || null
    };
}

const overlaysOf = (...snaps) => Object.fromEntries(snaps.filter(s => s?.s3Key && s.lambda).map(s => [s.s3Key, overlayOf(s)]));

const OVERLAY_FIELDS = 's3Key lambda.boxes lambda.privacy lambda.width lambda.height';

function approvalOf(proposal, snap = null, lang = null) {
    if (!proposal) return null;
    // The pictures a person decides on: the photo the proposal came from (boxes drawn by the console), then any other evidence
    const pictures = [snap?.s3Key, ...(proposal.evidence || []).map(e => e.url || e.ref)];
    return {
        approval_id: String(proposal._id),
        event_id: proposal.traceId || null,
        kind: proposal.type,
        status: PROPOSAL_STATUS[proposal.state] || proposal.state,
        cameras: proposal.deviceSerials || [],
        created_at: iso(proposal.createdAt),
        expires_at: iso(proposal.expiresAt),
        decided_at: iso(proposal.decidedAt),
        decided_by: proposal.decidedVia ? `${proposal.decidedVia}` : null,
        on_timeout: 'no_op',
        source: proposal.source || 'sentinel',
        flybot_proposal_id: String(proposal._id),
        payload: {
            action: proposal.payload?.action || proposal.type,
            params: proposal.payload?.params || {},
            reason: lang ? reasonIn(proposal, lang) : proposal.reason || '',
            ...(proposal.result ? { result: proposal.result } : {})
        },
        evidence: [...new Set(pictures.filter(v => typeof v === 'string' && v))],
        overlays: overlaysOf(snap)
    };
}

/** The slim list item of one analyzed photo. */
function slimTrace(snap, camera, proposal, lang) {
    const lambda = snap.lambda || {};
    const flags = lambda.quality?.flags || [];
    const planner = lambda.trace?.planner || 'rule';
    const actions = (lambda.proposals || []).map(p => p.action).filter(Boolean);
    return {
        event_id: traceIdOf(snap),
        snapshot_id: String(snap._id),
        camera: snap.deviceSerial,
        camera_name: camera?.deviceName || snap.deviceSerial,
        source: camera?.platform || 'ezviz',
        trap_kind: camera ? trapKindOf(camera) : null,
        created_at: iso(lambda.analyzedAt || snap.createdAt),
        captured_at: iso(snap.createdAt),
        state: lambda.status === 'failed' ? 'failed' : 'done',
        outcome: lambda.status === 'failed' ? `failed: ${lambda.error?.code || 'error'}` : (actions.length ? `proposed: ${actions.join(', ')}` : 'no_op'),
        counts: { opencv: Number.isFinite(lambda.counts?.total) ? lambda.counts.total : null, npu: null, production: Number.isFinite(snap.pestCount) ? snap.pestCount : null },
        quality: { ok: lambda.quality?.ok !== false && !flags.length, issues: flags },
        decisions: decisionsOf(snap, lang),
        approval: proposal ? { approval_id: String(proposal._id), kind: proposal.type, status: PROPOSAL_STATUS[proposal.state] || proposal.state } : null,
        planner: { name: planner, fallback: false, model: lambda.model?.name || null },
        image: snap.s3Key,
        trace_ms: lambda.trace?.ms ?? lambda.timings?.totalMs ?? null
    };
}

/** The full trace: Perception (opencv_outputs) -> Decision (decisions, planner) -> Action (tool_calls, approval). */
async function fullTrace(snap, camera, proposals, lang) {
    const lambda = snap.lambda || {};
    const slim = slimTrace(snap, camera, proposals[0], lang);
    const previous = await Snapshot.findOne({ deviceSerial: snap.deviceSerial, aiProcessed: true, createdAt: { $lt: snap.createdAt } }).sort({ createdAt: -1 }).select(OVERLAY_FIELDS).lean();
    // The Lambda stores no picture: the photos are FlyBot's, the console draws the boxes (overlays)
    const evidence = [];
    const diff = lambda.diff;
    const total = lambda.counts?.total;
    const steps = Array.isArray(lambda.trace?.steps) ? lambda.trace.steps : [];
    const deep = Array.isArray(lambda.deep) ? lambda.deep : [];
    return {
        ...slim,
        opencv_outputs: {
            [snap.deviceSerial]: {
                camera: snap.deviceSerial,
                event_id: slim.event_id,
                counts: slim.counts,
                by_class: lambda.counts?.byClass || {},
                quality: {
                    ok: slim.quality.ok,
                    issues: slim.quality.issues,
                    scores: Object.fromEntries(['blur', 'exposure'].filter(k => Number.isFinite(lambda.quality?.[k])).map(k => [k, lambda.quality[k]]))
                },
                new_catch: diff ? {
                    new_count: diff.newCount ?? null,
                    disappeared_count: diff.goneCount ?? null,
                    persisted_count: Number.isFinite(total) && Number.isFinite(diff.newCount) ? Math.max(0, total - diff.newCount) : null,
                    card_change_suspected: !!diff.cardMoved,
                    card_change_reasons: diff.cardMoved ? ['card moved'] : []
                } : null,
                density: lambda.density || null,
                image: snap.s3Key,
                previous_image: previous?.s3Key || null,
                evidence,
                analyzer: lambda.model ? [lambda.model.name, lambda.model.version, lambda.model.engine].filter(Boolean).join(' / ') : null,
                vision_ms: lambda.timings?.dnnMs ?? null,
                battery_percent: snap.meta?.battery?.pct ?? null,
                boxes: Array.isArray(lambda.boxes) ? lambda.boxes.length : (snap.aiResults?.insects || []).length
            }
        },
        planner: {
            name: lambda.trace?.planner || 'rule',
            fallback: false,
            model: lambda.model?.name || null,
            llm_turns: steps.filter(s => s.tool === 'llm' || s.tool === 'planner').length,
            tokens: lambda.trace?.tokens || null
        },
        reasoning_summary: deep.length ? deep.at(-1).answer : (lambda.proposals || []).map(p => reasonIn(p, lang)).filter(Boolean).join(' ') || null,
        tool_calls: steps.map((s, index) => ({
            index,
            name: s.tool || s.name || `step ${index + 1}`,
            status: s.error ? 'error' : 'ok',
            ms: s.ms ?? null,
            started_at: slim.created_at,
            args: s.args || {},
            result: s.result || (s.error ? { error: s.error } : {}),
            by: 'agent'
        })),
        device_ack: [],
        events: lambda.status === 'failed' ? [{ kind: 'analysis_failed', at: iso(lambda.error?.at || snap.createdAt), detail: { reason: lambda.error?.message || lambda.error?.code } }] : [],
        approval: proposals[0] ? approvalOf(proposals[0], snap, lang) : null,
        approvals: proposals.map(p => approvalOf(p, snap, lang)),
        deep: deep.map(d => ({ at: iso(d.at), question: d.question, answer: d.answer, trace_id: d.traceId })),
        timings: lambda.timings || null,
        model: lambda.model || null,
        evidence_keys: evidence,
        overlays: overlaysOf(snap, previous)
    };
}

/** GET traces: newest first, filtered by camera and time, paged by a createdAt cursor. */
async function traces({ user, camera, since, until, limit, cursor, lang }) {
    const cameras = await visibleCameras(user);
    const serials = camera ? (cameras.has(camera) ? [camera] : []) : [...cameras.keys()];
    if (!serials.length) return { items: [], next: null };
    const filter = { deviceSerial: { $in: serials }, ...traceFilter };
    const time = {};
    if (since && !isNaN(new Date(since))) time.$gte = new Date(since);
    if (until && !isNaN(new Date(until))) time.$lte = new Date(until);
    if (cursor && !isNaN(new Date(cursor))) time.$lt = new Date(cursor);
    if (Object.keys(time).length) filter.createdAt = time;
    const size = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const rows = await Snapshot.find(filter).sort({ createdAt: -1 }).limit(size + 1)
        .select('deviceSerial createdAt s3Key pestCount aiProvider lambda.status lambda.error lambda.traceId lambda.analyzedAt lambda.counts lambda.quality lambda.proposals lambda.trace lambda.model lambda.timings').lean();
    const page = rows.slice(0, size);
    const proposals = await SentinelProposal.find({ snapshotId: { $in: page.map(r => r._id) } }).sort({ createdAt: -1 }).lean();
    const bySnapshot = new Map();
    for (const p of proposals) if (!bySnapshot.has(String(p.snapshotId))) bySnapshot.set(String(p.snapshotId), p);
    return {
        items: page.map(snap => slimTrace(snap, cameras.get(snap.deviceSerial), bySnapshot.get(String(snap._id)), languageFor(user, lang))),
        next: rows.length > size ? iso(page.at(-1).createdAt) : null
    };
}

/** GET traces/:id — by trace id (tr_...) or snapshot id (snap_<id> or the id itself). */
async function trace({ user, id, lang }) {
    const cameras = await visibleCameras(user);
    const raw = String(id || '');
    const snapId = raw.startsWith('snap_') ? raw.slice(5) : raw;
    const query = mongoose.isValidObjectId(snapId) ? { _id: snapId } : { 'lambda.traceId': raw };
    const snap = await Snapshot.findOne(query).lean();
    if (!snap || !cameras.has(snap.deviceSerial)) return null;
    const proposals = await SentinelProposal.find({ snapshotId: snap._id }).sort({ createdAt: -1 }).lean();
    return { trace: await fullTrace(snap, cameras.get(snap.deviceSerial), proposals, languageFor(user, lang)), media: {} };
}

// ---------- Summary ----------

async function summary({ user, hours = 24 }) {
    const cameras = await visibleCameras(user);
    const serials = [...cameras.keys()];
    const since = new Date(Date.now() - Math.min(Math.max(Number(hours) || 24, 1), 168) * 3600 * 1000);
    const [photos, bySource, lastPhoto, proposalsPending, decisions, planners] = await Promise.all([
        Snapshot.countDocuments({ deviceSerial: { $in: serials }, createdAt: { $gte: since }, ...traceFilter }),
        Snapshot.aggregate([{ $match: { deviceSerial: { $in: serials }, createdAt: { $gte: since } } }, { $group: { _id: '$deviceSerial', n: { $sum: 1 } } }]),
        Snapshot.findOne({ deviceSerial: { $in: serials }, ...traceFilter }).sort({ createdAt: -1 }).select('createdAt').lean(),
        SentinelProposal.countDocuments({ deviceSerials: { $in: serials }, state: 'pending', expiresAt: { $gt: new Date() } }),
        Snapshot.aggregate([
            { $match: { deviceSerial: { $in: serials }, createdAt: { $gte: since }, ...traceFilter } },
            { $project: { actions: { $ifNull: [{ $map: { input: { $ifNull: ['$lambda.proposals', []] }, as: 'p', in: '$$p.action' } }, []] } } },
            { $project: { actions: { $cond: [{ $gt: [{ $size: '$actions' }, 0] }, '$actions', ['no_op']] } } },
            { $unwind: '$actions' },
            { $group: { _id: '$actions', n: { $sum: 1 } } }
        ]),
        Snapshot.aggregate([
            { $match: { deviceSerial: { $in: serials }, createdAt: { $gte: since }, 'lambda.trace.planner': { $exists: true } } },
            { $group: { _id: '$lambda.trace.planner', n: { $sum: 1 } } }
        ])
    ]);
    const photosBySource = {};
    for (const row of bySource) {
        const source = cameras.get(row._id)?.platform || 'ezviz';
        photosBySource[source] = (photosBySource[source] || 0) + row.n;
    }
    const online = serials.filter(s => Number(cameras.get(s)?.status) === 1).length;
    const llm = planners.find(p => p._id === 'llm')?.n || 0;
    return {
        role: canDecideSentinel(user) ? 'operator' : 'judge',
        hours: Number(hours) || 24,
        photos,
        photos_by_source: photosBySource,
        decisions: Object.fromEntries(decisions.map(d => [d._id, d.n])),
        proposals_pending: proposalsPending,
        devices: { online, total: serials.length },
        planner_mode: llm > 0 ? 'llm' : 'rule',
        planner_fallbacks: 0,
        last_photo_at: iso(lastPhoto?.createdAt),
        kill_switch: { global: false, cameras: [] },
        provider: env.AI_PROVIDER,
        lambda: env.VISION_LAMBDA_URL ? 'local' : (env.VISION_LAMBDA_NAME || null)
    };
}

// ---------- Approvals ----------

const STATE_OF_STATUS = { pending: ['pending'], approved: ['confirmed'], rejected: ['rejected', 'failed'], expired: ['expired'] };

async function approvals({ user, status, limit, lang }) {
    const cameras = await visibleCameras(user);
    const serials = [...cameras.keys()];
    const size = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const filter = { deviceSerials: { $in: serials } };
    if (status && STATE_OF_STATUS[status]) filter.state = { $in: STATE_OF_STATUS[status] };
    // Pending ones past their time read as expired
    const rows = await SentinelProposal.find(filter).sort({ createdAt: -1 }).limit(size).lean();
    const snaps = await photosOf(rows);
    const now = new Date();
    const items = rows.map(p => approvalOf(p.state === 'pending' && p.expiresAt <= now ? { ...p, state: 'expired' } : p, snaps.get(String(p.snapshotId)), languageFor(user, lang)));
    return { items: status === 'pending' ? items.filter(a => a.status === 'pending') : items, next: null };
}

async function approval({ user, id, lang }) {
    if (!mongoose.isValidObjectId(id)) return null;
    const cameras = await visibleCameras(user);
    const p = await SentinelProposal.findById(id).lean();
    if (!p || !p.deviceSerials.some(s => cameras.has(s))) return null;
    const snaps = await photosOf([p]);
    const now = new Date();
    return { approval: approvalOf(p.state === 'pending' && p.expiresAt <= now ? { ...p, state: 'expired' } : p, snaps.get(String(p.snapshotId)), languageFor(user, lang)), media: {} };
}

/** The photos proposals came from, by id (only their picture keys). */
async function photosOf(proposals) {
    const ids = [...new Set(proposals.map(p => p.snapshotId).filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const snaps = await Snapshot.find({ _id: { $in: ids } }).select(OVERLAY_FIELDS).lean();
    return new Map(snaps.map(s => [String(s._id), s]));
}

/**
 * Approve or reject: the proposal's confirm card is decided as its owner would in the chat panel
 * (the same claim-once rule), on behalf of the person deciding here. Only the camera owner's
 * card exists, so an admin or manager decides it for the owner.
 */
async function decide({ user, id, decision, req }) {
    if (!mongoose.isValidObjectId(id)) throw new SentinelUpstreamError(404, 'NOT_FOUND', 'Not found.');
    const p = await SentinelProposal.findById(id).lean();
    const cameras = await visibleCameras(user);
    if (!p || !p.deviceSerials.some(s => cameras.has(s))) throw new SentinelUpstreamError(404, 'NOT_FOUND', 'Not found.');
    if (p.state !== 'pending') throw new SentinelUpstreamError(409, 'CONFLICT', 'This approval was already decided.');
    // Deciding runs the camera's action: the person must be able to manage one of its cameras
    const { canManageCamera } = require('../utils/ownership');
    const own = await Camera.find({ deviceSerial: { $in: p.deviceSerials } }).select('userId sharedWith unclaimed selfRegistered').lean();
    if (!own.some(c => canManageCamera(user, c))) throw new SentinelUpstreamError(403, 'FORBIDDEN', 'You cannot decide for this camera.');
    const owner = await User.findById(p.userId);
    if (!owner) throw new SentinelUpstreamError(409, 'CONFLICT', 'The proposal owner is gone.');
    const { decideCard } = require('../controllers/aiController');
    const { userContext } = require('./sentinelService');
    const { status, body } = await decideCard({
        user: userContext(owner),
        sessionId: p.sessionId,
        messageId: p.messageId,
        cardIndex: p.cardIndex,
        decision: decision === 'approve' ? 'confirm' : 'cancel',
        req,
        via: 'app'
    });
    if (status === 409) throw new SentinelUpstreamError(409, 'CONFLICT', 'This approval was already decided.');
    return { queued: true, applied: true, approval_id: String(p._id), decision, state: body.state, message: body.message || null };
}

// ---------- Devices ----------

function deviceOf(camera, lastPhoto) {
    const d = camera.device || {};
    const sleeping = !!d.sleeping && (!d.wakeAt || new Date(d.wakeAt) > new Date());
    return {
        serial: camera.deviceSerial,
        name: camera.deviceName || camera.deviceSerial,
        online: Number(camera.status) === 1 && !sleeping,
        trap_kind: trapKindOf(camera),
        source: camera.platform || 'ezviz',
        fw: d.fw || null,
        net: d.net || null,
        battery_percent: d.battery?.pct ?? null,
        rssi: d.rssi ?? null,
        telemetry: { battery_percent: d.battery?.pct ?? null, rssi: d.rssi ?? null },
        telemetry_at: iso(d.lastSeenAt),
        last_seen_at: iso(d.lastSeenAt || camera.lastSync),
        last_photo: lastPhoto ? { key: lastPhoto.s3Key, at: iso(lastPhoto.createdAt), count: lastPhoto.pestCount ?? null } : null,
        lat: camera.latitude ?? d.location?.lat ?? null,
        lon: camera.longitude ?? d.location?.lng ?? null,
        power_mode: d.power?.mode || (camera.platform === 'camos' ? 'auto' : 'powered'),
        sleeping,
        wake_at: sleeping ? iso(d.wakeAt) : null,
        reported: d.shadow?.reported || null,
        desired: d.shadow?.desired || null,
        reported_version: d.shadow?.reported?.version ?? null,
        desired_version: d.shadow?.desired?.version ?? null,
        capture_interval_min: camera.captureIntervalMinutes,
        agent_state: { budgets: { captures_used: camera.sentinelCaptures?.count || 0, captures_limit: env.SENTINEL_CAPTURE_BUDGET } },
        kill_switch: false
    };
}

async function devices({ user }) {
    const cameras = await visibleCameras(user);
    const serials = [...cameras.keys()];
    const latest = await Snapshot.aggregate([
        { $match: { deviceSerial: { $in: serials } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$deviceSerial', s3Key: { $first: '$s3Key' }, createdAt: { $first: '$createdAt' }, pestCount: { $first: '$pestCount' } } }
    ]);
    const lastBySerial = new Map(latest.map(l => [l._id, l]));
    return { items: serials.sort().map(s => deviceOf(cameras.get(s), lastBySerial.get(s))) };
}

async function device({ user, serial }) {
    const cameras = await visibleCameras(user);
    const camera = cameras.get(serial);
    if (!camera) return null;
    const lastPhoto = await Snapshot.findOne({ deviceSerial: serial }).sort({ createdAt: -1 }).select('s3Key createdAt pestCount').lean();
    const history = await Snapshot.find({ deviceSerial: serial, 'meta.battery.pct': { $exists: true } }).sort({ createdAt: -1 }).limit(60).select('createdAt meta.battery.pct meta.rssi').lean();
    return {
        device: {
            ...deviceOf(camera, lastPhoto),
            telemetry_history: history.reverse().map(h => ({ at: iso(h.createdAt), battery_percent: h.meta?.battery?.pct ?? null, rssi: h.meta?.rssi ?? null }))
        },
        media: {}
    };
}

// ---------- Evidence pictures ----------

const isEvidenceKey = (key) => typeof key === 'string' && key.length <= 400 && !key.includes('..') && EVIDENCE_KEY.test(key);

/** The camera serial an evidence key belongs to (second path segment). */
const serialOfKey = (key) => (EVIDENCE_KEY.exec(key) || [])[2] || null;

/**
 * The picture bytes for the console, from FlyBot's own bucket (photos and the Lambda's
 * evidence objects live there). Returns { body (Readable), contentType, contentLength } or
 * throws SentinelUpstreamError (404 / 502).
 */
async function fetchEvidence({ user, key }) {
    if (!isEvidenceKey(key)) throw new SentinelUpstreamError(400, 'BAD_REQUEST', 'Invalid key.');
    const cameras = await visibleCameras(user);
    if (!cameras.has(serialOfKey(key))) throw new SentinelUpstreamError(404, 'NOT_FOUND', 'Not found.');
    let object;
    try {
        object = await require('./s3Service').getS3Object(key);
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) throw new SentinelUpstreamError(404, 'NOT_FOUND', 'This file is no longer available.');
        throw new SentinelUpstreamError(502, 'SENTINEL_STORAGE', 'Sentinel storage is not answering correctly.');
    }
    if (object.ContentLength && object.ContentLength > MAX_MEDIA_BYTES) throw new SentinelUpstreamError(413, 'TOO_LARGE', 'This file is too large to show here.');
    return { body: object.Body, contentType: object.ContentType || 'image/jpeg', contentLength: object.ContentLength || null, etag: object.ETag || null };
}

module.exports = {
    MAX_MEDIA_BYTES,
    SentinelUpstreamError,
    isEnabled,
    accessFor,
    deciderName,
    summary,
    traces,
    trace,
    approvals,
    approval,
    decide,
    devices,
    device,
    isEvidenceKey,
    fetchEvidence,
    // For tests
    slimTrace,
    approvalOf
};
