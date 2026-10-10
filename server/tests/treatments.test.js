const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { dailyCatches, effectOf } = require('../src/services/treatmentService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const dayAgo = (n) => dayKeyOf(Date.now() - n * DAY_MS);

test('daily catch = rise of the card count; a new card restarts it; gaps are unknown', () => {
    const rows = [
        { day: '2026-03-01', peak: 4 },
        { day: '2026-03-02', peak: 10 },
        { day: '2026-03-03', peak: 3 },   // new card
        { day: '2026-03-04', peak: 5 },
        { day: '2026-03-06', peak: 9 }    // 03-05 missing
    ];
    const catches = dailyCatches(rows, new Set(['2026-03-03']), '2026-03-01', '2026-03-06');
    assert.deepEqual([...catches.entries()], [
        ['2026-03-01', null],  // no previous day in range
        ['2026-03-02', 6],
        ['2026-03-03', 3],
        ['2026-03-04', 2],
        ['2026-03-05', null],
        ['2026-03-06', null]   // previous day unknown
    ]);
});

test('effect: catches per day before vs after the treatment', async () => {
    // 6 a day before the spray (cumulative 6, 12, ...), 2 a day after
    const docs = [];
    let count = 0;
    for (let i = 10; i >= 0; i--) {
        count += i > 5 ? 6 : 2;
        docs.push({ deviceSerial: 'CAM1', day: dayAgo(i), scans: 4, total: count, peak: count, min: 0, species: [] });
    }
    await models.DailyStat.insertMany(docs);
    const effect = await effectOf({ at: new Date(Date.now() - 5 * DAY_MS) }, ['CAM1']);
    assert.equal(effect.before, 6);
    assert.equal(effect.after, 2);
    assert.equal(effect.changePct, -67);
    assert.equal(effect.status, 'effective');
    assert.equal(effect.daysAfter, 5);

    const tooEarly = await effectOf({ at: new Date() }, ['CAM1']);
    assert.equal(tooEarly.status, 'pending');
});

async function setup() {
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'CAM1' });
    await createCamera(owner, { deviceSerial: 'CAM2' });
    await createCamera(other, { deviceSerial: 'XCAM' });
    await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'CAM1', email: 'viewer@example.test' } });
    return { owner, viewer, other };
}

const spray = (extra = {}) => ({
    type: 'spray', at: new Date(Date.now() - DAY_MS).toISOString(), cameraSerials: ['CAM1', 'CAM2'],
    product: 'Abamectin 3.6EC', activeIngredient: 'Abamectin', dose: '10 ml / 16 l', preHarvestDays: 7, ...extra
});

test('owners log treatments; viewers read those on cameras they can see', async () => {
    const { owner, viewer, other } = await setup();
    const created = await json(await request('/api/treatments', { method: 'POST', as: owner, body: spray() }));
    assert.equal(created.status, 201);
    assert.ok(new Date(created.body.treatment.harvestAllowedFrom) > new Date(Date.now() + 5 * DAY_MS));

    const seen = await json(await request('/api/treatments', { as: viewer }));
    assert.equal(seen.body.total, 1);
    assert.deepEqual(seen.body.treatments[0].cameraSerials, ['CAM1'], 'only the camera shared with the viewer');
    assert.equal((await json(await request('/api/treatments', { as: other }))).body.total, 0);

    const id = created.body.treatment.id;
    assert.equal((await request(`/api/treatments/${id}`, { method: 'PUT', as: viewer, body: { note: 'x' } })).status, 403);
    assert.equal((await request(`/api/treatments/${id}`, { method: 'DELETE', as: other })).status, 404);
    assert.equal((await request(`/api/treatments/${id}`, { method: 'PUT', as: owner, body: { dose: '12 ml / 16 l' } })).status, 200);
    assert.equal((await request(`/api/treatments/${id}/effect`, { as: viewer })).status, 200);
    // Audit writes are asynchronous
    for (let i = 0; i < 50 && (await models.AuditLog.countDocuments({ category: 'treatment' })) < 2; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual((await models.AuditLog.find({ category: 'treatment' }).sort({ createdAt: 1 }).lean()).map(e => e.action), ['treatment.created', 'treatment.updated']);
});

test('validation', async () => {
    const { owner } = await setup();
    const post = (body) => request('/api/treatments', { method: 'POST', as: owner, body });
    assert.equal((await post(spray({ type: 'magic' }))).status, 400);
    assert.equal((await post(spray({ cameraSerials: [] }))).status, 400);
    assert.equal((await post(spray({ cameraSerials: ['CAM1', 'XCAM'] }))).status, 400, 'someone else\'s camera');
    assert.equal((await post(spray({ at: new Date(Date.now() + 3 * DAY_MS).toISOString() }))).status, 400);
    assert.equal((await post(spray({ product: '' }))).status, 400, 'a spray needs the product');
    assert.equal((await post(spray({ preHarvestDays: 2.5 }))).status, 400);
    assert.equal((await post(spray({ type: 'sanitation', product: '' }))).status, 201);
});

test('list filters by camera, type and date, with an effect summary on request', async () => {
    const { owner } = await setup();
    await request('/api/treatments', { method: 'POST', as: owner, body: spray() });
    await request('/api/treatments', { method: 'POST', as: owner, body: spray({ type: 'bait', cameraSerials: ['CAM2'], at: new Date(Date.now() - 20 * DAY_MS).toISOString() }) });

    assert.equal((await json(await request('/api/treatments?deviceSerial=CAM1', { as: owner }))).body.total, 1);
    assert.equal((await json(await request('/api/treatments?type=bait', { as: owner }))).body.total, 1);
    const recent = await json(await request(`/api/treatments?from=${new Date(Date.now() - 5 * DAY_MS).toISOString()}&effect=1`, { as: owner }));
    assert.equal(recent.body.total, 1);
    assert.equal(recent.body.treatments[0].effect.status, 'pending');
});
