const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { dailyValues } = require('../src/services/treatmentService');
const { cardDueAt, detectCardChange } = require('../src/services/maintenanceService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const day = (n) => dayKeyOf(Date.now() - n * DAY_MS);
const row = (serial, n, peak, total = peak * 4, scans = 4) => ({ deviceSerial: serial, day: day(n), scans, total, peak, min: 0, species: [{ name: 'fruit_fly', peak, total }] });

test('a day per trap kind: sticky = rise of the card, lure = flies present on average', () => {
    const rows = [{ day: '2026-05-01', peak: 4, total: 10, scans: 4 }, { day: '2026-05-02', peak: 9, total: 30, scans: 5 }];
    const sticky = dailyValues(rows, new Set(), '2026-05-01', '2026-05-02', 'sticky');
    assert.deepEqual([...sticky.values()], [null, 5]);
    const lure = dailyValues(rows, new Set(), '2026-05-01', '2026-05-02', 'lure');
    assert.deepEqual([...lure.values()], [2.5, 6]);
});

test('dashboard: catches today and flies per trap per day, per camera too', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'STK1', deviceName: 'Sticky' });
    await createCamera(owner, { deviceSerial: 'LUR1', deviceName: 'Lure', trapKind: 'lure' });
    await models.DailyStat.insertMany([
        row('STK1', 2, 2), row('STK1', 1, 6), row('STK1', 0, 10),   // +4, +4
        row('LUR1', 1, 5, 12, 4), row('LUR1', 0, 4, 8, 4)          // 3, 2 present on average
    ]);
    const { body } = await json(await request('/api/ai/overview', { as: owner }));
    const c = body.overview.catches;
    assert.equal(c.today, 6, 'sticky +4, lure 2 on average');
    assert.equal(c.yesterday, 7);
    assert.equal(c.last7, 13);
    assert.equal(c.ftd7, 3.3, '13 over 4 trap-days');
    const lure = body.overview.cameraRealtimeList.find(x => x.deviceSerial === 'LUR1');
    assert.equal(lure.trapKind, 'lure');
    assert.equal(lure.today, 2);
    assert.equal(lure.cardDueAt, null, 'no card to replace on a lure trap');
    assert.deepEqual([lure.riskValue, lure.riskBasis], [2, 'dailyAverage'], 'judged by the day average, like its alert');
});

test('analytics insights: per-trap table, hourly activity and catches chart', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'INS1', deviceName: 'A' });
    await models.DailyStat.insertMany([row('INS1', 1, 3), row('INS1', 0, 8)]);
    const start = new Date(Date.now() - 3 * 3600e3);
    await models.Snapshot.insertMany([0, 1, 2].map(i => ({
        deviceSerial: 'INS1', imageUrl: 'x', s3Key: 'x', aiProcessed: true,
        createdAt: new Date(start.getTime() + i * 3600e3), aiResults: { summary: { fruit_fly: [3, 5, 8][i] } }
    })));
    const { body } = await json(await request('/api/ai/insights?days=14', { as: owner }));
    const trap = body.insights.traps[0];
    assert.equal(trap.deviceSerial, 'INS1');
    assert.equal(trap.today, 5);
    assert.equal(trap.onCard, 8);
    assert.equal(trap.daily.length, 14);
    assert.equal(body.insights.activity.byHour.reduce((a, b) => a + b, 0), 5, 'rises of 2 and 3 between photos');
    // Some photos with their stored count, some still without: read together, in time order
    await models.Snapshot.collection.updateMany({ deviceSerial: 'INS1', 'aiResults.summary.fruit_fly': { $in: [3, 8] } }, [{ $set: { pestCount: '$aiResults.summary.fruit_fly' } }]);
    const mixed = await json(await request('/api/ai/insights?days=14', { as: owner }));
    assert.equal(mixed.body.insights.activity.byHour.reduce((a, b) => a + b, 0), 5);

    const chart = await json(await request('/api/ai/statistics?mode=day&metric=catches', { as: owner }));
    assert.equal(chart.body.metric, 'catches');
    assert.deepEqual(chart.body.data.at(-1).insects, [{ label: 'fruit_fly', value: 5 }]);
});

test('trap kind: chosen when adding, validated, and lure traps skip card features', async () => {
    const owner = await createUser({ role: 'manager' });
    const added = await request('/api/user/add-camera', { method: 'POST', as: owner, body: { deviceSerial: 'NEWLURE', validateCode: 'ABCDEF', trapKind: 'lure' } });
    assert.equal(added.status, 200);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'NEWLURE' })).trapKind, 'lure');
    assert.equal((await request('/api/user/add-camera', { method: 'POST', as: owner, body: { deviceSerial: 'BADKIND', validateCode: 'ABCDEF', trapKind: 'net' } })).status, 400);

    const lure = await models.Camera.findOne({ deviceSerial: 'NEWLURE' }).lean();
    assert.equal(cardDueAt({ ...lure, addedAt: new Date(Date.now() - 40 * DAY_MS) }), null);
    // A big drop on a lure trap is flies leaving, not a new card
    await models.Snapshot.create({ deviceSerial: 'NEWLURE', imageUrl: 'x', s3Key: 'x', aiProcessed: true, createdAt: new Date(Date.now() - 3600e3), aiResults: { summary: { fruit_fly: 20 } } });
    const now = await models.Snapshot.create({ deviceSerial: 'NEWLURE', imageUrl: 'x', s3Key: 'x', aiProcessed: true, aiResults: { summary: { fruit_fly: 2 } } });
    assert.equal(await detectCardChange('NEWLURE', now, 2), null);

    const changed = await request('/api/user/camera', { method: 'PUT', as: owner, body: { deviceSerial: 'NEWLURE', trapKind: 'sticky' } });
    assert.equal(changed.status, 200);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'NEWLURE' })).trapKind, 'sticky');
});
