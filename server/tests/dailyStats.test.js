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

test('retention cleanup removes old photos and their files, keeps daily statistics for two years', async () => {
    const { s3Client } = require('../src/config/s3');
    const original = s3Client.send;
    const deleted = [];
    s3Client.send = async (command) => {
        deleted.push(...command.input.Delete.Objects.map(o => o.Key));
        return {};
    };
    try {
        await scan('CAM1', { fruit_fly: 1 }, HOUR);
        const old = await scan('CAM1', { fruit_fly: 1 }, 400 * DAY);
        await scan('CAM1', { fruit_fly: 1 }, 800 * DAY);
        assert.equal(await models.DailyStat.countDocuments(), 3);
        const result = await cleanupOldData({ pauseMs: 0 });
        assert.equal(result.photos, 2);
        assert.equal(await models.Snapshot.countDocuments(), 1);
        assert.ok(deleted.includes(old.s3Key));
        // Photo retention is 3 months; the 400-day-old statistics stay for long reports
        assert.equal(await models.DailyStat.countDocuments(), 2);
    } finally {
        s3Client.send = original;
    }
});

test('retention cleanup keeps photos whose file S3 could not delete, and runs in bounded passes', async () => {
    const { s3Client } = require('../src/config/s3');
    const original = s3Client.send;
    const docs = [];
    for (let i = 0; i < 4; i++) docs.push(await scan('CAM1', { fruit_fly: 1 }, (200 + i) * DAY));
    // Waiting for the training upload: never removed by the cleanup
    await models.Snapshot.updateOne({ _id: docs[3]._id }, { $set: { 'trainingSync.status': 'pending' } });
    s3Client.send = async () => ({
        Errors: [
            { Key: docs[0].s3Key, Code: 'AccessDenied', Message: 'Access Denied' },
            { Key: docs[1].s3Key, Code: 'NoSuchKey', Message: 'already gone' }
        ]
    });
    try {
        const result = await cleanupOldData({ pauseMs: 0 });
        assert.deepEqual({ photos: result.photos, failed: result.failed }, { photos: 2, failed: 1 });
        const left = (await models.Snapshot.find().select('_id').lean()).map(d => String(d._id)).sort();
        assert.deepEqual(left, [docs[0]._id, docs[3]._id].map(String).sort(), 'the refused file and the pending upload stay');

        // A quota per run: the rest waits for the next run
        for (let i = 0; i < 3; i++) await scan('CAM2', { fruit_fly: 1 }, (300 + i) * DAY);
        s3Client.send = async () => ({});
        const capped = await cleanupOldData({ pauseMs: 0, maxPerRun: 1 });
        assert.equal(capped.more, true);
    } finally {
        s3Client.send = original;
    }
});

test('backfill runs only when the rollup has never been built', async () => {
    await models.Snapshot.create({ deviceSerial: 'CAM1', imageUrl: 'x', s3Key: 'k', aiProcessed: true, aiResults: { summary: { fruit_fly: 2 } } });
    await dailyStats.backfillIfEmpty();
    assert.equal(await models.DailyStat.countDocuments(), 1);
    await models.DailyStat.updateOne({}, { $set: { peak: 999 } });
    await dailyStats.backfillIfEmpty();
    assert.equal((await models.DailyStat.findOne().lean()).peak, 999, 'an existing rollup is left alone');
});

test('photo count from the rollup: every day of the given cameras, no others', async () => {
    await models.DailyStat.insertMany([
        { deviceSerial: 'A', day: '2026-01-01', scans: 24, total: 0, peak: 0, min: 0, species: [] },
        { deviceSerial: 'A', day: '2026-06-01', scans: 20, total: 0, peak: 0, min: 0, species: [] },
        { deviceSerial: 'B', day: '2026-06-01', scans: 5, total: 0, peak: 0, min: 0, species: [] },
        { deviceSerial: 'C', day: '2026-06-01', scans: 99, total: 0, peak: 0, min: 0, species: [] }
    ]);
    assert.equal(await dailyStats.scanCount(['A', 'B']), 49);
    assert.equal(await dailyStats.scanCount([]), 0);
});
