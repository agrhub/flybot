const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const dailyStats = require('../src/services/dailyStats');
const { removeSnapshots } = require('../scripts/remove_snapshots');

before(startDb);
after(stopDb);
beforeEach(clearDb);

/** A fake S3 client: records every command; `fail` makes one command name throw. */
function fakeS3(fail = null) {
    const calls = [];
    return {
        calls,
        async send(command) {
            const name = command.constructor.name;
            calls.push({ name, input: command.input });
            if (name === fail) throw Object.assign(new Error('boom'), { name: 'AccessDenied' });
            return {};
        }
    };
}

// Local days in Asia/Ho_Chi_Minh (UTC+7): 2026-10-17 07:00 is 2026-10-17 00:00 UTC
async function scan(serial, iso, flies) {
    const doc = await models.Snapshot.create({
        deviceSerial: serial, imageUrl: 'x', s3Key: `snapshots/${serial}/${iso}.jpg`, createdAt: new Date(iso),
        aiProcessed: true, aiResults: { detected: true, summary: { fruit_fly: flies } }
    });
    await dailyStats.refreshForSnapshot(doc);
    return doc;
}

async function setup() {
    const owner = await createUser();
    await createCamera(owner, { deviceSerial: 'TRAP1' });
    await scan('TRAP1', '2026-10-16T16:30:00Z', 1);   // 16 Oct 23:30 local: kept
    await scan('TRAP1', '2026-10-16T17:30:00Z', 300); // 17 Oct 00:30 local: removed
    await scan('TRAP1', '2026-10-20T05:00:00Z', 200); // removed
    await scan('TRAP1', '2026-10-26T16:30:00Z', 50);  // 26 Oct 23:30 local: removed
    await scan('TRAP1', '2026-10-26T17:30:00Z', 2);   // 27 Oct 00:30 local: kept
    await scan('OTHER', '2026-10-20T05:00:00Z', 9);   // another camera: kept
    await models.Notification.create({ userId: owner._id, type: 'pest_threshold', deviceSerial: 'TRAP1', createdAt: new Date('2026-10-20T06:00:00Z') });
    await models.Notification.create({ userId: owner._id, type: 'camera_offline', deviceSerial: 'TRAP1', createdAt: new Date('2026-10-20T06:00:00Z') });
    await models.MaintenanceEvent.create({ deviceSerial: 'TRAP1', type: 'card_replaced', source: 'detected', at: new Date('2026-10-21T03:00:00Z') });
    await models.MaintenanceEvent.create({ deviceSerial: 'TRAP1', type: 'card_replaced', source: 'manual', at: new Date('2026-10-15T03:00:00Z') });
    await models.Camera.updateOne({ deviceSerial: 'TRAP1' }, { $set: { cardReplacedAt: new Date('2026-10-21T03:00:00Z') } });
}

test('remove_snapshots: the preview counts the local days and changes nothing', async () => {
    await setup();
    const s3 = fakeS3();
    const r = await removeSnapshots({ serial: 'TRAP1', from: '2026-10-17', to: '2026-10-26', s3, bucket: 'b' });
    assert.equal(r.photos, 3);
    assert.equal(r.pests, 550);
    assert.equal(r.notifications, 1, 'count alerts only');
    assert.equal(r.detectedEvents, 1, 'detected card changes only');
    assert.deepEqual(Object.keys(r.byDay).sort(), ['2026-10-17', '2026-10-20', '2026-10-26']);
    assert.equal(s3.calls.length, 0);
    assert.equal(await models.Snapshot.countDocuments(), 6);
    await assert.rejects(removeSnapshots({ serial: 'TRAP1', from: '2026-10-26', to: '2026-10-17', s3 }), /usage/);
});

test('remove_snapshots --apply: backup first, then photos, alerts, detected card changes and their day statistics', async () => {
    await setup();
    const s3 = fakeS3();
    const r = await removeSnapshots({ serial: 'TRAP1', from: '2026-10-17', to: '2026-10-26', apply: true, s3, bucket: 'b', now: new Date('2026-10-29T08:00:00Z') });
    const names = s3.calls.map(c => c.name);
    assert.deepEqual(names, ['PutObjectCommand', 'CopyObjectCommand', 'CopyObjectCommand', 'CopyObjectCommand', 'DeleteObjectsCommand']);
    const backup = JSON.parse(s3.calls[0].input.Body);
    assert.equal(backup.snapshots.length, 3);
    assert.equal(backup.notifications.length, 1);
    assert.equal(backup.maintenanceEvents.length, 1);
    assert.match(s3.calls[0].input.Key, /^backup\/TRAP1-2026-10-17-2026-10-26-2026-10-29T08-00-00-000Z\/records\.json$/);
    assert.equal(s3.calls[1].input.CopySource, 'b/snapshots/TRAP1/2026-10-16T17%3A30%3A00Z.jpg');
    assert.equal(s3.calls[4].input.Delete.Objects.length, 3);
    assert.deepEqual(r.deleted, { photos: 3, notifications: 1, detectedEvents: 1 });

    assert.equal(await models.Snapshot.countDocuments({ deviceSerial: 'TRAP1' }), 2);
    assert.equal(await models.Snapshot.countDocuments({ deviceSerial: 'OTHER' }), 1);
    assert.equal(await models.Notification.countDocuments(), 1);
    assert.equal(await models.MaintenanceEvent.countDocuments(), 1);
    const cam = await models.Camera.findOne({ deviceSerial: 'TRAP1' }).lean();
    assert.equal(cam.cardReplacedAt.toISOString(), '2026-10-15T03:00:00.000Z', 'back to the manual card change');
    const days = (await models.DailyStat.find({ deviceSerial: 'TRAP1' }).lean()).map(d => d.day).sort();
    assert.deepEqual(days, ['2026-10-16', '2026-10-27']);
});

test('remove_snapshots --apply: a failed photo copy stops before anything is deleted', async () => {
    await setup();
    const s3 = fakeS3('CopyObjectCommand');
    await assert.rejects(removeSnapshots({ serial: 'TRAP1', from: '2026-10-17', to: '2026-10-26', apply: true, s3, bucket: 'b' }), /boom/);
    assert.ok(!s3.calls.some(c => c.name === 'DeleteObjectsCommand'));
    assert.equal(await models.Snapshot.countDocuments({ deviceSerial: 'TRAP1' }), 5);
    assert.equal(await models.Notification.countDocuments(), 2);
});
