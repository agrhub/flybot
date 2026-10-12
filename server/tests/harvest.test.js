const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const harvest = require('../src/services/harvestService');

before(startDb);
after(stopDb);
beforeEach(() => { sentMails.length = 0; return clearDb(); });

// 06:00 on 12 October 2026, farm time (UTC+7)
const NOW = new Date('2026-10-11T23:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const treatment = (serials, at, preHarvestDays, extra = {}) =>
    models.Treatment.create({ cameraSerials: serials, type: 'spray', at: new Date(at), preHarvestDays, product: 'Radiant 60SC', area: 'Mango plot A', ...extra });

test('the traps still inside a pre-harvest interval, soonest first', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1', deviceName: 'Mango trap A1' });
    await createCamera(other, { deviceSerial: 'X1' });
    const now = new Date();
    await treatment(['A1'], now.getTime() - 2 * DAY_MS, 7);                // 5 days left
    await treatment(['A1'], now.getTime() - DAY_MS, 3, { product: 'B' });    // 2 days left: first
    await treatment(['A1'], now.getTime() - 10 * DAY_MS, 7);               // over
    await treatment(['A1'], now.getTime() - DAY_MS, 0);                    // no interval
    await treatment(['X1'], now.getTime() - DAY_MS, 7);                    // not theirs

    const res = await json(await request('/api/treatments/withholding', { as: owner }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.treatments.map(t => t.product), ['B', 'Radiant 60SC']);
    assert.deepEqual(res.body.treatments[0].traps, ['Mango trap A1']);
    assert.ok(new Date(res.body.treatments[0].harvestAllowedFrom) > now);
});

test('the morning an interval ends, everyone who sees the traps is told once', async () => {
    const owner = await createUser({ role: 'manager', email: 'owner@example.test', language: 'vi' });
    const viewer = await createUser({ email: 'viewer@example.test' });
    const muted = await createUser({ email: 'muted@example.test', notificationPrefs: { mutedCameras: ['A1'] } });
    await createCamera(owner, {
        deviceSerial: 'A1', deviceName: 'Mango trap A1',
        sharedWith: [{ userId: viewer._id, email: viewer.email }, { userId: muted._id, email: muted.email }]
    });
    // Sprayed 5 October 07:00 farm time, 7 days: harvest from 12 October 07:00
    const due = await treatment(['A1'], '2026-10-05T00:00:00Z', 7);
    await treatment(['A1'], '2026-10-06T00:00:00Z', 7);                    // tomorrow
    await treatment(['A1'], '2026-09-01T00:00:00Z', 7);                    // long over

    assert.deepEqual(await harvest.sendHarvestReminders(NOW), { sent: 1 });
    const notes = await models.Notification.find({ type: 'harvest_ready' }).lean();
    assert.deepEqual(notes.map(n => String(n.userId)).sort(), [String(owner._id), String(viewer._id)].sort());
    assert.equal(notes[0].params.date, '12/10/2026 07:00');
    assert.equal(notes[0].params.traps, 'Mango trap A1');
    assert.deepEqual(sentMails.map(m => m.to).sort(), ['owner@example.test', 'viewer@example.test']);
    assert.match(sentMails.find(m => m.to === 'owner@example.test').subject, /Được thu hoạch: Radiant 60SC \(Mango plot A\)/);

    // Run again (or on a second server): nothing more
    assert.deepEqual(await harvest.sendHarvestReminders(NOW), { sent: 0 });
    assert.equal(await models.Notification.countDocuments({ type: 'harvest_ready' }), 2);
    assert.ok((await models.Treatment.findById(due._id)).harvestNotifiedAt);
});

test('changing the date of a reminded treatment reminds again', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1' });
    const due = await treatment(['A1'], Date.now() - 7 * DAY_MS, 7);
    assert.deepEqual(await harvest.sendHarvestReminders(new Date()), { sent: 1 });

    const res = await request(`/api/treatments/${due._id}`, { method: 'PUT', as: owner, body: { preHarvestDays: 14 } });
    assert.equal(res.status, 200);
    assert.equal((await models.Treatment.findById(due._id)).harvestNotifiedAt, null);
    // A note change keeps it reminded
    await models.Treatment.updateOne({ _id: due._id }, { $set: { harvestNotifiedAt: new Date() } });
    await request(`/api/treatments/${due._id}`, { method: 'PUT', as: owner, body: { note: 'checked' } });
    assert.ok((await models.Treatment.findById(due._id)).harvestNotifiedAt);
});
