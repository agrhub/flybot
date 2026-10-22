const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.VISION_LAMBDA_URL = 'http://127.0.0.1:9/invoke';
process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, createUser, createCamera, request } = require('./dbHelpers');
const env = require('../src/config/env');
const agent = require('../src/agent/agent');
const { allExecutors, allFunctionDeclarations } = require('../src/agent/tools');
const visionLambda = require('../src/services/visionLambda');
const aws = require('../src/platforms/aws');
const { getAgentInstruction } = require('../src/agent/prompts');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const userOf = (u) => ({ id: String(u._id), role: u.role, language: u.language, email: u.email });
const asUser = (u) => ({ userId: String(u._id), user: userOf(u), addAction: () => {} });
const chunk = (...parts) => ({ candidates: [{ content: { role: 'model', parts } }] });
function scriptModel(turns) {
    agent.setModelClient({
        stream: async () => {
            const chunks = turns.shift();
            return (async function* () { for (const c of chunks) yield c; })();
        }
    });
}
async function proposal(owner, sessionId, call) {
    scriptModel([[chunk({ functionCall: call })], [chunk({ text: 'Please check and confirm.' })]]);
    return agent.chatWithAgent({ sessionId, message: 'Do it', userId: String(owner._id), user: userOf(owner) });
}
const confirm = (as, body) => request('/api/ai/chat/confirm', { method: 'POST', as, body });

test('the tools are declared and the prompt names them and the trap kinds', () => {
    const names = allFunctionDeclarations.map(d => d.name);
    assert.ok(names.includes('analyze_photo_deep'));
    assert.ok(names.includes('propose_action'));
    const prompt = getAgentInstruction();
    assert.match(prompt, /analyze_photo_deep/);
    assert.match(prompt, /propose_action/);
    assert.match(prompt, /"sticky"/);
    assert.match(prompt, /"lure"/);
    assert.match(prompt, /CamOS/);
});

test('analyze_photo_deep: the Lambda answers a question about a visible photo (by id or latest of a camera)', async () => {
    const owner = await createUser({ role: 'manager', language: 'vi' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'DP1', deviceName: 'Mango A', trapKind: 'lure' });
    const older = await models.Snapshot.create({ deviceSerial: 'DP1', imageUrl: 'x', s3Key: 'snapshots/DP1/a.jpg', createdAt: new Date(Date.now() - 3600 * 1000), aiProcessed: true, aiResults: { summary: { fruit_fly: 5 } } });
    const latest = await models.Snapshot.create({ deviceSerial: 'DP1', imageUrl: 'x', s3Key: 'snapshots/DP1/b.jpg', aiProcessed: true, aiResults: { summary: { fruit_fly: 9 } } });
    const original = visionLambda.deepAnalyze;
    const calls = [];
    visionLambda.deepAnalyze = async (snap, camera, opts) => {
        calls.push({ id: String(snap._id), camera: camera.deviceSerial, opts });
        return { v: 1, answer: 'Chín con ruồi, mồi vừa được thay.', counts: { total: 9, byClass: { fruit_fly: 9 } }, quality: { ok: true, flags: [] }, proposals: [{ action: 'capture_now', params: {}, reason: 'check again' }], traceId: 'tr_1' };
    };
    try {
        const cards = [];
        const res = await allExecutors.analyze_photo_deep({ ...asUser(owner), snapshotId: String(older._id), question: 'Tại sao tăng?', addCard: (c) => cards.push(c) });
        assert.equal(res.answer, 'Chín con ruồi, mồi vừa được thay.');
        assert.equal(res.counts.total, 9);
        assert.equal(res.trapKind, 'lure');
        assert.equal(res.traceId, 'tr_1');
        assert.deepEqual(res.proposals, [{ action: 'capture_now', params: {}, reason: 'check again' }]);
        assert.equal(calls[0].id, String(older._id));
        assert.equal(calls[0].opts.locale, 'vi');
        assert.equal(calls[0].opts.question, 'Tại sao tăng?');
        assert.equal(cards[0].type, 'photos');
        assert.equal(cards[0].items[0].name, 'Mango A');

        const byCamera = await allExecutors.analyze_photo_deep({ ...asUser(owner), deviceSerial: 'DP1', question: 'Now?' });
        assert.equal(calls[1].id, String(latest._id), 'the latest photo of the camera');
        assert.equal(byCamera.storedCount, 9);

        assert.match((await allExecutors.analyze_photo_deep({ ...asUser(other), snapshotId: String(latest._id), question: 'x' })).error, /not found/);
        assert.match((await allExecutors.analyze_photo_deep({ ...asUser(owner), deviceSerial: 'NOPE', question: 'x' })).error, /not found/);
        assert.match((await allExecutors.analyze_photo_deep({ ...asUser(owner), question: 'x' })).error, /photo id or the camera/);
        visionLambda.deepAnalyze = async () => { throw Object.assign(new Error('late'), { code: 'timeout' }); };
        assert.match((await allExecutors.analyze_photo_deep({ ...asUser(owner), deviceSerial: 'DP1', question: 'x' })).error, /did not answer in time/);
        const url = env.VISION_LAMBDA_URL;
        env.VISION_LAMBDA_URL = '';
        assert.match((await allExecutors.analyze_photo_deep({ ...asUser(owner), deviceSerial: 'DP1', question: 'x' })).error, /not set up/);
        env.VISION_LAMBDA_URL = url;
    } finally {
        visionLambda.deepAnalyze = original;
    }
});

test('propose_action: a confirm card the owner confirms; each action runs through the card, never by itself', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser({ role: 'user' });
    await createCamera(owner, { deviceSerial: 'PA1', deviceName: 'Mango A', sharedWith: [{ userId: viewer._id, email: viewer.email }] });
    const snap = await models.Snapshot.create({ deviceSerial: 'PA1', imageUrl: 'x', s3Key: 'snapshots/PA1/a.jpg', aiProcessed: true, aiResults: { summary: { fruit_fly: 5 } } });

    // Checks
    assert.match((await allExecutors.propose_action({ ...asUser(owner), deviceSerial: 'PA1', action: 'set_interval', minutes: 7 })).error, /one of/);
    assert.match((await allExecutors.propose_action({ ...asUser(owner), deviceSerial: 'PA1', action: 'set_isp', brightness: 10 })).error, /CamOS/);
    assert.match((await allExecutors.propose_action({ ...asUser(owner), deviceSerial: 'PA1', action: 'notify' })).error, /message/);
    assert.match((await allExecutors.propose_action({ ...asUser(owner), deviceSerial: 'PA1', action: 'explode' })).error, /action must be/);
    assert.match((await allExecutors.propose_action({ ...asUser(viewer), deviceSerial: 'PA1', action: 'capture_now' })).error, /cannot manage/);

    // set_interval: a card, then the interval for 24 h on Confirm
    const a1 = await proposal(owner, 's1', { name: 'propose_action', args: { deviceSerial: 'PA1', action: 'set_interval', minutes: 15, reason: 'Counts rising' } });
    assert.equal(a1.cards[0].type, 'confirm');
    assert.equal(a1.cards[0].action, 'set_interval');
    assert.deepEqual(a1.cards[0].payload, { deviceSerial: 'PA1', minutes: 15 });
    assert.equal(a1.cards[0].summary.trap, 'Mango A');
    assert.equal(a1.cards[0].reason, 'Counts rising');
    assert.equal((await models.Camera.findOne({ deviceSerial: 'PA1' }).lean()).sentinelInterval?.minutes, undefined, 'nothing applied yet');
    assert.equal((await confirm(viewer, { sessionId: 's1', messageId: a1.messageId, cardIndex: 0, decision: 'confirm' })).status, 409, 'not someone else');
    const r1 = await confirm(owner, { sessionId: 's1', messageId: a1.messageId, cardIndex: 0, decision: 'confirm' });
    assert.equal(r1.status, 200, await r1.text());
    const cam = await models.Camera.findOne({ deviceSerial: 'PA1' }).lean();
    assert.equal(cam.sentinelInterval.minutes, 15);
    assert.ok(cam.sentinelInterval.until - Date.now() > 23 * 3600 * 1000);

    // review_request flags the photo; notify writes a notification; capture_now fails cleanly offline
    const a2 = await proposal(owner, 's2', { name: 'propose_action', args: { deviceSerial: 'PA1', action: 'review_request', snapshotId: String(snap._id) } });
    assert.equal((await confirm(owner, { sessionId: 's2', messageId: a2.messageId, cardIndex: 0, decision: 'confirm' })).status, 200);
    assert.equal((await models.Snapshot.findById(snap._id).lean()).review.requested.by, 'sentinel');

    const a3 = await proposal(owner, 's3', { name: 'propose_action', args: { deviceSerial: 'PA1', action: 'notify', message: 'Check the lure today' } });
    assert.equal((await confirm(owner, { sessionId: 's3', messageId: a3.messageId, cardIndex: 0, decision: 'confirm' })).status, 200);
    const notes = await models.Notification.find({ userId: owner._id }).lean();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].params.reason, 'Check the lure today');

    const a4 = await proposal(owner, 's4', { name: 'propose_action', args: { deviceSerial: 'PA1', action: 'capture_now' } });
    const r4 = await confirm(owner, { sessionId: 's4', messageId: a4.messageId, cardIndex: 0, decision: 'confirm' });
    assert.equal(r4.status, 400, 'the stubbed camera is offline');
    assert.equal((await r4.json()).state, 'failed');
    // Cancel runs nothing
    const a5 = await proposal(owner, 's5', { name: 'propose_action', args: { deviceSerial: 'PA1', action: 'set_interval', minutes: 120 } });
    assert.equal((await (await confirm(owner, { sessionId: 's5', messageId: a5.messageId, cardIndex: 0, decision: 'cancel' })).json()).state, 'cancelled');
    assert.equal((await models.Camera.findOne({ deviceSerial: 'PA1' }).lean()).sentinelInterval.minutes, 15);
});

test('propose_action on a CamOS camera: set_isp goes to the shadow on Confirm', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ESPX', platform: 'camos', deviceName: 'ESP trap', device: { thingName: 'ESPX' } });
    const iot = { calls: [], async send(command) { this.calls.push({ name: aws.commandName(command), input: command.input }); return { payload: Buffer.from('{"state":{}}') }; } };
    aws.setClient('iotData', iot);
    try {
        const a = await proposal(owner, 'c1', { name: 'propose_action', args: { deviceSerial: 'ESPX', action: 'set_isp', brightness: 20, wdr: true, reason: 'Dark photos' } });
        assert.deepEqual(a.cards[0].payload, { deviceSerial: 'ESPX', brightness: 20, wdr: true });
        assert.equal(iot.calls.length, 0, 'nothing sent before Confirm');
        const r = await confirm(owner, { sessionId: 'c1', messageId: a.messageId, cardIndex: 0, decision: 'confirm' });
        assert.equal(r.status, 200, await r.text());
        const update = iot.calls.find(c => c.name === 'UpdateThingShadowCommand');
        // The camera has no WDR (not a remote setting of the firmware): only the brightness is sent
        assert.deepEqual(JSON.parse(update.input.payload.toString()), { state: { desired: { video: { image: { brightness: 20 } } } } });
    } finally {
        aws.setClient('iotData', null);
    }
});
