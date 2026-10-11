const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const { allExecutors } = require('../src/agent/tools');
const dailyStats = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const MIN = 60 * 1000;
const asUser = (u) => ({ userId: String(u._id), user: { id: String(u._id), role: u.role }, addAction: () => {} });
async function photo(serial, minutesAgo, summary) {
    const doc = await models.Snapshot.create({
        deviceSerial: serial, imageUrl: 'x', s3Key: `k-${serial}-${minutesAgo}`, aiProcessed: true,
        createdAt: new Date(Date.now() - minutesAgo * MIN), aiResults: { summary }
    });
    await dailyStats.refreshForSnapshot(doc);
    return doc;
}

test('recent photos give the pests on the trap as a number, people left out', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AGT1' });
    await photo('AGT1', 5, { fruit_fly: 7, person: 2 });
    const res = await allExecutors.get_recent_snapshots({ ...asUser(owner) });
    assert.equal(res.snapshots[0].pestsOnTrap, 7);
    assert.deepEqual(res.snapshots[0].bySpecies, { fruit_fly: 7, person: 2 });
});

test('hourly statistics are catches (the rise on the card), not the running count', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'AGT2' });
    await photo('AGT2', 180, { fruit_fly: 3, person: 4 });
    await photo('AGT2', 120, { fruit_fly: 5, person: 1 });
    await photo('AGT2', 60, { fruit_fly: 8 });
    const res = await allExecutors.get_insect_statistics({ ...asUser(owner), mode: 'hour' });
    assert.equal(res.records.length, 24);
    assert.equal(res.records.reduce((sum, r) => sum + r.caught, 0), 5, 'rises of 2 and 3');
    const day = await allExecutors.get_insect_statistics({ ...asUser(owner), mode: 'day' });
    assert.ok(day.records.every(r => r.insects.every(i => i.label !== 'person')));
});

test('catch summary judges a lure trap by today\'s average, a sticky trap by its latest photo', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'LURE1', alertThreshold: 10, trapKind: 'lure' });
    await createCamera(owner, { deviceSerial: 'STK1', alertThreshold: 10, trapKind: 'sticky' });
    await photo('LURE1', 3, { fruit_fly: 2 });
    await photo('LURE1', 2, { fruit_fly: 2 });
    await photo('LURE1', 1, { fruit_fly: 14 }); // one crowded photo
    await photo('STK1', 1, { fruit_fly: 12 });
    const { traps } = await allExecutors.get_catch_summary({ ...asUser(owner) });
    const lure = traps.find(t => t.serial === 'LURE1');
    const sticky = traps.find(t => t.serial === 'STK1');
    assert.equal(lure.judgedValue, 6);
    assert.equal(lure.onTrapInLatestPhoto, 14);
    assert.notEqual(lure.risk, 'high');
    assert.equal(lure.cardAgeDays, null);
    assert.equal(sticky.judgedValue, 12);
    assert.equal(sticky.risk, 'high');
});
