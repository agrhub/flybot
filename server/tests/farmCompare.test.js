const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const dayAgo = (n) => dayKeyOf(Date.now() - n * DAY_MS);

// A sticky trap catching `before` flies a day the week before last, then `after` a day the last 7 days
async function catches(serial, before, after) {
    const docs = [];
    let count = 0;
    for (let i = 15; i >= 0; i--) {
        count += i > 6 ? before : after;
        docs.push({ deviceSerial: serial, day: dayAgo(i), scans: 4, total: count, peak: count, min: 0, species: [] });
    }
    await models.DailyStat.insertMany(docs);
}

test('farms side by side: flies per trap per day, the change, the worst plot and treatments', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    const viewer = await createUser({ email: 'viewer@example.test' });
    const mango = await models.Farm.create({ ownerId: owner._id, name: 'Mango farm' });
    const pomelo = await models.Farm.create({ ownerId: owner._id, name: 'Pomelo farm' });
    await models.Farm.create({ ownerId: owner._id, name: 'Empty farm' });
    const theirs = await models.Farm.create({ ownerId: other._id, name: 'Not yours' });
    const plotA = await models.Plot.create({ farmId: mango._id, name: 'Plot A' });
    const plotB = await models.Plot.create({ farmId: mango._id, name: 'Plot B' });
    const plotP = await models.Plot.create({ farmId: pomelo._id, name: 'Plot P' });
    await createCamera(owner, { deviceSerial: 'M1', farmId: mango._id, plotId: plotA._id });
    await createCamera(owner, { deviceSerial: 'M2', farmId: mango._id, plotId: plotB._id });
    await createCamera(owner, { deviceSerial: 'P1', farmId: pomelo._id, plotId: plotP._id });
    await createCamera(other, { deviceSerial: 'X1', farmId: theirs._id });
    await catches('M1', 4, 10);   // rising
    await catches('M2', 4, 2);
    await catches('P1', 6, 3);    // falling
    await catches('X1', 50, 50);
    await models.Treatment.create({ cameraSerials: ['P1'], type: 'spray', at: new Date(Date.now() - 3 * DAY_MS), product: 'Radiant' });
    await models.Treatment.create({ cameraSerials: ['P1'], type: 'spray', at: new Date(Date.now() - 30 * DAY_MS), product: 'Old' });

    const res = await json(await request('/api/farms/compare?days=7', { as: owner }));
    assert.equal(res.status, 200);
    assert.equal(res.body.period, 7);
    assert.deepEqual(res.body.farms.map(f => f.name), ['Mango farm', 'Pomelo farm', 'Empty farm'], 'most flies per trap first, farms without traps last');
    const [mangoRow, pomeloRow, emptyRow] = res.body.farms;
    assert.equal(mangoRow.traps, 2);
    assert.equal(mangoRow.ftd, 6);              // (10 + 2) / 2
    assert.equal(mangoRow.previousFtd, 4);
    assert.equal(mangoRow.changePct, 50);
    assert.equal(mangoRow.series.length, 7);
    assert.deepEqual(mangoRow.worstPlot, { id: String(plotA._id), name: 'Plot A', traps: 1, ftd: 10, changePct: 150 });
    assert.deepEqual(mangoRow.plots.map(p => p.name), ['Plot A', 'Plot B']);
    assert.equal(pomeloRow.ftd, 3);
    assert.equal(pomeloRow.changePct, -50);
    assert.equal(pomeloRow.treatments, 1, 'only treatments in the period');
    assert.equal(emptyRow.traps, 0);
    assert.equal(emptyRow.ftd, null);

    // A farm shared with someone: they see it, and only through the cameras they can see
    await request(`/api/farms/${pomelo._id}/share`, { method: 'POST', as: owner, body: { email: viewer.email } });
    const shared = await json(await request('/api/farms/compare?days=30', { as: viewer }));
    assert.deepEqual(shared.body.farms.map(f => f.name), ['Pomelo farm']);
    assert.equal(shared.body.period, 30);
    // Anything else falls back to 30 days
    assert.equal((await json(await request('/api/farms/compare?days=12', { as: owner }))).body.period, 30);
});
