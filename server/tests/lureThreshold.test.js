const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, createUser, createCamera, sentMails } = require('./dbHelpers');
const notificationService = require('../src/services/notificationService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const MINUTE = 60 * 1000;
const photo = (deviceSerial, flies, minutesAgo) => models.Snapshot.create({
    deviceSerial, imageUrl: 'x', s3Key: 'x', aiProcessed: true,
    createdAt: new Date(Date.now() - minutesAgo * MINUTE),
    aiResults: { detected: true, summary: { fruit_fly: flies, person: 5 } }
});

test('lure traps alert on the day average, sticky traps on the latest photo', async () => {
    const owner = await createUser({ role: 'manager', language: 'en' });
    await createCamera(owner, { deviceSerial: 'LURE', deviceName: 'Lure', trapKind: 'lure', alertThreshold: 10 });
    await createCamera(owner, { deviceSerial: 'STICK', deviceName: 'Sticky', alertThreshold: 10 });

    // One busy photo among quiet ones: average 4 (people do not count)
    for (const [flies, ago] of [[2, 3], [2, 2], [12, 1]]) await photo('LURE', flies, ago);
    assert.equal(await notificationService.dailyAveragePests('LURE'), 5.3);
    await notificationService.checkPestThreshold('LURE', 12);
    assert.equal(await models.Notification.countDocuments({ type: 'pest_threshold' }), 0, 'no alert from a single busy photo');

    await photo('LURE', 30, 0);
    await notificationService.checkPestThreshold('LURE', 30);
    const alert = await models.Notification.findOne({ type: 'pest_threshold', deviceSerial: 'LURE' }).lean();
    assert.equal(alert.params.basis, 'dailyAverage');
    assert.equal(alert.params.count, 11.5);
    assert.match(sentMails.at(-1).text, /averaged 11\.5 insects per photo today/);

    await notificationService.checkPestThreshold('STICK', 12);
    const sticky = await models.Notification.findOne({ type: 'pest_threshold', deviceSerial: 'STICK' }).lean();
    assert.equal(sticky.params.count, 12);
    assert.equal(sticky.params.basis, undefined);
});
