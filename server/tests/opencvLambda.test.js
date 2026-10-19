const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jpeg = require('jpeg-js');

// Must be set before config/env loads (dbHelpers loads it); the URL is set once the stub listens
process.env.AI_PROVIDER = 'opencv-lambda';
process.env.PHOTOS_BY_REFERENCE = 'true';
process.env.S3_BUCKET_NAME = 'flybot-photos-test';
process.env.VISION_LAMBDA_URL = 'http://127.0.0.1:9/invoke';
process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera } = require('./dbHelpers');
const env = require('../src/config/env');
const aws = require('../src/platforms/aws');
const visionLambda = require('../src/services/visionLambda');
const aiService = require('../src/services/aiService');
const ezvizService = require('../src/services/ezvizService');
const snapshotEvents = require('../src/services/snapshotEvents');
const { captureAndSaveSnapshot } = require('../src/cron/captureJob');

// ---------- A local vision Lambda (uv run python -m sentinel.lambda_local stand-in) ----------
let stub;
let calls;
let answer; // (request) => { status, body }

function stubHandler(req, res) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = JSON.parse(raw);
        calls.push({ path: req.url, body });
        const out = answer(body);
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
    });
}

function okResponse(request, extra = {}) {
    return {
        status: 200,
        body: {
            v: 1,
            traceId: 'tr_20261016_080012_ab12',
            model: { name: 'yolo26n', version: '2026-10-18', engine: 'opencv-5.0.0-dnn-new' },
            counts: { total: 14, byClass: { fruit_fly: 14 } },
            boxes: [{ x: 0.5, y: 0.25, w: 0.1, h: 0.2, score: 0.91, cls: 'fruit_fly' }, { x: 0.1, y: 0.1, w: 0.05, h: 0.05, score: 0.4, cls: 'fruit_fly' }],
            quality: { ok: true, flags: [], blur: 0.12, exposure: 0.48 },
            ...(request.prevPhoto ? { diff: { newCount: 3, goneCount: 1, cardMoved: false } } : {}),
            proposals: [],
            trace: { planner: 'rule', steps: [{ tool: 'detect', ms: 410 }], tokens: { in: 0, cachedIn: 0, out: 0 }, ms: 1320 },
            evidence: { annotatedS3Key: null, crops: [] },
            privacy: { person_suspected: false },
            timings: { totalMs: 1320, dnnMs: 410 },
            ...extra
        }
    };
}

function testJpeg(width = 64, height = 48) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = 60 + ((i * 37) % 140);
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    return jpeg.encode({ data, width, height }, 80).data;
}
const PHOTO = testJpeg(640, 480);

before(async () => {
    await startDb();
    stub = http.createServer(stubHandler);
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    env.VISION_LAMBDA_URL = `http://127.0.0.1:${stub.address().port}/invoke`;
    visionLambda.setRetryDelay(60000);
});
after(async () => {
    await new Promise(resolve => stub.close(resolve));
    await stopDb();
});
beforeEach(async () => {
    await clearDb();
    calls = [];
    answer = okResponse;
});

const captureWith = (buffer) => {
    ezvizService.captureDevice = async () => ({ code: '200', data: { picUrl: 'http://127.0.0.1:9/pic.jpg' } });
    const ezviz = require('../src/platforms/ezviz');
    ezviz.snapshot = async () => ({ buffer, picUrl: null });
};

test('the request follows CONTRACTS section 1 and the answer is stored on the snapshot', async () => {
    const owner = await createUser({ role: 'manager', language: 'vi' });
    await createCamera(owner, { deviceSerial: 'BE4089629', deviceName: 'Củ Chi', trapKind: 'lure', latitude: 10.97, longitude: 106.49 });
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    await models.Snapshot.create({ deviceSerial: 'BE4089629', imageUrl: 'x', s3Key: 'snapshots/BE4089629/old.jpg', createdAt: yesterday, aiProcessed: true, aiResults: { summary: { fruit_fly: 12 } } });

    captureWith(PHOTO);
    const saved = await captureAndSaveSnapshot('BE4089629');
    assert.ok(saved, 'photo stored');
    assert.equal(calls.length, 1);
    const req = calls[0].body;
    assert.equal(req.v, 1);
    assert.equal(req.mode, 'detect');
    assert.deepEqual(req.photo, { s3Bucket: 'flybot-photos-test', s3Key: saved.s3Key });
    assert.deepEqual(req.prevPhoto, { s3Bucket: 'flybot-photos-test', s3Key: 'snapshots/BE4089629/old.jpg' });
    assert.deepEqual(req.camera, { id: 'BE4089629', name: 'Củ Chi', trapKind: 'lure', platform: 'ezviz', location: { lat: 10.97, lng: 106.49 } });
    assert.equal(req.capturedAt, saved.createdAt.toISOString());
    assert.deepEqual(req.history, [{ capturedAt: yesterday.toISOString(), count: 12 }]);
    assert.equal(req.locale, 'vi');
    assert.equal(req.question, undefined);

    const snap = await models.Snapshot.findById(saved._id).lean();
    assert.equal(snap.aiProcessed, true);
    assert.equal(snap.aiProvider, 'opencv-lambda');
    assert.equal(snap.pestCount, 14);
    assert.deepEqual(snap.aiResults.summary, { fruit_fly: 14 });
    assert.equal(snap.aiResults.detected, true);
    // Boxes in pixels of the 640x480 photo, [xmin, ymin, xmax, ymax]
    assert.deepEqual(snap.aiResults.insects[0].bbox, [320, 120, 384, 216]);
    assert.equal(snap.aiResults.insects[0].confidence, 0.91);
    assert.equal(snap.lambda.status, 'ok');
    assert.equal(snap.lambda.traceId, 'tr_20261016_080012_ab12');
    assert.equal(snap.lambda.model.name, 'yolo26n');
    assert.deepEqual(snap.lambda.quality, { ok: true, flags: [], blur: 0.12, exposure: 0.48 });
    assert.deepEqual(snap.lambda.diff, { newCount: 3, goneCount: 1, cardMoved: false });
    assert.equal(snap.lambda.trace.planner, 'rule');
    assert.deepEqual(snap.lambda.privacy, { person_suspected: false }, 'kept for blurring where the photo is shown');
    assert.equal(snap.lambda.width, 640);
    assert.equal(snap.lambda.attempts, 1);
    // Daily statistics and the quality check followed, as with every provider
    assert.ok((await models.DailyStat.countDocuments()) >= 1);
    assert.ok(snap.quality?.checkedAt);
});

test('photos travel as a signed URL when the bucket is not real S3', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'MINIO1' });
    const snap = await models.Snapshot.create({ deviceSerial: 'MINIO1', imageUrl: 'x', s3Key: 'snapshots/MINIO1/a.jpg' });
    env.PHOTOS_BY_REFERENCE = false;
    try {
        const req = await visionLambda.buildRequest(snap.toObject(), { deviceSerial: 'MINIO1', deviceName: 'M' }, { locale: 'en' });
        assert.match(req.photo.url, /^http:\/\/127\.0\.0\.1:9\/.*snapshots\/MINIO1\/a\.jpg.*X-Amz-Signature=/);
        assert.equal(req.prevPhoto, undefined);
        assert.equal(req.locale, 'en');
    } finally {
        env.PHOTOS_BY_REFERENCE = true;
    }
});

test('proposals become confirm cards in the owner\'s Sentinel conversation; snapshot_analyzed is unchanged', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'BE4111159', deviceName: 'Lô B', trapKind: 'sticky' });
    answer = (req) => okResponse(req, {
        proposals: [
            { id: 'p1', action: 'set_interval', params: { minutes: 15 }, reason: 'Đếm tăng gấp đôi so với hôm qua', confidence: 0.8, requiresApproval: true },
            { id: 'p2', action: 'set_isp', params: { brightness: 10 }, reason: 'dark', confidence: 0.5, requiresApproval: true },
            { id: 'p3', action: 'bogus', params: {}, reason: 'x' }
        ]
    });
    const events = [];
    const original = snapshotEvents.emitAnalyzed;
    snapshotEvents.emitAnalyzed = async (id, opts) => { events.push({ id: String(id), opts }); return 0; };
    try {
        captureWith(PHOTO);
        const saved = await captureAndSaveSnapshot('BE4111159');
        assert.ok(saved);
        assert.equal(events.length, 1);
        assert.equal(events[0].id, String(saved._id));
        assert.equal(events[0].opts.pending, false);
        // The payload the webhook carries: the Lambda's counts as the photo's result
        const payload = await snapshotEvents.buildPayload(await models.Snapshot.findById(saved._id).lean(), { buffer: PHOTO });
        assert.equal(payload.params.count, 14);
        assert.equal(payload.params.aiProvider, 'opencv-lambda');
        assert.equal(payload.params.aiSource, 'cloud');
        assert.equal(payload.params.boxFormat, 'xyxy_pixels');

        // set_interval became a card; set_isp was refused (not a CamOS camera); bogus dropped
        const proposals = await models.SentinelProposal.find().lean();
        assert.deepEqual(proposals.map(p => p.type), ['set_interval']);
        assert.equal(proposals[0].source, 'lambda');
        assert.equal(proposals[0].traceId, 'tr_20261016_080012_ab12');
        assert.equal(String(proposals[0].snapshotId), String(saved._id));
        assert.equal(proposals[0].confidence, 0.8);
        assert.deepEqual(proposals[0].payload.params, { minutes: 15 });
        const session = await models.ChatSession.findOne({ userId: owner._id, sessionId: 'sentinel' }).lean();
        const card = session.messages[0].cards[0];
        assert.equal(card.type, 'confirm');
        assert.equal(card.action, 'set_interval');
        assert.equal(card.state, 'pending');
        assert.deepEqual(card.payload, { deviceSerial: 'BE4111159', minutes: 15, snapshotId: String(saved._id) });
        assert.equal(card.summary.trapKind, 'sticky');
        assert.equal(card.reason, 'Đếm tăng gấp đôi so với hôm qua');
        assert.equal(session.messages[0].cards[1].type, 'photos');

        // Confirming the card applies the interval (24 h) through the existing confirm endpoint
        const res = await request('/api/ai/chat/confirm', { method: 'POST', as: owner, body: { sessionId: 'sentinel', messageId: session.messages[0].id, cardIndex: 0, decision: 'confirm' } });
        assert.equal(res.status, 200, await res.text());
        const cam = await models.Camera.findOne({ deviceSerial: 'BE4111159' }).lean();
        assert.equal(cam.sentinelInterval.minutes, 15);
        assert.ok(cam.sentinelInterval.until > new Date());
        assert.equal((await models.SentinelProposal.findById(proposals[0]._id).lean()).state, 'confirmed');
    } finally {
        snapshotEvents.emitAnalyzed = original;
    }
});

test('an error keeps the photo, marks the analysis failed and retries once after the delay', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'RETRY1' });
    let n = 0;
    answer = (req) => (++n === 1 ? { status: 503, body: { v: 1, error: { code: 'model_unavailable', message: 'warming up' } } } : okResponse(req));
    const events = [];
    const original = snapshotEvents.emitAnalyzed;
    snapshotEvents.emitAnalyzed = async (id) => { events.push(String(id)); return 0; };
    try {
        captureWith(PHOTO);
        const saved = await captureAndSaveSnapshot('RETRY1');
        assert.ok(saved, 'the photo is kept');
        let snap = await models.Snapshot.findById(saved._id).lean();
        assert.equal(snap.aiProcessed, false);
        assert.equal(snap.lambda.status, 'failed');
        assert.equal(snap.lambda.error.code, 'model_unavailable');
        assert.equal(snap.lambda.attempts, 1);
        assert.equal(visionLambda.pendingRetries(), 1);
        // The webhook fired once at capture (no result yet) and once more after the retry
        assert.equal(events.length, 1);
        assert.equal(await visionLambda.flushRetries(), 1);
        assert.equal(calls.length, 2);
        snap = await models.Snapshot.findById(saved._id).lean();
        assert.equal(snap.aiProcessed, true);
        assert.equal(snap.lambda.status, 'ok');
        assert.equal(snap.lambda.attempts, 2);
        assert.equal(snap.pestCount, 14);
        assert.equal(events.length, 2);
        assert.equal(visionLambda.pendingRetries(), 0);

        // A second failure stays failed: no third attempt (the AI retry cron takes over)
        answer = () => ({ status: 500, body: { v: 1, error: { code: 'internal', message: 'boom' } } });
        const saved2 = await captureAndSaveSnapshot('RETRY1');
        assert.equal(await visionLambda.flushRetries(), 1);
        snap = await models.Snapshot.findById(saved2._id).lean();
        assert.equal(snap.aiProcessed, false);
        assert.equal(snap.lambda.attempts, 2);
        assert.equal(calls.length, 4);
    } finally {
        snapshotEvents.emitAnalyzed = original;
    }
});

test('deep mode: the question goes to the Lambda, the answer is kept on the photo', async () => {
    const owner = await createUser({ role: 'manager', language: 'en' });
    const camera = await createCamera(owner, { deviceSerial: 'DEEP1', deviceName: 'Deep' });
    const snap = await models.Snapshot.create({ deviceSerial: 'DEEP1', imageUrl: 'x', s3Key: 'snapshots/DEEP1/a.jpg', aiProcessed: true, aiResults: { summary: { fruit_fly: 3 } } });
    answer = (req) => okResponse(req, { answer: '**Count jumped** because the lure was refilled.', trace: { planner: 'llm', steps: [], ms: 2000 } });
    const res = await visionLambda.deepAnalyze(snap.toObject(), camera.toObject(), { question: 'Why did the count jump today?', locale: 'en' });
    assert.equal(calls[0].body.mode, 'deep');
    assert.equal(calls[0].body.question, 'Why did the count jump today?');
    assert.equal(calls[0].body.locale, 'en');
    assert.match(res.answer, /Count jumped/);
    const stored = await models.Snapshot.findById(snap._id).lean();
    assert.equal(stored.lambda.deep.length, 1);
    assert.equal(stored.lambda.deep[0].question, 'Why did the count jump today?');
    assert.equal(stored.lambda.deep[0].trace.planner, 'llm');
    assert.equal(stored.aiResults.summary.fruit_fly, 3, 'deep mode does not change the stored count');
});

test('on AWS the same JSON goes through Lambda.Invoke; a FunctionError is the Lambda\'s error', async () => {
    const owner = await createUser({ role: 'manager' });
    const camera = await createCamera(owner, { deviceSerial: 'SDK1' });
    const snap = await models.Snapshot.create({ deviceSerial: 'SDK1', imageUrl: 'x', s3Key: 'snapshots/SDK1/a.jpg' });
    const url = env.VISION_LAMBDA_URL;
    env.VISION_LAMBDA_URL = '';
    env.VISION_LAMBDA_NAME = 'flybot-vision';
    const sent = [];
    aws.setClient('lambda', {
        async send(command) {
            sent.push({ name: aws.commandName(command), input: command.input });
            const req = JSON.parse(Buffer.from(command.input.Payload).toString());
            if (req.camera.id === 'SDK1' && sent.length === 1) return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(okResponse(req).body)) };
            return { StatusCode: 200, FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ v: 1, error: { code: 'photo_not_found', message: 'no such key' } })) };
        }
    });
    try {
        const first = await visionLambda.analyzeSnapshot(snap._id, { buffer: PHOTO });
        assert.equal(first.ok, true);
        assert.equal(sent[0].name, 'InvokeCommand');
        assert.equal(sent[0].input.FunctionName, 'flybot-vision');
        assert.equal(sent[0].input.InvocationType, 'RequestResponse');
        assert.equal((await models.Snapshot.findById(snap._id).lean()).pestCount, 14);

        const other = await models.Snapshot.create({ deviceSerial: 'SDK1', imageUrl: 'x', s3Key: 'snapshots/SDK1/b.jpg' });
        const second = await visionLambda.analyzeSnapshot(other._id, { buffer: PHOTO });
        assert.equal(second.ok, false);
        assert.equal(second.error.code, 'photo_not_found');
        assert.equal(visionLambda.pendingRetries(), 0, 'a missing photo is not retried');
        // aiService routes the provider
        assert.equal(await aiService.analyzeSnapshot(PHOTO.toString('base64'), other._id), false);
        assert.equal(camera.platform, 'ezviz');
    } finally {
        aws.setClient('lambda', null);
        env.VISION_LAMBDA_URL = url;
        env.VISION_LAMBDA_NAME = '';
    }
});
