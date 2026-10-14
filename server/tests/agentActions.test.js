const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, createUser, createCamera, request } = require('./dbHelpers');
const agent = require('../src/agent/agent');
const aiService = require('../src/services/aiService');
const { allExecutors } = require('../src/agent/tools');
const dailyStats = require('../src/services/dailyStats');
const morningBrief = require('../src/services/morningBriefService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const DAY = 24 * 60 * 60 * 1000;
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

/** Ask a question whose answer proposes something; returns the stored answer. */
async function proposal(owner, sessionId, call) {
    scriptModel([[chunk({ functionCall: call })], [chunk({ text: 'Please check and confirm.' })]]);
    const result = await agent.chatWithAgent({ sessionId, message: 'Record it', userId: String(owner._id), user: userOf(owner) });
    return result;
}
const confirm = (as, body) => request('/api/ai/chat/confirm', { method: 'POST', as, body });

test('inspect_photo: the vision model looks at a visible photo, within a quota', async () => {
    const owner = await createUser({ role: 'manager', language: 'vi' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'VIS1', deviceName: 'Mango A' });
    const snap = await models.Snapshot.create({ deviceSerial: 'VIS1', imageUrl: 'x', s3Key: 'snapshots/VIS1/a.jpg', aiProcessed: true, aiResults: { summary: { fruit_fly: 9 } } });
    const original = aiService.describePhoto;
    const calls = [];
    aiService.describePhoto = async (image, question, opts) => {
        calls.push({ image: image.toString(), question, opts });
        return 'Nine fruit flies, the card is clean.';
    };
    try {
        const cards = [];
        const res = await allExecutors.inspect_photo({ ...asUser(owner), snapshotId: String(snap._id), question: 'Đếm đúng không?', addCard: (c) => cards.push(c) });
        assert.equal(res.observation, 'Nine fruit flies, the card is clean.');
        assert.equal(res.detectedPests, 9);
        assert.equal(calls[0].image, 'JPEGDATA', 'image read from storage');
        assert.match(calls[0].opts.context, /9 pests/);
        assert.equal(calls[0].opts.language, 'vi');
        assert.equal(cards[0].items[0].name, 'Mango A');

        assert.match((await allExecutors.inspect_photo({ ...asUser(other), snapshotId: String(snap._id) })).error, /not found/);
        assert.match((await allExecutors.inspect_photo({ ...asUser(owner), snapshotId: 'nope' })).error, /not found/);
        for (let i = 0; i < 25; i++) await allExecutors.inspect_photo({ ...asUser(owner), snapshotId: String(snap._id) });
        assert.match((await allExecutors.inspect_photo({ ...asUser(owner), snapshotId: String(snap._id) })).error, /many times/);
    } finally {
        aiService.describePhoto = original;
    }
});

test('a proposed card change is recorded only on Confirm, once, by its owner', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'CRD1', deviceName: 'Mango A' });
    const answer = await proposal(owner, 'a1', { name: 'propose_card_change', args: { deviceSerial: 'CRD1' } });
    assert.equal(answer.cards[0].type, 'confirm');
    assert.equal(answer.cards[0].summary.trap, 'Mango A');
    assert.equal(await models.MaintenanceEvent.countDocuments(), 0, 'nothing recorded yet');

    const body = { sessionId: 'a1', messageId: answer.messageId, cardIndex: 0, decision: 'confirm' };
    assert.equal((await confirm(other, body)).status, 409, 'not someone else');
    const res = await confirm(owner, body);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'done');
    const events = await models.MaintenanceEvent.find().lean();
    assert.deepEqual(events.map(e => [e.deviceSerial, e.type]), [['CRD1', 'card_replaced']]);
    assert.equal((await confirm(owner, body)).status, 409, 'not twice');
    const [, stored] = await agent.getChatHistory(String(owner._id), 'a1');
    assert.equal(stored.cards[0].state, 'done');

    // Lure traps have no card; viewers cannot manage the camera
    await createCamera(owner, { deviceSerial: 'LUR1', trapKind: 'lure' });
    assert.match((await allExecutors.propose_card_change({ ...asUser(owner), deviceSerial: 'LUR1' })).error, /lure/);
    assert.match((await allExecutors.propose_card_change({ ...asUser(other), deviceSerial: 'CRD1' })).error, /cannot manage/);
});

test('a proposed treatment: checked like the logbook form, cancel records nothing', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'TRT1', deviceName: 'Mango A' });
    assert.match((await allExecutors.propose_treatment({ ...asUser(owner), cameraSerials: ['TRT1'], type: 'spray' })).error, /product/i);

    const cancelled = await proposal(owner, 'b1', { name: 'propose_treatment', args: { cameraSerials: ['TRT1'], type: 'bait', product: 'Protein bait' } });
    const cancel = await confirm(owner, { sessionId: 'b1', messageId: cancelled.messageId, cardIndex: 0, decision: 'cancel' });
    assert.equal((await cancel.json()).state, 'cancelled');
    assert.equal((await confirm(owner, { sessionId: 'b1', messageId: cancelled.messageId, cardIndex: 0, decision: 'confirm' })).status, 409);

    const answer = await proposal(owner, 'b2', { name: 'propose_treatment', args: { cameraSerials: ['TRT1'], type: 'spray', product: 'Abamectin' } });
    assert.deepEqual(answer.cards[0].summary.traps, ['Mango A']);
    const res = await confirm(owner, { sessionId: 'b2', messageId: answer.messageId, cardIndex: 0, decision: 'confirm' });
    assert.equal(res.status, 200);
    const treatments = await models.Treatment.find().lean();
    assert.deepEqual(treatments.map(t => [t.type, t.product, t.cameraSerials]), [['spray', 'Abamectin', ['TRT1']]]);
    assert.equal((await confirm(owner, { sessionId: 'b2', messageId: answer.messageId, cardIndex: 3, decision: 'confirm' })).status, 409, 'no such card');
});

test('morning brief: opt-in, figures and threshold judged as alerts, email when there is no Telegram', async () => {
    const owner = await createUser({ role: 'manager', language: 'vi' });
    const quiet = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'MB1', deviceName: 'Mango A', alertThreshold: 10, status: 1 });
    await createCamera(owner, { deviceSerial: 'MB2', deviceName: 'Mango B', alertThreshold: 10, status: 0, addedAt: new Date(Date.now() - 40 * DAY) });
    await createCamera(quiet, { deviceSerial: 'MB3' });
    const doc = await models.Snapshot.create({ deviceSerial: 'MB1', imageUrl: 'x', s3Key: 'k', aiProcessed: true, aiResults: { summary: { fruit_fly: 12 } } });
    await dailyStats.refreshForSnapshot(doc);

    // Turned on through the profile, like the settings switch
    const res = await request('/api/auth/profile', { method: 'POST', as: owner, body: { notificationPrefs: { morningBrief: true } } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.notificationPrefs.morningBrief, true);

    const brief = await morningBrief.buildMorningBrief(owner);
    assert.deepEqual(brief.over, ['Mango A']);
    assert.deepEqual(brief.offline, ['Mango B']);
    assert.deepEqual(brief.cardsDue, ['Mango B']);
    const lines = morningBrief.briefLines(brief, 'vi');
    assert.ok(lines.some(l => l === 'Vượt ngưỡng: Mango A.'));

    sentMails.length = 0;
    const { sent } = await morningBrief.sendMorningBriefs();
    assert.equal(sent, 1, 'only the user who turned it on');
    assert.equal(sentMails[0].to, owner.email);
    assert.match(sentMails[0].subject, /Bản tin sáng/);
});

test('a treatment told by plot name: its traps, the operator and the pre-harvest days on the card', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    const farm = await models.Farm.create({ ownerId: owner._id, name: 'Vườn Hòa Lộc' });
    const plotA = await models.Plot.create({ farmId: farm._id, name: 'Lô xoài A' });
    const plotB = await models.Plot.create({ farmId: farm._id, name: 'Lô bưởi B' });
    await createCamera(owner, { deviceSerial: 'PA1', deviceName: 'Bẫy xoài A1', farmId: farm._id, plotId: plotA._id });
    await createCamera(owner, { deviceSerial: 'PA2', deviceName: 'Bẫy xoài A2', farmId: farm._id, plotId: plotA._id });
    await createCamera(owner, { deviceSerial: 'PB1', farmId: farm._id, plotId: plotB._id });
    const theirFarm = await models.Farm.create({ ownerId: other._id, name: 'Lô xoài A' });
    await createCamera(other, { deviceSerial: 'XX1', farmId: theirFarm._id });

    const cards = [];
    const result = await allExecutors.propose_treatment({
        ...asUser(owner), addCard: (c) => cards.push(c),
        plot: 'lo xoai a', type: 'spray', product: 'Radiant 60SC', operator: 'Tư', preHarvestDays: 7
    });
    assert.equal(result.proposed, true);
    assert.deepEqual(cards[0].payload.cameraSerials.sort(), ['PA1', 'PA2'], "only the plot's traps, never someone else's farm of the same name");
    assert.equal(cards[0].payload.operator, 'Tư');
    assert.equal(cards[0].payload.preHarvestDays, 7);
    assert.equal(cards[0].summary.area, 'Lô xoài A');
    assert.equal(cards[0].summary.preHarvestDays, 7);

    // A whole farm, and a name that matches nothing
    const farmCards = [];
    await allExecutors.propose_treatment({ ...asUser(owner), addCard: (c) => farmCards.push(c), plot: 'Vườn Hòa Lộc', type: 'sanitation' });
    assert.deepEqual(farmCards[0].payload.cameraSerials.sort(), ['PA1', 'PA2', 'PB1']);
    const unknown = await allExecutors.propose_treatment({ ...asUser(owner), plot: 'Lô cam C', type: 'sanitation' });
    assert.match(unknown.error, /Lô xoài A/, 'the error lists the plots the assistant can use');
    assert.match((await allExecutors.propose_treatment({ ...asUser(owner), type: 'sanitation' })).error, /traps or the plot/);
});
