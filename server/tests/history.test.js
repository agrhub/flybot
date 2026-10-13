const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const HOUR = 60 * 60 * 1000;
const photo = (deviceSerial, summary, hoursAgo, review) => models.Snapshot.create({
    deviceSerial,
    imageUrl: 'x',
    s3Key: `snapshots/${deviceSerial}/${deviceSerial}_${hoursAgo}.jpg`,
    createdAt: new Date(Date.now() - hoursAgo * HOUR),
    aiProcessed: true,
    aiResults: { detected: true, summary },
    ...(review ? { review: { status: review } } : {})
});

test('history: several cameras, alarm status from each camera threshold, review filter', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1', deviceName: 'Plot A', alertThreshold: 10 });
    await createCamera(owner, { deviceSerial: 'B1', deviceName: 'Plot B', alertThreshold: 30 });
    await createCamera(other, { deviceSerial: 'X1' });
    await photo('A1', { fruit_fly: 12 }, 1);                 // alarm (12 >= 10)
    await photo('A1', { fruit_fly: 4, person: 9 }, 2, 'confirmed'); // moderate: people do not count
    await photo('B1', { fruit_fly: 12 }, 3);                 // moderate for B1 (threshold 30)
    await photo('X1', { fruit_fly: 50 }, 1);

    const all = await json(await request('/api/ai/results?limit=50', { as: owner }));
    assert.equal(all.body.total, 3, 'only my cameras');
    assert.deepEqual(all.body.results.map(r => [r.deviceName, r.pestCount, r.threshold, r.risk]), [
        ['Plot A', 12, 10, 'high'], ['Plot A', 4, 10, 'moderate'], ['Plot B', 12, 30, 'moderate']
    ]);

    const alarms = await json(await request('/api/ai/results?risk=high', { as: owner }));
    assert.deepEqual(alarms.body.results.map(r => r.deviceSerial), ['A1']);
    const moderate = await json(await request('/api/ai/results?risk=moderate&deviceSerials=A1,B1', { as: owner }));
    assert.equal(moderate.body.total, 2);
    const reviewed = await json(await request('/api/ai/results?review=confirmed', { as: owner }));
    assert.equal(reviewed.body.total, 1);
    const unreviewed = await json(await request('/api/ai/results?review=none&deviceSerials=A1', { as: owner }));
    assert.equal(unreviewed.body.total, 1);
    assert.equal((await request('/api/ai/results?deviceSerials=A1,X1', { as: owner })).status, 403);
});
