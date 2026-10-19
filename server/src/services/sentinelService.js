const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../config/env');
const { Camera, Snapshot, User, Plot, ChatSession, SentinelProposal } = require('../models');
const { MAX_CHAT_MESSAGES } = require('../models/ChatSession');
const { pestCountOf } = require('../models/Snapshot');
const { roleOf } = require('../constants/roles');
const { CAPTURE_INTERVALS, TIMEZONE, isDaytime } = require('./captureSchedule');
const { dayKeyOf } = require('./dailyStats');
const { recordAudit } = require('./auditService');
const { translate, normalizeLanguage } = require('../utils/i18n');
const { escapeHtml } = require('./emailTemplates');
const { createQuota } = require('../middlewares/rateLimit');
const { ACTOR } = require('../middlewares/sentinelAuth');

/**
 * FlyBot Sentinel internal API (routes/sentinelRoutes.js): what the AWS agent may do in FlyBot.
 * Every function returns { status, body } for the HTTP answer. Nothing here changes a farm's
 * records by itself: card changes and treatments are proposals a person confirms.
 * Messages are English only: the caller is the Sentinel agent (machine to machine, no
 * X-Language); what people see (card, Telegram, notification) comes from the locale files.
 */

// The ChatSession that holds Sentinel's confirm cards for each person (shown in the assistant panel)
const SENTINEL_SESSION = 'sentinel';
const MAX_INTERVAL_HOURS = 72;
const MAX_EVIDENCE = 4;
// Longer lists are accepted and cut to MAX_EVIDENCE (pictures first)
const MAX_EVIDENCE_IN = 20;
const MAX_REASON = 1000;
const SERIAL = /^[A-Za-z0-9_-]{1,64}$/;
// Count labels are stored as Map keys: no dots, no leading $
const LABEL = /^[^.$][^.]{0,59}$/;
const BOX_FORMATS = ['xyxy_pixels', 'xyxy_normalized'];
const MAX_BOXES = 1000;

// Several extra captures of one camera in a burst (on top of the daily budget)
const burstQuota = createQuota({ windowMs: 60 * 1000, max: 3 });

const fail = (status, code, message, extra = {}) => ({ status, body: { success: false, code, message, ...extra } });
const ok = (body, status = 200) => ({ status, body: { success: true, ...body } });
const audit = (req, entry) => recordAudit(req, { actor: ACTOR, ...entry });
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const clip = (value, max) => String(value ?? '').slice(0, max);

/** The person as the request handlers see one (middlewares/auth.js req.user). */
function userContext(user) {
    return {
        id: String(user._id),
        email: user.email,
        name: user.name || String(user.email || '').split('@')[0],
        emailVerified: !!user.emailVerified,
        language: user.language,
        role: roleOf(user)
    };
}

// ---------- Capture ----------

/**
 * One extra capture of the camera's budget for today (farm day), taken atomically.
 * Returns { ok, used }.
 */
async function takeCaptureBudget(deviceSerial, now = new Date()) {
    const limit = env.SENTINEL_CAPTURE_BUDGET;
    const day = dayKeyOf(now);
    if (limit < 1) return { ok: false, used: 0, day };
    const inc = await Camera.findOneAndUpdate(
        { deviceSerial, 'sentinelCaptures.day': day, 'sentinelCaptures.count': { $lt: limit } },
        { $inc: { 'sentinelCaptures.count': 1 } },
        { returnDocument: 'after' }
    ).select('sentinelCaptures').lean();
    if (inc) return { ok: true, used: inc.sentinelCaptures.count, day };
    const fresh = await Camera.findOneAndUpdate(
        { deviceSerial, 'sentinelCaptures.day': { $ne: day } },
        { $set: { sentinelCaptures: { day, count: 1 } } },
        { returnDocument: 'after' }
    ).select('sentinelCaptures').lean();
    if (fresh) return { ok: true, used: 1, day };
    return { ok: false, used: limit, day };
}

/** POST /capture { deviceSerial } */
async function capture(body, req, now = new Date()) {
    const deviceSerial = String(body?.deviceSerial || '');
    if (!SERIAL.test(deviceSerial)) return fail(400, 'INVALID_REQUEST', 'deviceSerial is required.');
    const camera = await Camera.findOne({ deviceSerial }).select('deviceSerial deviceName captureDaytimeOnly').lean();
    if (!camera) return fail(404, 'CAMERA_NOT_FOUND', 'Camera not found.');
    // The camera's own setting: no photos at night
    if (camera.captureDaytimeOnly && !isDaytime(now)) {
        return fail(409, 'QUIET_HOURS', 'This camera only takes photos in daytime (06:00-18:00 farm time).');
    }
    const limit = env.SENTINEL_CAPTURE_BUDGET;
    if (!burstQuota.take(deviceSerial)) {
        return fail(429, 'RATE_LIMITED', 'Too many captures of this camera in the last minute.', { retryAfterSeconds: burstQuota.retryAfterSeconds(deviceSerial) });
    }
    const budget = await takeCaptureBudget(deviceSerial, now);
    if (!budget.ok) {
        return fail(429, 'BUDGET_EXHAUSTED', `The daily budget of ${limit} extra captures for this camera is used up.`, { budget: { used: budget.used, limit, day: budget.day } });
    }
    const budgetInfo = { used: budget.used, limit, day: budget.day };
    // Lazy: captureJob pulls in the AI and S3 services
    const { captureAndSaveSnapshot } = require('../cron/captureJob');
    const saved = await captureAndSaveSnapshot(deviceSerial, { trigger: 'sentinel' });
    audit(req, {
        action: 'sentinel.capture',
        target: { type: 'camera', id: deviceSerial, label: camera.deviceName || deviceSerial },
        details: { ok: !!saved, snapshotId: saved ? String(saved._id) : null, budgetUsed: budget.used, budgetLimit: limit }
    });
    if (!saved) {
        return fail(502, 'CAPTURE_FAILED', 'The camera did not return an image. It may be offline.', { status: 'failed', budget: budgetInfo });
    }
    const snapshot = await Snapshot.findById(saved._id).select('aiProcessed pestCount createdAt').lean();
    const status = snapshot?.aiProcessed ? 'analyzed'
        : require('./aiService').isSentinelMode() ? 'awaiting_analysis' : 'analysis_failed';
    return ok({
        snapshotId: String(saved._id),
        status,
        capturedAt: snapshot?.createdAt || saved.createdAt,
        count: snapshot?.aiProcessed ? snapshot.pestCount ?? null : null,
        budget: budgetInfo
    });
}

/** POST /capture-interval { deviceSerial, intervalMinutes, untilISO, reason? } (intervalMinutes null = back to normal) */
async function setCaptureInterval(body, req, now = new Date()) {
    const deviceSerial = String(body?.deviceSerial || '');
    if (!SERIAL.test(deviceSerial)) return fail(400, 'INVALID_REQUEST', 'deviceSerial is required.');
    const camera = await Camera.findOne({ deviceSerial }).select('deviceSerial deviceName captureIntervalMinutes captureDaytimeOnly').lean();
    if (!camera) return fail(404, 'CAMERA_NOT_FOUND', 'Camera not found.');
    const label = camera.deviceName || deviceSerial;

    if (body.intervalMinutes === null) {
        await Camera.updateOne({ deviceSerial }, { $unset: { sentinelInterval: 1 } });
        audit(req, { action: 'sentinel.capture_interval', target: { type: 'camera', id: deviceSerial, label }, details: { cleared: true } });
        return ok({ deviceSerial, sentinelInterval: null, cameraIntervalMinutes: camera.captureIntervalMinutes });
    }
    const minutes = body.intervalMinutes;
    if (!CAPTURE_INTERVALS.includes(minutes)) {
        return fail(400, 'INVALID_INTERVAL', `intervalMinutes must be one of ${CAPTURE_INTERVALS.join(', ')} (or null to clear).`);
    }
    const until = new Date(body.untilISO);
    if (typeof body.untilISO !== 'string' || isNaN(until) || until <= now || until > new Date(now.getTime() + MAX_INTERVAL_HOURS * 3600 * 1000)) {
        return fail(400, 'INVALID_UNTIL', `untilISO must be a date-time in the next ${MAX_INTERVAL_HOURS} hours.`);
    }
    const sentinelInterval = { minutes, until, setAt: now, reason: clip(body.reason, 300) };
    await Camera.updateOne({ deviceSerial }, { $set: { sentinelInterval } });
    audit(req, {
        action: 'sentinel.capture_interval',
        target: { type: 'camera', id: deviceSerial, label },
        details: { minutes, until: until.toISOString(), reason: sentinelInterval.reason }
    });
    return ok({
        deviceSerial,
        sentinelInterval: { minutes, until: until.toISOString() },
        cameraIntervalMinutes: camera.captureIntervalMinutes,
        daytimeOnly: !!camera.captureDaytimeOnly
    });
}

// ---------- Proposals ----------

const PROPOSAL_STATE_OF_CARD = { done: 'confirmed', cancelled: 'rejected', failed: 'failed', expired: 'expired' };

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * An evidence item as the agent may send it: an object, or a bare string (an https link, a
 * snapshot id, or another reference such as s3://bucket/key, kept as text only).
 */
function evidenceItem(item) {
    if (typeof item !== 'string') return item;
    const value = item.trim();
    if (OBJECT_ID.test(value)) return { snapshotId: value };
    if (/^https:\/\//i.test(value)) return { url: value };
    return { ref: value };
}

/**
 * Check the evidence list: 1 to MAX_EVIDENCE_IN items, each an https link, a photo of these
 * cameras, or a text reference. When more than MAX_EVIDENCE are given, pictures are kept first.
 */
async function readEvidence(evidence, serials) {
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > MAX_EVIDENCE_IN) {
        return { problem: `evidence must list 1 to ${MAX_EVIDENCE} items ({ url, caption }, { snapshotId, caption } or a string; up to ${MAX_EVIDENCE_IN} are accepted and cut to ${MAX_EVIDENCE}, pictures first).` };
    }
    const normalized = evidence.map(evidenceItem);
    const isPicture = (item) => isPlainObject(item) && (item.snapshotId !== undefined || item.url !== undefined);
    const ordered = [...normalized.filter(isPicture), ...normalized.filter(item => !isPicture(item))].slice(0, MAX_EVIDENCE);
    const items = [];
    for (const item of ordered) {
        if (!isPlainObject(item)) return { problem: 'Each evidence item must be an object.' };
        const caption = clip(item.caption, 200);
        if (item.snapshotId === undefined && item.url === undefined && typeof item.ref === 'string' && item.ref.trim()) {
            items.push({ ref: clip(item.ref.trim(), 300), caption });
            continue;
        }
        if (item.snapshotId !== undefined) {
            if (!mongoose.isValidObjectId(item.snapshotId)) return { problem: 'An evidence snapshotId is not valid.' };
            const snap = await Snapshot.findById(item.snapshotId).select('deviceSerial s3Key createdAt pestCount aiProcessed').lean();
            if (!snap || !serials.includes(snap.deviceSerial)) return { problem: 'An evidence photo is not from the proposal\'s cameras.' };
            items.push({ snapshotId: String(snap._id), caption, snap });
            continue;
        }
        let url;
        try {
            url = new URL(String(item.url || ''));
        } catch {
            return { problem: 'An evidence url is not valid.' };
        }
        if (url.protocol !== 'https:' || String(item.url).length > 2048) return { problem: 'Evidence links must be https and at most 2048 characters.' };
        items.push({ url: url.toString(), caption });
    }
    return { items };
}

/**
 * Which cameras a proposal is about and whose they are. Accepts deviceSerial, deviceSerials,
 * or plot: a plot id, or a plot name together with one deviceSerial of the same owner.
 */
async function proposalTarget({ type, deviceSerial, deviceSerials, plot }) {
    let serials = Array.isArray(deviceSerials) ? deviceSerials.map(String) : deviceSerial ? [String(deviceSerial)] : [];
    if (serials.some(s => !SERIAL.test(s)) || serials.length > 50) return { problem: 'deviceSerials must be camera serial numbers.' };
    serials = [...new Set(serials)];
    let plotName = null;
    let plotSerials = null;
    if (plot !== undefined && plot !== null && plot !== '') {
        if (type !== 'treatment') return { problem: 'plot applies to a treatment only.' };
        if (mongoose.isValidObjectId(plot)) {
            const found = await Plot.findById(plot).select('name').lean();
            if (!found) return { problem: 'Plot not found.' };
            plotName = found.name;
            plotSerials = (await Camera.find({ plotId: found._id }).select('deviceSerial').lean()).map(c => c.deviceSerial);
            if (!plotSerials.length) return { problem: 'This plot has no traps.' };
        } else if (serials.length) {
            plotName = clip(plot, 100);
        } else {
            return { problem: 'Give the plot id, or the plot name with one deviceSerial of the same owner.' };
        }
    }
    const lookup = plotSerials || serials;
    if (!lookup.length) return { problem: 'Give deviceSerial, deviceSerials or plot.' };
    if (type === 'card_change' && lookup.length !== 1) return { problem: 'A card change is about one camera (deviceSerial).' };
    const cameras = await Camera.find({ deviceSerial: { $in: lookup } }).select('deviceSerial userId').lean();
    if (cameras.length !== lookup.length) return { status: 404, problem: 'Camera not found.' };
    const owners = [...new Set(cameras.map(c => String(c.userId || '')))];
    if (owners.length !== 1 || !owners[0]) return { problem: 'All cameras of a proposal must have the same owner.' };
    const owner = await User.findById(owners[0]);
    if (!owner || owner.disabled) return { status: 409, problem: 'The camera owner\'s account is not active.' };
    // A plot name is resolved among the owner's traps by the assistant's own rules
    return { owner, serials: plotSerials || serials, plotName, byPlotName: !plotSerials && !!plotName };
}

const TREATMENT_FIELDS = ['type', 'at', 'product', 'activeIngredient', 'dose', 'area', 'operator', 'preHarvestDays', 'note'];

// The agent's own words (flybot-sentinel sentinel/agent/tools.py), when it sends no logbook type:
// treat_now without a product cannot be a spray (a spray needs one), so it is "other"
const AGENT_TREATMENTS = { treat_now: 'other', bait_before_wave: 'bait', sanitation: 'sanitation' };
const CARD_KINDS = { card_full: 'Sentinel: the card looks full', card_replaced_detected: 'Sentinel: a new card was seen' };

/** Logbook fields of a treatment proposal, from the contract fields or the agent's { action, date, rotateFrom }. */
function treatmentFields(payload) {
    const out = Object.fromEntries(TREATMENT_FIELDS.filter(k => payload[k] !== undefined).map(k => [k, payload[k]]));
    if (out.type === undefined && typeof payload.action === 'string') {
        out.type = payload.action === 'treat_now' && payload.product ? 'spray' : AGENT_TREATMENTS[payload.action] || 'other';
        if (out.note === undefined) {
            out.note = [
                `Sentinel: ${payload.action.replace(/_/g, ' ')}`,
                typeof payload.date === 'string' && payload.date ? `suggested date ${clip(payload.date, 30)}` : null,
                typeof payload.rotateFrom === 'string' && payload.rotateFrom ? `rotate away from ${clip(payload.rotateFrom, 60)}` : null
            ].filter(Boolean).join('; ');
        }
    }
    return out;
}

/**
 * POST /proposals { type, deviceSerial | deviceSerials | plot, payload, evidence, reason }
 * The same confirm card the assistant makes (agent/tools/actionTools.js, with its checks), in
 * the owner's "sentinel" conversation, and a Telegram message with Confirm / Reject.
 */
async function createProposal(body, req, now = new Date()) {
    const type = body?.type;
    if (!['card_change', 'treatment'].includes(type)) return fail(400, 'INVALID_REQUEST', "type must be 'card_change' or 'treatment'.");
    const payload = isPlainObject(body.payload) ? body.payload : {};
    // The agent may put its reason in the payload
    const reason = String(body.reason || payload.reason || '').trim();
    if (!reason) return fail(422, 'INVALID_PROPOSAL', 'reason is required.');

    const target = await proposalTarget({ type, deviceSerial: body.deviceSerial, deviceSerials: body.deviceSerials, plot: body.plot });
    if (target.problem) return fail(target.status || 422, target.status === 404 ? 'CAMERA_NOT_FOUND' : 'INVALID_PROPOSAL', target.problem);
    const evidence = await readEvidence(body.evidence, target.serials);
    if (evidence.problem) return fail(422, 'INVALID_EVIDENCE', evidence.problem);

    const user = userContext(target.owner);
    const cards = [];
    const addCard = (card) => cards.push(card);
    const { actionExecutors } = require('../agent/tools/actionTools');
    const proposed = type === 'card_change'
        ? await actionExecutors.propose_card_change({ deviceSerial: target.serials[0], at: payload.at, note: payload.note ?? CARD_KINDS[payload.kind], userId: user.id, user, addCard })
        : await actionExecutors.propose_treatment({
            ...treatmentFields(payload),
            cameraSerials: target.byPlotName ? undefined : target.serials,
            plot: target.plotName || undefined,
            // A plot given by id is also the treated area, unless one was given
            ...(target.plotName && !target.byPlotName && payload.area === undefined ? { area: target.plotName } : {}),
            userId: user.id,
            user,
            addCard
        });
    const confirmCard = cards.find(c => c.type === 'confirm');
    if (proposed?.error || !confirmCard) return fail(422, 'INVALID_PROPOSAL', proposed?.error || 'The proposal could not be made.');

    const proposalId = new mongoose.Types.ObjectId();
    const messageId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + env.SENTINEL_PROPOSAL_TTL_HOURS * 3600 * 1000);
    const serials = type === 'treatment' ? confirmCard.payload.cameraSerials : [confirmCard.payload.deviceSerial];
    const card = {
        ...confirmCard,
        source: 'sentinel',
        proposalId: String(proposalId),
        reason: reason.slice(0, MAX_REASON),
        evidence: evidence.items.filter(e => e.url).map(e => ({ url: e.url, caption: e.caption })),
        expiresAt: expiresAt.toISOString()
    };
    const messageCards = [card];
    const photos = evidence.items.filter(e => e.snap);
    if (photos.length) {
        const names = new Map((await Camera.find({ deviceSerial: { $in: photos.map(p => p.snap.deviceSerial) } }).select('deviceSerial deviceName').lean())
            .map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
        messageCards.push({
            type: 'photos',
            items: photos.map(p => ({
                id: String(p.snap._id),
                deviceSerial: p.snap.deviceSerial,
                name: p.caption || names.get(p.snap.deviceSerial) || p.snap.deviceSerial,
                at: p.snap.createdAt,
                count: p.snap.aiProcessed ? p.snap.pestCount ?? null : null,
                imageKey: p.snap.s3Key
            }))
        });
    }
    const content = translate(user.language, 'sentinel.message', { reason: card.reason });
    await ChatSession.updateOne(
        { userId: target.owner._id, sessionId: SENTINEL_SESSION },
        {
            $set: { updatedAt: now },
            $push: { messages: { $each: [{ id: messageId, role: 'assistant', content, cards: messageCards, at: now }], $slice: -MAX_CHAT_MESSAGES } }
        },
        { upsert: true }
    );
    const proposal = await SentinelProposal.create({
        _id: proposalId,
        userId: target.owner._id,
        type,
        deviceSerials: serials,
        sessionId: SENTINEL_SESSION,
        messageId,
        cardIndex: 0,
        reason: card.reason,
        evidence: evidence.items.map(e => ({ url: e.url, snapshotId: e.snapshotId, ref: e.ref, caption: e.caption })),
        expiresAt
    });
    audit(req, {
        action: 'sentinel.proposal_created',
        target: { type: 'proposal', id: String(proposalId), label: `${type}: ${serials.join(', ')}` },
        details: { type, cameras: serials, ownerId: user.id, expiresAt: expiresAt.toISOString(), evidence: evidence.items.length }
    });
    const telegram = await sendProposalToTelegram(proposal, target.owner, card, evidence.items);
    return ok({
        proposalId: String(proposalId),
        cardId: messageId,
        sessionId: SENTINEL_SESSION,
        cardIndex: 0,
        state: 'pending',
        expiresAt: expiresAt.toISOString(),
        telegram
    }, 201);
}

// ---------- Proposals of the vision Lambda and the chatbot (CONTRACTS section 1) ----------

const ACTIONS = ['capture_now', 'set_interval', 'set_isp', 'review_request', 'notify'];
const ISP_FIELDS = { brightness: (v) => Number.isInteger(v) && v >= -64 && v <= 64, wdr: (v) => typeof v === 'boolean' || (Number.isInteger(v) && v >= 0 && v <= 2) };

/**
 * Check one proposed action and its parameters ({ action, params }). Returns { action, params }
 * with only the known parameters, or { error }.
 */
function checkAction(action, params = {}, { camera = null } = {}) {
    if (!ACTIONS.includes(action)) return { error: `action must be one of ${ACTIONS.join(', ')}.` };
    const p = isPlainObject(params) ? params : {};
    if (action === 'set_interval') {
        if (!CAPTURE_INTERVALS.includes(p.minutes)) return { error: `set_interval needs minutes, one of ${CAPTURE_INTERVALS.join(', ')}.` };
        return { action, params: { minutes: p.minutes } };
    }
    if (action === 'set_isp') {
        if (camera && camera.platform !== 'camos') return { error: 'Image settings (set_isp) can only be changed on a CamOS camera.' };
        const out = {};
        for (const [key, ok] of Object.entries(ISP_FIELDS)) {
            if (p[key] === undefined) continue;
            if (!ok(p[key])) return { error: `set_isp: invalid ${key}.` };
            out[key] = p[key];
        }
        if (!Object.keys(out).length) return { error: 'set_isp needs brightness and/or wdr.' };
        return { action, params: out };
    }
    if (action === 'notify') {
        const message = clip(String(p.message || '').trim(), 500);
        if (!message) return { error: 'notify needs a message.' };
        return { action, params: { message } };
    }
    return { action, params: {} };
}

/**
 * The confirm card of a proposed action, as the chat panel shows it (and aiController's
 * CONFIRM_ACTIONS run it). `snapshot` is the photo it came from, if any.
 */
function actionCard({ action, params, camera, reason, snapshot = null, confidence = null }) {
    return {
        type: 'confirm',
        action,
        state: 'pending',
        payload: { deviceSerial: camera.deviceSerial, ...params, ...(snapshot ? { snapshotId: String(snapshot._id) } : {}) },
        summary: {
            trap: camera.deviceName || camera.deviceSerial,
            trapKind: require('../constants/trap').trapKindOf(camera),
            action,
            params,
            ...(confidence !== null ? { confidence } : {})
        },
        ...(reason ? { reason: clip(reason, MAX_REASON) } : {})
    };
}

/** The Lambda's reason in each language ({ vi, en }, plain strings), or null when it sent none. */
function reasonsByLanguage(value) {
    if (!isPlainObject(value)) return null;
    const out = {};
    for (const lang of ['vi', 'en']) {
        if (typeof value[lang] === 'string' && value[lang].trim()) out[lang] = clip(value[lang].trim(), MAX_REASON);
    }
    return Object.keys(out).length ? out : null;
}

/** A proposal's reason in `lang` when the Lambda gave one, else the stored text. */
const reasonIn = (item, lang) => (item?.reasonI18n && item.reasonI18n[lang]) || item?.reason || '';

/**
 * The vision Lambda proposed actions for a photo (response.proposals): one confirm card each in
 * the owner's "sentinel" conversation, a SentinelProposal row, and the Telegram message. Nothing
 * runs until the owner confirms. Returns the proposals created.
 */
async function createLambdaProposals({ snapshot, camera, proposals, traceId = null, evidence = null, now = new Date() }) {
    const owner = camera?.userId ? await User.findById(camera.userId) : null;
    if (!owner || owner.disabled) return [];
    const user = userContext(owner);
    const created = [];
    for (const proposal of (proposals || []).slice(0, 5)) {
        if (!isPlainObject(proposal)) continue;
        const checked = checkAction(proposal.action, proposal.params, { camera });
        if (checked.error) {
            console.warn(`⚠️ Lambda proposal skipped (${camera.deviceSerial}): ${checked.error}`);
            continue;
        }
        const reason = clip(String(proposal.reason || '').trim() || `Sentinel: ${checked.action}`, MAX_REASON);
        const reasonI18n = reasonsByLanguage(proposal.reasonI18n);
        const confidence = Number.isFinite(proposal.confidence) ? Math.max(0, Math.min(1, Number(proposal.confidence))) : null;
        const card = actionCard({ ...checked, camera, reason, snapshot, confidence });
        const stored = await storeProposalCard({
            owner,
            user,
            card: { ...card, traceId: traceId || undefined, ...(reasonI18n ? { reasonI18n } : {}) },
            type: checked.action,
            serials: [camera.deviceSerial],
            reason,
            evidence: [],
            photos: snapshot ? [{ snap: snapshot, caption: '' }] : [],
            extra: { ...(reasonI18n ? { reasonI18n } : {}), payload: { action: checked.action, params: checked.params, proposalId: typeof proposal.id === 'string' ? proposal.id.slice(0, 40) : undefined, evidence: evidence || undefined }, snapshotId: snapshot?._id, traceId: traceId || undefined, confidence: confidence ?? undefined, source: 'lambda' },
            now
        });
        created.push(stored);
    }
    return created;
}

/**
 * Store one confirm card in the owner's "sentinel" conversation with its SentinelProposal row and
 * Telegram message (shared by the HMAC API proposals and the Lambda's). Returns { proposal, card, messageId }.
 */
async function storeProposalCard({ owner, user, card, type, serials, reason, evidence = [], photos = [], extra = {}, now = new Date() }) {
    const proposalId = new mongoose.Types.ObjectId();
    const messageId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + env.SENTINEL_PROPOSAL_TTL_HOURS * 3600 * 1000);
    const fullCard = {
        ...card,
        source: 'sentinel',
        proposalId: String(proposalId),
        reason: reason.slice(0, MAX_REASON),
        evidence: evidence.filter(e => e.url).map(e => ({ url: e.url, caption: e.caption })),
        expiresAt: expiresAt.toISOString()
    };
    const messageCards = [fullCard];
    if (photos.length) {
        const names = new Map((await Camera.find({ deviceSerial: { $in: photos.map(p => p.snap.deviceSerial) } }).select('deviceSerial deviceName').lean())
            .map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
        messageCards.push({
            type: 'photos',
            items: photos.map(p => ({
                id: String(p.snap._id),
                deviceSerial: p.snap.deviceSerial,
                name: p.caption || names.get(p.snap.deviceSerial) || p.snap.deviceSerial,
                at: p.snap.createdAt,
                count: p.snap.aiProcessed ? p.snap.pestCount ?? null : null,
                imageKey: p.snap.s3Key
            }))
        });
    }
    const content = translate(user.language, 'sentinel.message', { reason: reasonIn(fullCard, normalizeLanguage(user.language)) });
    await ChatSession.updateOne(
        { userId: owner._id, sessionId: SENTINEL_SESSION },
        {
            $set: { updatedAt: now },
            $push: { messages: { $each: [{ id: messageId, role: 'assistant', content, cards: messageCards, at: now }], $slice: -MAX_CHAT_MESSAGES } }
        },
        { upsert: true }
    );
    const proposal = await SentinelProposal.create({
        _id: proposalId,
        userId: owner._id,
        type,
        deviceSerials: serials,
        sessionId: SENTINEL_SESSION,
        messageId,
        cardIndex: 0,
        reason: fullCard.reason,
        evidence: evidence.map(e => ({ url: e.url, snapshotId: e.snapshotId, ref: e.ref, caption: e.caption })),
        expiresAt,
        ...extra
    });
    recordAudit(null, {
        actor: ACTOR,
        action: 'sentinel.proposal_created',
        target: { type: 'proposal', id: String(proposalId), label: `${type}: ${serials.join(', ')}` },
        details: { type, cameras: serials, ownerId: user.id, expiresAt: expiresAt.toISOString(), evidence: evidence.length, source: extra.source || 'sentinel' }
    });
    const telegram = await sendProposalToTelegram(proposal, owner, fullCard, [...evidence, ...photos]);
    return { proposal, card: fullCard, messageId, telegram };
}

const farmTime = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const formatAt = (value) => farmTime.format(new Date(value)).replace(',', '');

/** The proposal in the owner's Telegram chat, with Confirm / Reject. Returns 'sent' | 'not_linked' | 'disabled' | 'failed'. */
async function sendProposalToTelegram(proposal, owner, card, evidence) {
    const telegramService = require('./telegramService');
    if (!telegramService.isEnabled()) return 'disabled';
    const chatId = owner.telegram?.chatId;
    if (!chatId) return 'not_linked';
    const lang = normalizeLanguage(owner.language);
    const t = (key, params) => translate(lang, `telegram.sentinel.${key}`, params);
    const summary = card.summary || {};
    const lines = [card.action === 'card_change'
        ? t('card_change', { trap: escapeHtml(summary.trap), at: formatAt(summary.at) })
        : card.action === 'treatment'
            ? t('treatment', {
                type: escapeHtml(summary.type),
                product: summary.product ? ` · ${escapeHtml(summary.product)}` : '',
                traps: escapeHtml((summary.traps || []).join(', ')),
                at: formatAt(summary.at)
            })
            : t('action', {
                action: escapeHtml(translate(lang, `sentinel.actions.${card.action}`)),
                trap: escapeHtml(summary.trap || ''),
                params: escapeHtml(Object.entries(summary.params || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-')
            })];
    lines.push(t('reason', { reason: escapeHtml(reasonIn(card, lang)) }));
    const captions = evidence.map(e => e.caption).filter(Boolean);
    if (captions.length) lines.push(escapeHtml(captions.join(' · ')));
    lines.push(t('expires', { at: formatAt(proposal.expiresAt) }));
    const first = evidence.find(e => e?.url || e?.snap);
    const photoUrl = first?.url || (first?.snap ? await require('./s3Service').getSignedDownloadUrl(first.snap.s3Key, 3600) : null);
    try {
        const sent = await telegramService.sendWithButtons(chatId, {
            html: lines.join('\n\n'),
            photoUrl,
            buttons: [[
                { text: t('confirm'), callback_data: `sp:c:${proposal._id}` },
                { text: t('reject'), callback_data: `sp:r:${proposal._id}` }
            ]]
        });
        await SentinelProposal.updateOne({ _id: proposal._id }, { $set: { telegram: { chatId: String(chatId), messageId: sent?.message_id } } });
        return 'sent';
    } catch (err) {
        console.error('📨 Sentinel proposal not sent to Telegram:', err.response?.data?.description || err.message);
        return 'failed';
    }
}

/**
 * After the person decided on the card (aiController.decideCard): the proposal's state, the
 * audit entry, and the Telegram buttons taken away when it was decided in the app.
 */
async function recordDecision(proposalId, { state, message = '', via = 'app', req = null }) {
    const proposalState = PROPOSAL_STATE_OF_CARD[state];
    if (!proposalState || !mongoose.isValidObjectId(proposalId)) return null;
    const proposal = await SentinelProposal.findOneAndUpdate(
        { _id: proposalId, state: 'pending' },
        { $set: { state: proposalState, result: clip(message, 300), decidedAt: new Date(), decidedVia: via } },
        { returnDocument: 'after' }
    );
    if (!proposal) return null;
    recordAudit(req, {
        action: 'sentinel.proposal_decided',
        target: { type: 'proposal', id: String(proposal._id), label: `${proposal.type}: ${proposal.deviceSerials.join(', ')}` },
        details: { state: proposalState, via, message: message || undefined }
    });
    if (via !== 'telegram' && proposal.telegram?.messageId) {
        require('./telegramService').clearButtons(proposal.telegram.chatId, proposal.telegram.messageId);
    }
    return proposal;
}

/** A Confirm / Reject press in Telegram. Returns { text, final }. */
async function decideFromTelegram({ chatId, proposalId, decision }) {
    const user = await User.findOne({ 'telegram.chatId': String(chatId) });
    const t = (key, params) => translate(user?.language, `telegram.sentinel.${key}`, params);
    if (!user || user.disabled) return { text: t('notFound'), final: false };
    const proposal = await SentinelProposal.findById(proposalId).lean();
    if (!proposal || String(proposal.userId) !== String(user._id)) return { text: t('notFound'), final: false };
    const { decideCard } = require('../controllers/aiController');
    const { status, body } = await decideCard({
        user: userContext(user),
        sessionId: proposal.sessionId,
        messageId: proposal.messageId,
        cardIndex: proposal.cardIndex,
        decision,
        via: 'telegram'
    });
    if (status === 409) return { text: t('handled'), final: true };
    const text = { done: t('confirmed'), cancelled: t('rejected'), expired: t('expired'), failed: t('failed', { message: body.message || '' }) }[body.state] || t('handled');
    return { text, final: true, state: body.state };
}

/** GET /proposals/:id */
async function getProposal(id, now = new Date()) {
    if (!mongoose.isValidObjectId(id)) return fail(404, 'NOT_FOUND', 'Proposal not found.');
    let proposal = await SentinelProposal.findById(id).lean();
    if (!proposal) return fail(404, 'NOT_FOUND', 'Proposal not found.');
    if (proposal.state === 'pending' && proposal.expiresAt <= now) {
        proposal = await SentinelProposal.findOneAndUpdate({ _id: proposal._id, state: 'pending' }, { $set: { state: 'expired' } }, { returnDocument: 'after' }).lean() || proposal;
        // The card in the app shows it too
        await ChatSession.updateOne(
            { userId: proposal.userId, sessionId: proposal.sessionId },
            { $set: { [`messages.$[m].cards.${proposal.cardIndex}.state`]: 'expired' } },
            { arrayFilters: [{ 'm.id': proposal.messageId, [`m.cards.${proposal.cardIndex}.state`]: 'pending' }] }
        ).catch(() => {});
    }
    return ok({
        proposalId: String(proposal._id),
        cardId: proposal.messageId,
        type: proposal.type,
        deviceSerials: proposal.deviceSerials,
        state: proposal.state,
        result: proposal.result || null,
        decidedAt: proposal.decidedAt,
        decidedVia: proposal.decidedVia,
        expiresAt: proposal.expiresAt,
        createdAt: proposal.createdAt
    });
}

// ---------- Review request ----------

/** https links among what the agent sent with a review request (image, evidence strings or { url }). */
function reviewLinks(body) {
    const given = [body.image, ...(Array.isArray(body.evidence) ? body.evidence : [])]
        .map(item => (isPlainObject(item) ? item.url : item))
        .filter(value => typeof value === 'string' && /^https:\/\//i.test(value) && value.length <= 2048);
    return [...new Set(given)].slice(0, MAX_EVIDENCE);
}

/** POST /review-request { snapshotId, reason, deviceSerial?, image?, evidence? } */
async function requestReview(body, req, now = new Date()) {
    if (!mongoose.isValidObjectId(body?.snapshotId)) {
        // The agent also asks about AI camera photos FlyBot never stored: there is nothing to flag then
        return fail(400, 'INVALID_REQUEST', 'snapshotId is required (a FlyBot photo id).');
    }
    const reason = clip(String(body.reason || '').trim(), 300);
    if (!reason) return fail(422, 'INVALID_REQUEST', 'reason is required.');
    const links = reviewLinks(body);
    const snapshot = await Snapshot.findById(body.snapshotId).select('deviceSerial review createdAt').lean();
    if (!snapshot) return fail(404, 'NOT_FOUND', 'Photo not found.');
    if (snapshot.review?.status) return ok({ snapshotId: String(snapshot._id), status: 'already_reviewed', reviewStatus: snapshot.review.status });
    if (snapshot.review?.requested) return ok({ snapshotId: String(snapshot._id), status: 'already_requested', requestedAt: snapshot.review.requested.at });

    const flagged = await Snapshot.updateOne(
        { _id: snapshot._id, 'review.requested': { $exists: false } },
        { $set: { 'review.requested': { at: now, reason, by: 'sentinel', ...(links.length ? { evidence: links } : {}) } } }
    );
    if (!flagged.modifiedCount) return ok({ snapshotId: String(snapshot._id), status: 'already_requested' });

    // The owner reviews (people the camera is shared with see the photo, but do not get asked)
    const camera = await Camera.findOne({ deviceSerial: snapshot.deviceSerial }).select('userId deviceName').lean();
    let notified = 0;
    if (camera?.userId) {
        const muted = await User.exists({ _id: camera.userId, 'notificationPrefs.mutedCameras': snapshot.deviceSerial });
        if (!muted) {
            const notificationService = require('./notificationService');
            const sent = await notificationService.notifyUser({
                userId: camera.userId,
                type: 'review_requested',
                deviceSerial: snapshot.deviceSerial,
                params: { deviceName: camera.deviceName || snapshot.deviceSerial, reason, snapshotId: String(snapshot._id) }
            }).catch(err => {
                console.error('⚠️ Review request notification failed:', err.message);
                return null;
            });
            notified = sent ? 1 : 0;
        }
    }
    audit(req, {
        action: 'sentinel.review_requested',
        target: { type: 'snapshot', id: String(snapshot._id), label: snapshot.deviceSerial },
        details: { reason, notified }
    });
    return ok({ snapshotId: String(snapshot._id), status: 'requested', requestedAt: now.toISOString(), notified });
}

// ---------- Analysis ----------

const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value ?? null));

function readCounts(counts) {
    if (!isPlainObject(counts)) return { problem: 'counts must be an object of label: count.' };
    // A label without a value (null) is left out
    const entries = Object.entries(counts).filter(([, value]) => value !== null && value !== undefined);
    if (entries.length > 50) return { problem: 'counts has too many labels.' };
    for (const [label, value] of entries) {
        if (!LABEL.test(label) || !Number.isInteger(value) || value < 0 || value > 100000) return { problem: `Invalid count for "${clip(label, 60)}".` };
    }
    return { value: Object.fromEntries(entries) };
}

function readBoxes(boxes, format) {
    if (boxes === undefined || boxes === null) return { value: [] };
    if (!Array.isArray(boxes) || boxes.length > MAX_BOXES) return { problem: `boxes must be a list of at most ${MAX_BOXES}.` };
    const out = [];
    for (const box of boxes) {
        // A bare [xmin, ymin, xmax, ymax] is a box without label or confidence
        const bbox = Array.isArray(box) ? box : box?.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return { problem: 'Each box needs bbox [xmin, ymin, xmax, ymax].' };
        if (bbox[2] < bbox[0] || bbox[3] < bbox[1]) return { problem: 'A box has xmax < xmin or ymax < ymin.' };
        if (format === 'xyxy_normalized' && bbox.some(v => v < -0.01 || v > 1.01)) return { problem: 'Normalized boxes must lie within 0-1.' };
        if (format === 'xyxy_pixels' && bbox.some(v => v < -1 || v > 100000)) return { problem: 'A pixel box is out of range.' };
        const confidence = box.confidence === undefined || box.confidence === null ? null : Number(box.confidence);
        if (confidence !== null && !(confidence >= 0 && confidence <= 1)) return { problem: 'confidence must be within 0-1.' };
        out.push({ label: box.label === undefined ? null : clip(box.label, 60), confidence, bbox: bbox.map(Number) });
    }
    return { value: out };
}

/** Boxes as production stores them (aiResults.insects: pixels), or null when the size is unknown. */
function toInsects(boxes, format, width, height) {
    if (format === 'xyxy_pixels') return boxes.map(b => ({ name: b.label || 'fruit_fly', confidence: b.confidence ?? 1, bbox: b.bbox.map(Math.round) }));
    if (!width || !height) return null;
    return boxes.map(b => ({
        name: b.label || 'fruit_fly',
        confidence: b.confidence ?? 1,
        bbox: [b.bbox[0] * width, b.bbox[1] * height, b.bbox[2] * width, b.bbox[3] * height].map(Math.round)
    }));
}

/**
 * POST /analysis { snapshotId, counts, boxes, boxFormat, quality, evidence, source: 'sentinel', ... }
 * Stored under aiResults.sentinel. Only with AI_PROVIDER=sentinel does it become the photo's
 * result (summary, boxes, statistics and alerts), and never over a person's review. It never
 * sends snapshot_analyzed again, so Sentinel is not called back about its own analysis.
 */
async function storeAnalysis(body, req, now = new Date()) {
    if (!mongoose.isValidObjectId(body?.snapshotId)) return fail(400, 'INVALID_REQUEST', 'snapshotId is required.');
    if (body.source !== undefined && body.source !== 'sentinel') return fail(400, 'INVALID_REQUEST', "source must be 'sentinel'.");
    const format = body.boxFormat ?? 'xyxy_pixels';
    if (!BOX_FORMATS.includes(format)) return fail(400, 'INVALID_REQUEST', `boxFormat must be one of ${BOX_FORMATS.join(', ')}.`);
    const counts = readCounts(body.counts);
    if (counts.problem) return fail(422, 'INVALID_ANALYSIS', counts.problem);
    const boxes = readBoxes(body.boxes, format);
    if (boxes.problem) return fail(422, 'INVALID_ANALYSIS', boxes.problem);
    if (body.quality !== undefined && body.quality !== null && (!isPlainObject(body.quality) || jsonSize(body.quality) > 8 * 1024)) {
        return fail(422, 'INVALID_ANALYSIS', 'quality must be an object (at most 8 KB).');
    }
    if (body.evidence !== undefined && body.evidence !== null && (!Array.isArray(body.evidence) || body.evidence.length > 20 || jsonSize(body.evidence) > 16 * 1024)) {
        return fail(422, 'INVALID_ANALYSIS', 'evidence must be a list of at most 20 items (16 KB).');
    }
    // The agent's per-source counts ({ opencv, npu, production, best, new }), stored as sent
    if (body.estimates !== undefined && body.estimates !== null && (!isPlainObject(body.estimates) || jsonSize(body.estimates) > 2 * 1024)) {
        return fail(422, 'INVALID_ANALYSIS', 'estimates must be an object (at most 2 KB).');
    }
    const size = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : null);
    const width = size(body.width);
    const height = size(body.height);

    const snapshot = await Snapshot.findById(body.snapshotId).select('deviceSerial createdAt aiProcessed aiProvider review.status').lean();
    if (!snapshot) return fail(404, 'NOT_FOUND', 'Photo not found.');

    const count = pestCountOf(counts.value);
    const record = {
        source: 'sentinel',
        counts: counts.value,
        count,
        boxFormat: format,
        boxes: boxes.value,
        width,
        height,
        quality: body.quality ?? null,
        evidence: body.evidence ?? [],
        estimates: body.estimates ?? null,
        model: body.model === undefined ? null : clip(body.model, 100),
        traceId: body.traceId === undefined ? null : clip(body.traceId, 100),
        receivedAt: now
    };
    const set = { 'aiResults.sentinel': record };

    // AI_PROVIDER=sentinel: this is the photo's result, unless a person already reviewed it
    const aiService = require('./aiService');
    const primary = aiService.isSentinelMode() && !snapshot.review?.status
        && (!snapshot.aiProcessed || snapshot.aiProvider === 'sentinel');
    if (primary) {
        const insects = toInsects(boxes.value, format, width, height);
        Object.assign(set, {
            aiProcessed: true,
            aiProvider: 'sentinel',
            pestCount: count,
            'aiResults.detected': count > 0,
            'aiResults.summary': counts.value,
            'aiResults.raw_description': `FlyBot Sentinel counted ${count} insect(s).`,
            ...(insects ? { 'aiResults.insects': insects } : {})
        });
    }
    await Snapshot.updateOne({ _id: snapshot._id }, { $set: set });

    if (primary) {
        await require('./dailyStats').refreshForSnapshot(snapshot);
        // Alerts once, and only for the camera's latest photo (as on the AI retry path)
        const newer = await Snapshot.exists({ deviceSerial: snapshot.deviceSerial, createdAt: { $gt: snapshot.createdAt } });
        if (!snapshot.aiProcessed && !newer) await require('../cron/captureJob').checkAlerts(snapshot.deviceSerial, snapshot._id);
        audit(req, {
            action: 'sentinel.analysis',
            target: { type: 'snapshot', id: String(snapshot._id), label: snapshot.deviceSerial },
            details: { count, boxes: boxes.value.length, first: !snapshot.aiProcessed }
        });
    }
    return ok({ snapshotId: String(snapshot._id), stored: true, summaryUpdated: primary, count });
}

module.exports = {
    SENTINEL_SESSION,
    MAX_INTERVAL_HOURS,
    burstQuota,
    userContext,
    takeCaptureBudget,
    capture,
    setCaptureInterval,
    createProposal,
    ACTIONS,
    checkAction,
    actionCard,
    reasonIn,
    createLambdaProposals,
    storeProposalCard,
    recordDecision,
    decideFromTelegram,
    getProposal,
    requestReview,
    storeAnalysis
};
