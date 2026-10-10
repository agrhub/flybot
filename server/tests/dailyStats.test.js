const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const dailyStats = require('../src/services/dailyStats');
const { cleanupOldData } = require('../src/services/s3Service');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function scan(deviceSerial, summary, msAgo, { processed = true } = {}) {
    const doc = await models.Snapshot.create({
        deviceSerial,
        imageUrl: 'x',
        s3Key: `snapshots/${deviceSerial}/${Date.now() - msAgo}.jpg`,
        createdAt: new Date(Date.now() - msAgo),
        aiProcessed: processed,
        aiResults: processed ? { detected: true, summary } : undefined
    });
    await dailyStats.refreshForSnapshot(doc);
    return doc;
}

const strip = ({ deviceSerial, day, scans, total, peak, min, species }) => ({ deviceSerial, day, scans, total, peak, min, species });

test('one row per camera and local day, pests only, aliases merged', async () => {
    await scan('CAM1', { fruit_fly: 3, person: 9 }, 2 * 60 * 1000);
    await scan('CAM1', { 'ruồi vàng': 5, moth: 1 }, 60 * 1000);
    await scan('CAM1', { fruit_fly: 99 }, 30 * 1000, { processed: false });
    await scan('CAM1', { fruit_fly: 2 }, 3 * DAY);

    const today = dailyStats.dayKeyOf(Date.now() - 60 * 1000);
    const row = await models.DailyStat.findOne({ deviceSerial: 'CAM1', day: today }).lean();
    assert.equal(row.scans, 2, 'unprocessed scans are not counted');
    assert.equal(row.total, 9, '3 + (5 + 1); people are not pests');
    assert.equal(row.peak, 6);
    assert.equal(row.min, 3);
    assert.deepEqual(row.species.map(s => [s.name, s.peak, s.total]), [['fruit_fly', 5, 8], ['moth', 1, 1]]);
    assert.equal(await models.DailyStat.countDocuments(), 2);
});

test('a full rebuild gives the same rows as incremental updates', async () => {
    await scan('CAM1', { fruit_fly: 4 }, HOUR);
    await scan('CAM1', { fruit_fly: 7, moth: 2 }, 2 * HOUR);
    await scan('CAM2', { thrips: 3 }, DAY + HOUR);
    const incremental = (await models.DailyStat.find().sort({ deviceSerial: 1, day: 1 }).lean()).map(strip);

    await models.DailyStat.deleteMany({});
    const result = await dailyStats.rebuildAll({ log: () => {} });
    assert.equal(result.cameras, 2);
    const rebuilt = (await models.DailyStat.find().sort({ deviceSerial: 1, day: 1 }).lean()).map(strip);
    assert.deepEqual(rebuilt, incremental);
});

test('a human correction updates the day', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'CAM1' });
    const snap = await scan('CAM1', { fruit_fly: 30 }, HOUR);

    const res = await request(`/api/ai/snapshots/${snap._id}/review`, {
        method: 'PUT', as: owner, body: { status: 'corrected', summary: { fruit_fly: 4 } }
    });
    assert.equal(res.status, 200);
    const row = await models.DailyStat.findOne({ deviceSerial: 'CAM1' }).lean();
    assert.equal(row.peak, 4);
});

test('Statistics (day mode) reads the rollup: per-camera daily peaks summed over cameras', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'CAM1' });
    await createCamera(owner, { deviceSerial: 'CAM2' });
    await scan('CAM1', { fruit_fly: 3 }, 2 * 60 * 1000);
    await scan('CAM1', { fruit_fly: 8 }, 60 * 1000);
    await scan('CAM2', { fruit_fly: 5 }, 60 * 1000);

    const { body } = await json(await request('/api/ai/statistics?mode=day', { as: owner }));
    const today = body.data.find(p => p.dateKey === dailyStats.dayKeyOf(Date.now() - 60 * 1000));
    assert.deepEqual(today.insects, [{ label: 'fruit_fly', value: 13 }], 'CAM1 peak 8 + CAM2 peak 5');

    const month = await json(await request('/api/ai/statistics?mode=month', { as: owner }));
    assert.equal(month.body.data.at(-1).insects[0].value, 13);
});

test('retention cleanup removes old days with their snapshots', async () => {
    await scan('CAM1', { fruit_fly: 1 }, HOUR);
    await scan('CAM1', { fruit_fly: 1 }, 400 * DAY);
    assert.equal(await models.DailyStat.countDocuments(), 2);
    await cleanupOldData();
    assert.equal(await models.DailyStat.countDocuments(), 1);
    assert.equal(await models.Snapshot.countDocuments(), 1);
});

test('backfill runs only when the rollup has never been built', async () => {
    await models.Snapshot.create({ deviceSerial: 'CAM1', imageUrl: 'x', s3Key: 'k', aiProcessed: true, aiResults: { summary: { fruit_fly: 2 } } });
    await dailyStats.backfillIfEmpty();
    assert.equal(await models.DailyStat.countDocuments(), 1);
    await models.DailyStat.updateOne({}, { $set: { peak: 999 } });
    await dailyStats.backfillIfEmpty();
    assert.equal((await models.DailyStat.findOne().lean()).peak, 999, 'an existing rollup is left alone');
});
