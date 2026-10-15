const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const axios = require('axios');
const jpeg = require('jpeg-js');

// Must be set before config/env loads (dbHelpers loads it)
const SECRET = 'sentinel-test-secret-'.padEnd(48, 's');
process.env.SENTINEL_API_SECRET = SECRET;
process.env.SENTINEL_CAPTURE_BUDGET = '2';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const env = require('../src/config/env');
const ezvizService = require('../src/services/ezvizService');
const aiService = require('../src/services/aiService');
const telegramService = require('../src/services/telegramService');
const sentinelService = require('../src/services/sentinelService');
const { verifySignature } = require('../src/middlewares/sentinelAuth');
const { dueSerials, deviceSchedules } = require('../src/services/captureSchedule');
const { captureAndSaveSnapshot, retryFailedAnalyses } = require('../src/cron/captureJob');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ---------- Helpers ----------

function hmac(secret, ts, raw) {
    return `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
}

// Each request gets its own timestamp (within the 5-minute window): two identical bodies signed
// in the same second have the same signature, and the second would be refused as a replay
// (a strictly decreasing sequence, restarted from the clock before it leaves the window)
let tsBase = Math.floor(Date.now() / 1000);
let tsCount = 0;
const freshTs = () => {
    const now = Math.floor(Date.now() / 1000);
    if (now - (tsBase - tsCount) > 200) { tsBase = now; tsCount = 0; }
    return tsBase - tsCount++;
};

/** A request signed as the Sentinel agent. */
function signed(path, { method = 'POST', body, ts = freshTs(), secret = SECRET, signature, headers = {} } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return request(path, {
        method,
        body,
        headers: { 'X-Sentinel-Timestamp': String(ts), 'X-Sentinel-Signature': signature ?? hmac(secret, ts, raw), ...headers }
    });
}
const call = async (path, options) => json(await signed(path, options));

function testJpeg(width = 64, height = 48) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = 60 + ((i * 37) % 140);
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = 40; data[i * 4 + 3] = 255;
    }
    return jpeg.encode({ data, width, height }, 90).data;
}

const original = {
    post: axios.post,
    get: axios.get,
    capture: ezvizService.captureDevice,
    analyze: aiService.analyzeSnapshot,
    tgEnabled: telegramService.isEnabled,
    tgSend: telegramService.sendWithButtons,
    provider: env.AI_PROVIDER
};
let posts;
let telegramSent;
beforeEach(() => {
    posts = [];
    telegramSent = [];
    axios.post = async (url, body, config) => {
        posts.push({ url, body, headers: config?.headers || {} });
        return { status: 200, data: { ok: true } };
    };
    telegramService.isEnabled = () => true;
    telegramService.sendWithButtons = async (chatId, message) => {
        telegramSent.push({ chatId, ...message });
        return { message_id: 77 };
    };
});
afterEach(() => {
    axios.post = original.post;
    axios.get = original.get;
    ezvizService.captureDevice = original.capture;
    aiService.analyzeSnapshot = original.analyze;
    telegramService.isEnabled = original.tgEnabled;
    telegramService.sendWithButtons = original.tgSend;
    env.AI_PROVIDER = original.provider;
});

// The camera answers with a picture, and the cloud AI counts `summary`
function fakeCameraAndAi(summary = { fruit_fly: 3 }) {
    ezvizService.captureDevice = async () => ({ code: '200', data: { picUrl: 'https://ezviz.example.test/pic.jpg' } });
    axios.get = async () => ({ data: testJpeg() });
    aiService.analyzeSnapshot = async (base64, snapshotId) => {
        await models.Snapshot.findByIdAndUpdate(snapshotId, {
            aiProcessed: true, aiProvider: 'roboflow', pestCount: models.Snapshot.pestCountOf(summary),
            aiResults: { detected: true, insects: [{ name: 'fruit_fly', confidence: 0.9, bbox: [1, 2, 10, 12] }], summary }
        });
        return true;
    };
}

async function waitFor(predicate, ms = 3000) {
    const start = Date.now();
    while (!(await predicate())) {
        if (Date.now() - start > ms) throw new Error('timed out');
        await new Promise(r => setTimeout(r, 20));
    }
}

async function owner(extra = {}) {
    return createUser({ role: 'manager', telegram: { chatId: '555', username: 'farmer', linkedAt: new Date() }, ...extra });
}

const sentinelAudits = () => models.AuditLog.find({ category: 'sentinel' }).lean();
// Audit entries are written in the background: wait until `count` of this action are there
async function auditsOf(action, count) {
    await waitFor(async () => (await models.AuditLog.countDocuments({ action })) >= count).catch(() => {});
    return models.AuditLog.find({ action }).sort({ createdAt: 1 }).lean();
}

// ---------- HMAC ----------

test('auth: a valid signature passes; missing, stale, wrong, reused or unsigned bodies are refused', async () => {
    const me = await owner();
    await createCamera(me, { deviceSerial: 'AUTH1' });
    const body = { deviceSerial: 'AUTH1', intervalMinutes: 15, untilISO: new Date(Date.now() + HOUR).toISOString() };

    const ok = await call('/api/sentinel/capture-interval', { body });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.sentinelInterval.minutes, 15);

    // The bare hex is accepted too
    const ts = Math.floor(Date.now() / 1000);
    const other = { ...body, intervalMinutes: 30 };
    const bare = await call('/api/sentinel/capture-interval', { body: other, ts, signature: hmac(SECRET, ts, JSON.stringify(other)).slice(7) });
    assert.equal(bare.status, 200);

    const missing = await json(await request('/api/sentinel/capture-interval', { method: 'POST', body }));
    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, 'MISSING_SIGNATURE');

    const stale = await call('/api/sentinel/capture-interval', { body, ts: Math.floor(Date.now() / 1000) - 301 });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.code, 'STALE_TIMESTAMP');
    const future = await call('/api/sentinel/capture-interval', { body, ts: Math.floor(Date.now() / 1000) + 400 });
    assert.equal(future.body.code, 'STALE_TIMESTAMP');

    const wrongKey = await call('/api/sentinel/capture-interval', { body, secret: 'another-secret-'.padEnd(40, 'x') });
    assert.equal(wrongKey.status, 401);
    assert.equal(wrongKey.body.code, 'BAD_SIGNATURE');

    // Signed for another body
    const now = Math.floor(Date.now() / 1000);
    const tampered = await call('/api/sentinel/capture-interval', { body, ts: now, signature: hmac(SECRET, now, JSON.stringify({ ...body, intervalMinutes: 120 })) });
    assert.equal(tampered.body.code, 'BAD_SIGNATURE');
    assert.equal((await call('/api/sentinel/capture-interval', { body, signature: 'sha256=zz' })).body.code, 'BAD_SIGNATURE');

    // The exact same signed POST twice: the second is a replay
    const again = { ...body, intervalMinutes: 60 };
    const replayTs = Math.floor(Date.now() / 1000);
    assert.equal((await call('/api/sentinel/capture-interval', { body: again, ts: replayTs })).status, 200);
    const replay = await call('/api/sentinel/capture-interval', { body: again, ts: replayTs });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'REPLAYED');

    // Not JSON
    const form = await json(await request('/api/sentinel/capture', { method: 'POST', body: Buffer.from('deviceSerial=AUTH1'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    assert.equal(form.status, 415);

    // A user session is not enough
    const asUser = await json(await request('/api/sentinel/capture-interval', { method: 'POST', as: me, body }));
    assert.equal(asUser.status, 401);

    // No secret configured: the API is off
    env.SENTINEL_API_SECRET = '';
    try {
        assert.equal((await call('/api/sentinel/capture-interval', { body: { ...body, reason: 'x' } })).status, 503);
    } finally {
        env.SENTINEL_API_SECRET = SECRET;
    }
});

test('auth: verifySignature checks the skew window and compares in constant time', () => {
    const now = 1_800_000_000_000;
    const ts = String(now / 1000);
    const good = hmac(SECRET, ts, '{"a":1}');
    assert.deepEqual(verifySignature(SECRET, ts, '{"a":1}', good, now), { ok: true });
    assert.deepEqual(verifySignature(SECRET, ts, '{"a":1}', good.toUpperCase().replace('SHA256=', 'sha256='), now), { ok: true });
    assert.equal(verifySignature(SECRET, ts, '{"a":2}', good, now).code, 'BAD_SIGNATURE');
    assert.equal(verifySignature(SECRET, ts, '{"a":1}', good, now + 301 * 1000).code, 'STALE_TIMESTAMP');
    assert.equal(verifySignature(SECRET, ts, '{"a":1}', good, now + 299 * 1000).ok, true);
    assert.equal(verifySignature(SECRET, '12.5', '{"a":1}', good, now).code, 'BAD_TIMESTAMP');
    assert.equal(verifySignature(SECRET, ts, '{"a":1}', 'sha256=abcd', now).code, 'BAD_SIGNATURE');
    assert.equal(verifySignature(SECRET, ts, '{"a":1}', '', now).code, 'MISSING_SIGNATURE');
});

// ---------- Capture ----------

test('capture: an extra photo through the normal ingest path, within the daily budget', async () => {
    const me = await owner();
    const lastCaptureAt = new Date(Date.now() - 10 * MINUTE);
    await createCamera(me, { deviceSerial: 'CAP1', deviceName: 'Trap 1', lastCaptureAt });
    fakeCameraAndAi({ fruit_fly: 3 });

    const first = await call('/api/sentinel/capture', { body: { deviceSerial: 'CAP1' } });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'analyzed');
    assert.equal(first.body.count, 3);
    assert.deepEqual({ used: first.body.budget.used, limit: first.body.budget.limit }, { used: 1, limit: 2 });
    const snap = await models.Snapshot.findById(first.body.snapshotId).lean();
    assert.equal(snap.trigger, 'sentinel');
    assert.equal(snap.aiProcessed, true);
    const camera = await models.Camera.findOne({ deviceSerial: 'CAP1' }).lean();
    assert.equal(camera.lastCaptureAt.getTime(), lastCaptureAt.getTime(), 'the schedule is not moved');

    const second = await call("/api/sentinel/capture", { body: { deviceSerial: "CAP1" } });
    assert.equal(second.body.budget?.used, 2, JSON.stringify(second));
    const over = await call('/api/sentinel/capture', { body: { deviceSerial: 'CAP1' } });
    assert.equal(over.status, 429, JSON.stringify(over.body));
    assert.equal(over.body.code, 'BUDGET_EXHAUSTED');
    assert.equal(await models.Snapshot.countDocuments({ deviceSerial: 'CAP1' }), 2);

    const audits = await auditsOf('sentinel.capture', 2);
    assert.equal(audits.length, 2);
    assert.equal(audits[0].actorEmail, 'sentinel-agent');
    assert.equal(audits[0].actorId, null);

    assert.equal((await call('/api/sentinel/capture', { body: { deviceSerial: 'NOPE' } })).status, 404);
    assert.equal((await call('/api/sentinel/capture', { body: {} })).status, 400);
});

test('capture: the budget counts per farm day, an offline camera still uses it, night is refused for daytime-only cameras', async () => {
    const me = await owner();
    await createCamera(me, { deviceSerial: 'CAP2' });
    await createCamera(me, { deviceSerial: 'CAP3', captureDaytimeOnly: true });

    // Device offline (dbHelpers stub): the attempt is counted
    const offline = await call('/api/sentinel/capture', { body: { deviceSerial: 'CAP2' } });
    assert.equal(offline.status, 502);
    assert.equal(offline.body.code, 'CAPTURE_FAILED');
    assert.equal(offline.body.budget.used, 1);

    const day1 = new Date('2026-10-15T03:00:00Z');
    const day2 = new Date('2026-10-16T03:00:00Z');
    assert.deepEqual(await sentinelService.takeCaptureBudget('CAP3', day1), { ok: true, used: 1, day: '2026-10-15' });
    assert.equal((await sentinelService.takeCaptureBudget('CAP3', day1)).used, 2);
    assert.equal((await sentinelService.takeCaptureBudget('CAP3', day1)).ok, false);
    assert.deepEqual(await sentinelService.takeCaptureBudget('CAP3', day2), { ok: true, used: 1, day: '2026-10-16' });

    // 22:00 farm time: the camera's daytime-only setting is respected, nothing is spent
    const night = new Date('2026-10-16T15:00:00Z');
    const refused = await sentinelService.capture({ deviceSerial: 'CAP3' }, null, night);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'QUIET_HOURS');
    assert.equal((await models.Camera.findOne({ deviceSerial: 'CAP3' }).lean()).sentinelCaptures.count, 1);
});

// ---------- Capture interval ----------

test('capture-interval: a temporary interval the schedule follows until it expires', async () => {
    const me = await owner();
    await createCamera(me, { deviceSerial: 'INT1', captureIntervalMinutes: 60, lastCaptureAt: new Date(Date.now() - 20 * MINUTE) });
    const until = new Date(Date.now() + 2 * HOUR);

    const set = await call('/api/sentinel/capture-interval', { body: { deviceSerial: 'INT1', intervalMinutes: 15, untilISO: until.toISOString(), reason: 'surge at the neighbour trap' } });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.sentinelInterval, { minutes: 15, until: until.toISOString() });
    assert.equal(set.body.cameraIntervalMinutes, 60);

    const cams = await models.Camera.find({ deviceSerial: 'INT1' }).lean();
    assert.equal(cams[0].sentinelInterval.minutes, 15);
    assert.equal(cams[0].captureIntervalMinutes, 60, 'the camera setting is kept');
    assert.deepEqual(dueSerials(cams, new Date()), ['INT1'], '20 minutes > 15: due with the override');
    assert.equal(deviceSchedules(cams, new Date()).get('INT1').intervalMinutes, 15);
    assert.equal(deviceSchedules(cams, new Date(until.getTime() + MINUTE)).get('INT1').intervalMinutes, 60, 'expired: back to the camera interval');
    const later = [{ ...cams[0], lastCaptureAt: new Date(until.getTime() - 20 * MINUTE) }];
    assert.deepEqual(dueSerials(later, new Date(until.getTime() + MINUTE)), [], '21 minutes < 60 once it has expired');

    assert.equal((await call('/api/sentinel/capture-interval', { body: { deviceSerial: 'INT1', intervalMinutes: 45, untilISO: until.toISOString() } })).body.code, 'INVALID_INTERVAL');
    assert.equal((await call('/api/sentinel/capture-interval', { body: { deviceSerial: 'INT1', intervalMinutes: 15, untilISO: new Date(Date.now() + 80 * HOUR).toISOString() } })).body.code, 'INVALID_UNTIL');
    assert.equal((await call('/api/sentinel/capture-interval', { body: { deviceSerial: 'INT1', intervalMinutes: 15, untilISO: new Date(Date.now() - MINUTE).toISOString() } })).body.code, 'INVALID_UNTIL');

    const cleared = await call('/api/sentinel/capture-interval', { body: { deviceSerial: 'INT1', intervalMinutes: null } });
    assert.equal(cleared.body.sentinelInterval, null);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'INT1' }).lean()).sentinelInterval?.minutes, undefined);
    assert.equal((await auditsOf('sentinel.capture_interval', 2)).length, 2);
});

// ---------- Proposals ----------

const EVIDENCE = [{ url: 'https://evidence.example.com/crop1.jpg', caption: 'Card full: 41 flies' }];

test('proposal card_change: the assistant confirm card and Telegram; confirming in the app records the card change', async () => {
    const me = await owner();
    await createCamera(me, { deviceSerial: 'PRO1', deviceName: 'Mango A', trapKind: 'sticky' });

    const created = await call('/api/sentinel/proposals', { body: { type: 'card_change', deviceSerial: 'PRO1', payload: { note: 'card saturated' }, evidence: EVIDENCE, reason: 'The card is 92% covered.' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, 'pending');
    assert.equal(created.body.telegram, 'sent');
    const { proposalId, cardId } = created.body;

    // In the assistant: the owner's "sentinel" conversation, same card as propose_card_change
    const history = await json(await request('/api/ai/chat/history?sessionId=sentinel', { as: me }));
    const message = history.body.messages.find(m => m.id === cardId);
    assert.equal(message.role, 'assistant');
    assert.match(message.content, /The card is 92% covered/);
    const card = message.cards[0];
    assert.equal(card.type, 'confirm');
    assert.equal(card.action, 'card_change');
    assert.equal(card.state, 'pending');
    assert.equal(card.payload.deviceSerial, 'PRO1');
    assert.equal(card.payload.type, 'card_replaced');
    assert.equal(card.summary.trap, 'Mango A');
    assert.equal(card.source, 'sentinel');
    assert.equal(card.proposalId, proposalId);
    assert.deepEqual(card.evidence, EVIDENCE);

    // Telegram: the evidence photo with Confirm / Reject
    assert.equal(telegramSent.length, 1);
    assert.equal(telegramSent[0].chatId, '555');
    assert.equal(telegramSent[0].photoUrl, EVIDENCE[0].url);
    assert.deepEqual(telegramSent[0].buttons[0].map(b => b.callback_data), [`sp:c:${proposalId}`, `sp:r:${proposalId}`]);
    assert.match(telegramSent[0].html, /Mango A/);

    assert.equal((await call(`/api/sentinel/proposals/${proposalId}`, { method: 'GET' })).body.state, 'pending');

    // Confirmed with the existing confirm endpoint
    const done = await json(await request('/api/ai/chat/confirm', { method: 'POST', as: me, body: { sessionId: 'sentinel', messageId: cardId, cardIndex: 0, decision: 'confirm' } }));
    assert.equal(done.status, 200);
    assert.equal(done.body.state, 'done');
    const events = await models.MaintenanceEvent.find({ deviceSerial: 'PRO1', type: 'card_replaced' }).lean();
    assert.equal(events.length, 1);
    assert.equal(events[0].note, 'card saturated');
    assert.ok((await models.Camera.findOne({ deviceSerial: 'PRO1' }).lean()).cardReplacedAt);

    const state = await call(`/api/sentinel/proposals/${proposalId}`, { method: 'GET' });
    assert.equal(state.body.state, 'confirmed');
    assert.equal(state.body.decidedVia, 'app');
    // Twice: already handled, nothing more recorded
    assert.equal((await request('/api/ai/chat/confirm', { method: 'POST', as: me, body: { sessionId: 'sentinel', messageId: cardId, cardIndex: 0, decision: 'confirm' } })).status, 409);
    assert.equal(await models.MaintenanceEvent.countDocuments({ deviceSerial: 'PRO1' }), 1);

    await auditsOf('sentinel.proposal_decided', 1);
    const audits = await sentinelAudits();
    assert.equal(audits.find(a => a.action === 'sentinel.proposal_created').actorEmail, 'sentinel-agent');
    const decided = audits.find(a => a.action === 'sentinel.proposal_decided');
    assert.equal(String(decided.actorId), String(me._id), 'the person who decided');
    assert.equal(decided.details.state, 'confirmed');
});

test('proposal treatment: confirmed from the Telegram button, recorded in the logbook', async () => {
    const me = await owner();
    await createCamera(me, { deviceSerial: 'TR1', deviceName: 'Trap 1' });
    await createCamera(me, { deviceSerial: 'TR2', deviceName: 'Trap 2' });
    const at = new Date(Date.now() - HOUR).toISOString();

    const created = await call('/api/sentinel/proposals', {
        body: { type: 'treatment', deviceSerials: ['TR1', 'TR2'], payload: { type: 'bait', product: 'Ento-Pro', at }, evidence: EVIDENCE, reason: 'Catches doubled in 3 days.' }
    });
    assert.equal(created.status, 201);
    const card = (await models.ChatSession.findOne({ userId: me._id, sessionId: 'sentinel' }).lean()).messages[0].cards[0];
    assert.equal(card.action, 'treatment');
    assert.deepEqual(card.summary.traps, ['Trap 1', 'Trap 2']);

    const result = await telegramService.handleUpdate({
        update_id: 9,
        callback_query: { id: 'cb1', data: `sp:c:${created.body.proposalId}`, from: { id: 555 }, message: { message_id: 77, chat: { id: 555, type: 'private' } } }
    });
    assert.equal(result.state, 'done');
    assert.ok(posts.some(p => p.url.endsWith('/answerCallbackQuery') && /Confirmed|Đã xác nhận/.test(p.body.text)));

    const treatments = await models.Treatment.find().lean();
    assert.equal(treatments.length, 1);
    assert.deepEqual(treatments[0].cameraSerials, ['TR1', 'TR2']);
    assert.equal(treatments[0].product, 'Ento-Pro');
    assert.equal(String(treatments[0].createdBy), String(me._id));
    const state = await call(`/api/sentinel/proposals/${created.body.proposalId}`, { method: 'GET' });
    assert.equal(state.body.state, 'confirmed');
    assert.equal(state.body.decidedVia, 'telegram');
    // The card in the app shows it as done
    const after = (await models.ChatSession.findOne({ userId: me._id, sessionId: 'sentinel' }).lean()).messages[0].cards[0];
    assert.equal(after.state, 'done');
});

test('proposal: rejected in Telegram records nothing; another chat cannot decide it', async () => {
    const me = await owner();
    await createUser({ role: 'manager', telegram: { chatId: '999', linkedAt: new Date() } });
    await createCamera(me, { deviceSerial: 'REJ1' });
    const created = await call('/api/sentinel/proposals', { body: { type: 'treatment', deviceSerial: 'REJ1', payload: { type: 'sanitation' }, evidence: EVIDENCE, reason: 'Fallen fruit.' } });
    const id = created.body.proposalId;

    const stranger = await telegramService.handleUpdate({ callback_query: { id: 'x', data: `sp:c:${id}`, from: { id: 999 }, message: { message_id: 1, chat: { id: 999 } } } });
    assert.equal(stranger.final, false);
    assert.equal((await call(`/api/sentinel/proposals/${id}`, { method: 'GET' })).body.state, 'pending');

    const rejected = await telegramService.handleUpdate({ callback_query: { id: 'y', data: `sp:r:${id}`, from: { id: 555 }, message: { message_id: 77, chat: { id: 555 } } } });
    assert.equal(rejected.state, 'cancelled');
    assert.equal((await call(`/api/sentinel/proposals/${id}`, { method: 'GET' })).body.state, 'rejected');
    assert.equal(await models.Treatment.countDocuments(), 0);
});

test('proposal: past its expiry it cannot be confirmed and reads as expired', async () => {
    const me = await owner();
    await createCamera(me, { deviceSerial: 'EXP1' });
    const created = await call('/api/sentinel/proposals', { body: { type: 'card_change', deviceSerial: 'EXP1', evidence: EVIDENCE, reason: 'New card?' } });
    const past = new Date(Date.now() - MINUTE);
    await models.SentinelProposal.updateOne({ _id: created.body.proposalId }, { $set: { expiresAt: past } });
    await models.ChatSession.updateOne({ userId: me._id, sessionId: 'sentinel' }, { $set: { 'messages.0.cards.0.expiresAt': past.toISOString() } });

    const late = await json(await request('/api/ai/chat/confirm', { method: 'POST', as: me, body: { sessionId: 'sentinel', messageId: created.body.cardId, cardIndex: 0, decision: 'confirm' } }));
    assert.equal(late.status, 410);
    assert.equal(late.body.state, 'expired');
    assert.equal(await models.MaintenanceEvent.countDocuments(), 0);
    assert.equal((await call(`/api/sentinel/proposals/${created.body.proposalId}`, { method: 'GET' })).body.state, 'expired');

    // Never clicked: GET marks it expired, and the card too
    const other = await call('/api/sentinel/proposals', { body: { type: 'card_change', deviceSerial: 'EXP1', evidence: EVIDENCE, reason: 'Again?' } });
    await models.SentinelProposal.updateOne({ _id: other.body.proposalId }, { $set: { expiresAt: past } });
    assert.equal((await call(`/api/sentinel/proposals/${other.body.proposalId}`, { method: 'GET' })).body.state, 'expired');
    const session = await models.ChatSession.findOne({ userId: me._id, sessionId: 'sentinel' }).lean();
    assert.equal(session.messages.find(m => m.id === other.body.cardId).cards[0].state, 'expired');
    assert.equal((await call('/api/sentinel/proposals/64b000000000000000000099', { method: 'GET' })).status, 404);
});

test('proposal: the assistant\'s checks apply; evidence and a reason are required', async () => {
    const me = await owner();
    const other = await owner({ telegram: undefined });
    await createCamera(me, { deviceSerial: 'VAL1', trapKind: 'sticky' });
    await createCamera(me, { deviceSerial: 'LURE1', trapKind: 'lure' });
    await createCamera(other, { deviceSerial: 'OTH1' });
    const theirs = await models.Snapshot.create({ deviceSerial: 'OTH1', imageUrl: 'u', s3Key: 'snapshots/OTH1/a.jpg' });
    const post = (body) => call('/api/sentinel/proposals', { body: { reason: 'x', evidence: EVIDENCE, ...body } });

    assert.equal((await post({ type: 'card_change', deviceSerial: 'VAL1', evidence: [] })).body.code, 'INVALID_EVIDENCE');
    assert.equal((await post({ type: 'card_change', deviceSerial: 'VAL1', evidence: undefined })).body.code, 'INVALID_EVIDENCE');
    assert.equal((await post({ type: 'card_change', deviceSerial: 'VAL1', evidence: [{ url: 'http://plain.example.com/a.jpg' }] })).body.code, 'INVALID_EVIDENCE');
    assert.equal((await post({ type: 'card_change', deviceSerial: 'VAL1', evidence: [{ snapshotId: String(theirs._id) }] })).body.code, 'INVALID_EVIDENCE');
    assert.equal((await post({ type: 'card_change', deviceSerial: 'VAL1', reason: '' })).status, 422);
    const lure = await post({ type: 'card_change', deviceSerial: 'LURE1' });
    assert.equal(lure.status, 422);
    assert.match(lure.body.message, /lure trap/);
    const noProduct = await post({ type: 'treatment', deviceSerial: 'VAL1', payload: { type: 'spray' } });
    assert.equal(noProduct.status, 422);
    assert.match(noProduct.body.message, /product/i);
    assert.equal((await post({ type: 'treatment', deviceSerials: ['VAL1', 'OTH1'], payload: { type: 'bait' } })).body.code, 'INVALID_PROPOSAL');
    assert.equal((await post({ type: 'card_change', deviceSerial: 'GHOST' })).status, 404);
    assert.equal((await post({ type: 'spray', deviceSerial: 'VAL1' })).status, 400);
    assert.equal(await models.SentinelProposal.countDocuments(), 0);

    // A photo of the camera as evidence: shown in the app, linked (presigned) in Telegram
    const mine = await models.Snapshot.create({ deviceSerial: 'VAL1', imageUrl: 'u', s3Key: 'snapshots/VAL1/b.jpg', aiProcessed: true, pestCount: 41, aiResults: { summary: { fruit_fly: 41 } } });
    const ok = await post({ type: 'card_change', deviceSerial: 'VAL1', evidence: [{ snapshotId: String(mine._id), caption: 'Latest photo' }] });
    assert.equal(ok.status, 201);
    const cards = (await models.ChatSession.findOne({ userId: me._id, sessionId: 'sentinel' }).lean()).messages[0].cards;
    assert.equal(cards[1].type, 'photos');
    assert.equal(cards[1].items[0].imageKey, 'snapshots/VAL1/b.jpg');
    assert.match(telegramSent.at(-1).photoUrl, /snapshots\/VAL1\/b\.jpg/);
});

test('proposal by plot id: the plot\'s traps, the plot as the area', async () => {
    const me = await owner();
    const farm = await models.Farm.create({ ownerId: me._id, name: 'Farm' });
    const plot = await models.Plot.create({ farmId: farm._id, name: 'Lô xoài A' });
    await createCamera(me, { deviceSerial: 'PL1', farmId: farm._id, plotId: plot._id });
    await createCamera(me, { deviceSerial: 'PL2', farmId: farm._id, plotId: plot._id });
    const created = await call('/api/sentinel/proposals', { body: { type: 'treatment', plot: String(plot._id), payload: { type: 'bait' }, evidence: EVIDENCE, reason: 'Plot average over threshold.' } });
    assert.equal(created.status, 201);
    const card = (await models.ChatSession.findOne({ userId: me._id, sessionId: 'sentinel' }).lean()).messages[0].cards[0];
    assert.deepEqual([...card.payload.cameraSerials].sort(), ['PL1', 'PL2']);
    assert.equal(card.payload.area, 'Lô xoài A');
});

// ---------- Review request ----------

test('review-request: the photo is flagged and its owner (only) is told, once', async () => {
    const me = await owner();
    const viewer = await createUser({ role: 'user' });
    await createCamera(me, { deviceSerial: 'REV1', deviceName: 'Mango B', sharedWith: [{ userId: viewer._id, email: viewer.email }] });
    const snap = await models.Snapshot.create({ deviceSerial: 'REV1', imageUrl: 'u', s3Key: 'k', aiProcessed: true, aiResults: { summary: { fruit_fly: 7 } } });

    const res = await call('/api/sentinel/review-request', { body: { snapshotId: String(snap._id), reason: 'NPU 3 vs OpenCV 11' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'requested');
    assert.equal(res.body.notified, 1);
    const flagged = await models.Snapshot.findById(snap._id).lean();
    assert.equal(flagged.review.requested.reason, 'NPU 3 vs OpenCV 11');
    assert.equal(flagged.review.status, undefined, 'still not reviewed');
    const notes = await models.Notification.find({ type: 'review_requested' }).lean();
    assert.equal(notes.length, 1);
    assert.equal(String(notes[0].userId), String(me._id));
    assert.deepEqual(notes[0].params, { deviceName: 'Mango B', reason: 'NPU 3 vs OpenCV 11', snapshotId: String(snap._id) });

    // The history page can list the photos to check
    const listed = await json(await request('/api/ai/results?review=requested', { as: me }));
    assert.deepEqual(listed.body.results.map(r => String(r._id)), [String(snap._id)]);

    assert.equal((await call('/api/sentinel/review-request', { body: { snapshotId: String(snap._id), reason: 'again' } })).body.status, 'already_requested');
    assert.equal(await models.Notification.countDocuments({ type: 'review_requested' }), 1);

    const reviewed = await models.Snapshot.create({ deviceSerial: 'REV1', imageUrl: 'u', s3Key: 'k2', review: { status: 'confirmed' } });
    assert.equal((await call('/api/sentinel/review-request', { body: { snapshotId: String(reviewed._id), reason: 'x' } })).body.status, 'already_reviewed');
    assert.equal((await call('/api/sentinel/review-request', { body: { snapshotId: '64b000000000000000000099', reason: 'x' } })).status, 404);
    assert.equal((await call('/api/sentinel/review-request', { body: { snapshotId: String(snap._id) } })).status, 422);
    assert.equal((await auditsOf('sentinel.review_requested', 1)).length, 1);
});

// ---------- Analysis ----------

async function analyzedHook(me) {
    const res = await json(await request('/api/integrations/webhooks', { method: 'POST', as: me, body: { url: 'https://hooks.example.com/sentinel', events: ['snapshot_analyzed'] } }));
    assert.equal(res.status, 201);
}
const analyzedPosts = () => posts.filter(p => p.headers['X-FlyBot-Event'] === 'snapshot_analyzed');

test('analysis: stored under aiResults.sentinel beside the production result, never sent back as snapshot_analyzed', async () => {
    const me = await owner();
    await createCamera(me, { deviceSerial: 'AN1' });
    await analyzedHook(me);
    const snap = await models.Snapshot.create({
        deviceSerial: 'AN1', imageUrl: 'u', s3Key: 'k', aiProcessed: true, aiProvider: 'roboflow', pestCount: 5,
        aiResults: { detected: true, summary: { fruit_fly: 5 }, insects: [{ name: 'fruit_fly', confidence: 0.8, bbox: [1, 1, 5, 5] }] }
    });
    const body = {
        snapshotId: String(snap._id), source: 'sentinel', counts: { fruit_fly: 7 },
        boxes: [{ label: 'fruit_fly', confidence: 0.91, bbox: [10, 20, 30, 40] }], boxFormat: 'xyxy_pixels',
        quality: { blur: 120.5, glare: 0.02, issues: [] }, evidence: [{ kind: 'crop', url: 's3://bucket/crop.jpg' }],
        model: 'yolov7-tiny-opencv5', traceId: 'tr-1'
    };
    const res = await call('/api/sentinel/analysis', { body });
    assert.equal(res.status, 200);
    assert.deepEqual({ stored: res.body.stored, summaryUpdated: res.body.summaryUpdated, count: res.body.count }, { stored: true, summaryUpdated: false, count: 7 });

    const stored = await models.Snapshot.findById(snap._id).lean();
    assert.equal(stored.aiResults.summary.fruit_fly, 5, 'production result unchanged');
    assert.equal(stored.pestCount, 5);
    assert.equal(stored.aiProvider, 'roboflow');
    assert.equal(stored.aiResults.insects.length, 1);
    const s = stored.aiResults.sentinel;
    assert.equal(s.source, 'sentinel');
    assert.deepEqual(s.counts, { fruit_fly: 7 });
    assert.equal(s.boxFormat, 'xyxy_pixels');
    assert.deepEqual(s.boxes[0].bbox, [10, 20, 30, 40]);
    assert.equal(s.quality.blur, 120.5);
    assert.equal(s.model, 'yolov7-tiny-opencv5');

    await new Promise(r => setTimeout(r, 100));
    assert.equal(analyzedPosts().length, 0, 'no snapshot_analyzed for a Sentinel analysis');

    // A production retry later keeps the Sentinel analysis
    const roboflowStub = await models.Snapshot.findByIdAndUpdate(snap._id, { 'aiResults.summary': { fruit_fly: 6 }, 'aiResults.insects': [] }, { new: true }).lean();
    assert.equal(roboflowStub.aiResults.sentinel.count, 7);

    const bad = (patch) => call('/api/sentinel/analysis', { body: { ...body, ...patch } });
    assert.equal((await bad({ counts: { fruit_fly: -1 } })).status, 422);
    assert.equal((await bad({ counts: { 'a.b': 1 } })).status, 422);
    assert.equal((await bad({ boxFormat: 'xywh' })).status, 400);
    assert.equal((await bad({ boxFormat: 'xyxy_normalized' })).status, 422, 'pixel values are not 0-1');
    assert.equal((await bad({ boxes: [{ bbox: [5, 5, 1, 1] }] })).status, 422);
    assert.equal((await bad({ source: 'roboflow' })).status, 400);
    assert.equal((await bad({ snapshotId: '64b000000000000000000099' })).status, 404);
    assert.equal((await sentinelAudits()).filter(a => a.action === 'sentinel.analysis').length, 0, 'shadow analyses are not audited');
});

test('AI_PROVIDER=sentinel: no cloud model at capture, the photo is announced as pending, and the analysis becomes its result', async () => {
    env.AI_PROVIDER = 'sentinel';
    const me = await owner();
    await createCamera(me, { deviceSerial: 'SM1', alertThreshold: 15 });
    await analyzedHook(me);
    ezvizService.captureDevice = async () => ({ code: '200', data: { picUrl: 'https://ezviz.example.test/pic.jpg' } });
    axios.get = async () => ({ data: testJpeg(80, 60) });
    let cloudCalls = 0;
    const realAnalyze = aiService.analyzeSnapshot;
    aiService.analyzeSnapshot = async (...args) => { cloudCalls++; return realAnalyze(...args); };

    const saved = await captureAndSaveSnapshot('SM1');
    assert.ok(saved);
    assert.equal(cloudCalls, 0, 'captureJob does not call the AI');
    const pending = await models.Snapshot.findById(saved._id).lean();
    assert.equal(pending.aiProcessed, false);
    await waitFor(() => analyzedPosts().length === 1);
    const event = JSON.parse(analyzedPosts()[0].body);
    assert.equal(event.params.aiSource, 'pending');
    assert.equal(event.params.count, null);
    assert.equal(event.params.width, 80);
    assert.equal(await models.Notification.countDocuments({ type: 'ai_failure' }), 0);
    assert.deepEqual(await retryFailedAnalyses(new Date(Date.now() + HOUR)), { retried: 0, succeeded: 0 });

    const res = await call('/api/sentinel/analysis', {
        body: { snapshotId: String(saved._id), source: 'sentinel', counts: { fruit_fly: 20 }, boxFormat: 'xyxy_normalized', width: 80, height: 60, boxes: [{ label: 'fruit_fly', confidence: 0.9, bbox: [0.1, 0.5, 0.2, 1] }] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.summaryUpdated, true);
    const done = await models.Snapshot.findById(saved._id).lean();
    assert.equal(done.aiProcessed, true);
    assert.equal(done.aiProvider, 'sentinel');
    assert.equal(done.pestCount, 20);
    assert.equal(done.aiResults.summary.fruit_fly, 20);
    assert.deepEqual(done.aiResults.insects[0].bbox, [8, 30, 16, 60], 'stored in pixels like production');
    assert.equal(done.aiResults.sentinel.count, 20);
    // Its alerts ran (threshold 15), and it was not announced again
    assert.equal(await models.Notification.countDocuments({ type: 'pest_threshold', userId: me._id }), 1);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(analyzedPosts().length, 1);
    assert.equal((await auditsOf('sentinel.analysis', 1)).length, 1);

    // A person's review is never overwritten
    await models.Snapshot.updateOne({ _id: saved._id }, { $set: { 'review.status': 'corrected', 'aiResults.summary': { fruit_fly: 18 } } });
    const again = await call('/api/sentinel/analysis', { body: { snapshotId: String(saved._id), counts: { fruit_fly: 25 } } });
    assert.equal(again.body.summaryUpdated, false);
    assert.equal((await models.Snapshot.findById(saved._id).lean()).aiResults.summary.fruit_fly, 18);
});
