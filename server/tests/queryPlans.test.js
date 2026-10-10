const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb } = require('./dbHelpers');
const { latestProcessedPipeline, latestTimePipeline, latestProcessedByCamera } = require('../src/services/snapshotQueries');

before(async () => {
    await startDb();
    // Enough history per camera that a collection scan would be the obvious (wrong) plan
    const docs = [];
    const now = Date.now();
    for (const serial of ['CAM1', 'CAM2', 'CAM3']) {
        for (let i = 0; i < 300; i++) {
            docs.push({
                deviceSerial: serial,
                imageUrl: 'x',
                s3Key: `snapshots/${serial}/${i}.jpg`,
                createdAt: new Date(now - i * 60000),
                aiProcessed: i % 5 !== 0,
                aiResults: { summary: { fruit_fly: i === 1 ? 7 : 1 } }
            });
        }
    }
    await models.Snapshot.insertMany(docs);
});
after(stopDb);

const planText = async (pipeline) => JSON.stringify(await models.Snapshot.aggregate(pipeline).explain());

test('latest snapshot per camera uses DISTINCT_SCAN, not a scan of every snapshot', async () => {
    const processed = await planText(latestProcessedPipeline(['CAM1', 'CAM2', 'CAM3']));
    assert.match(processed, /DISTINCT_SCAN/);
    assert.doesNotMatch(processed, /COLLSCAN/);

    const anyState = await planText(latestTimePipeline(['CAM1', 'CAM2', 'CAM3']));
    assert.match(anyState, /DISTINCT_SCAN/);
});

test('latest processed snapshot is the newest one with AI results', async () => {
    const latest = await latestProcessedByCamera(['CAM1', 'CAM2']);
    // i = 0 is unprocessed, so i = 1 (fruit_fly 7) is the newest processed one
    assert.equal(latest.get('CAM1').summary.fruit_fly, 7);
    assert.equal(latest.size, 2);
});
