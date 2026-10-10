const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const maintenanceService = require('../src/services/maintenanceService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function setup() {
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test' });
    await createCamera(owner, { deviceSerial: 'CAM1', deviceName: 'Plot A' });
    await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'CAM1', email: 'viewer@example.test' } });
    return { owner, viewer };
}

const add = (as, body) => request('/api/user/camera/maintenance', { method: 'POST', as, body: { deviceSerial: 'CAM1', ...body } });

test('owners record field work; people it is shared with can read it', async () => {
    const { owner, viewer } = await setup();
    const res = await json(await add(owner, { type: 'card_replaced', note: 'Yellow card #12' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.event.by, 'owner@example.test');
    await add(owner, { type: 'lure_replaced', at: new Date(Date.now() - 2 * DAY).toISOString() });

    const camera = await models.Camera.findOne({ deviceSerial: 'CAM1' });
    assert.ok(camera.cardReplacedAt > new Date(Date.now() - HOUR));

    const list = await json(await request('/api/user/camera/maintenance?deviceSerial=CAM1', { as: viewer }));
    assert.deepEqual(list.body.events.map(e => e.type), ['card_replaced', 'lure_replaced']);
    assert.equal(list.body.card.reminderDays, 7);
    assert.ok(new Date(list.body.card.dueAt) > new Date(Date.now() + 6 * DAY));

    // Viewers only read
    assert.equal((await add(viewer, { type: 'card_replaced' })).status, 404);
    assert.equal((await request(`/api/user/camera/maintenance/${res.body.event.id}`, { method: 'DELETE', as: viewer })).status, 404);
});

test('input validation', async () => {
    const { owner } = await setup();
    assert.equal((await add(owner, { type: 'painted_fence' })).status, 400);
    assert.equal((await add(owner, { type: 'other', at: new Date(Date.now() + DAY).toISOString() })).status, 400);
    assert.equal((await add(owner, { type: 'other', at: new Date(Date.now() - 200 * DAY).toISOString() })).status, 400);
    assert.equal((await add(owner, { type: 'other', note: 'x'.repeat(301) })).status, 400);
    const bad = await request('/api/user/camera', { method: 'PUT', as: owner, body: { deviceSerial: 'CAM1', cardReminderDays: 4 } });
    assert.equal(bad.status, 400);
    const ok = await request('/api/user/camera', { method: 'PUT', as: owner, body: { deviceSerial: 'CAM1', cardReminderDays: 14 } });
    assert.equal(ok.status, 200);
});

async function processedScan(count, msAgo) {
    return models.Snapshot.create({
        deviceSerial: 'CAM1', imageUrl: 'x', s3Key: `snapshots/CAM1/${msAgo}.jpg`,
        createdAt: new Date(Date.now() - msAgo), aiProcessed: true, aiResults: { summary: { fruit_fly: count, person: 4 } }
    });
}

test('a sharp drop is recorded as a likely card change, once', async () => {
    const { owner, viewer } = await setup();
    await processedScan(20, 2 * HOUR);
    const fresh = await processedScan(3, HOUR);
    const detected = await maintenanceService.detectCardChange('CAM1', fresh, 3);
    assert.equal(detected.source, 'detected');
    assert.equal(detected.note, '20 → 3');
    assert.equal(await models.Notification.countDocuments({ type: 'card_change_detected' }), 2, 'owner and viewer');

    // The next scan of the same new card is not another change
    const next = await processedScan(1, 30 * 60 * 1000);
    assert.equal(await maintenanceService.detectCardChange('CAM1', next, 1), null);

    // A wrong detection can be deleted, and the card date follows
    await request(`/api/user/camera/maintenance/${detected._id}`, { method: 'DELETE', as: owner });
    assert.equal((await models.Camera.findOne({ deviceSerial: 'CAM1' })).cardReplacedAt, null);
    void viewer;
});

test('small counts or gentle drops are not a card change', async () => {
    await setup();
    await processedScan(5, 3 * HOUR);
    const low = await processedScan(0, 2 * HOUR);
    assert.equal(await maintenanceService.detectCardChange('CAM1', low, 0), null, 'previous card was nearly empty');
    await processedScan(20, HOUR);
    const half = await processedScan(10, 30 * 60 * 1000);
    assert.equal(await maintenanceService.detectCardChange('CAM1', half, 10), null, 'half is not a new card');
});

test('daily reminder when a card is due, at most once a day, never when turned off', async () => {
    const { owner } = await setup();
    await models.Camera.updateOne({ deviceSerial: 'CAM1' }, { $set: { cardReplacedAt: new Date(Date.now() - 8 * DAY) } });
    assert.equal(await maintenanceService.sendCardReminders(), 2);
    assert.equal(await maintenanceService.sendCardReminders(), 0, 'cooldown');
    const reminder = await models.Notification.findOne({ type: 'card_due', userId: owner._id }).lean();
    assert.equal(reminder.params.days, 8);

    await models.Notification.deleteMany({});
    await models.Camera.updateOne({ deviceSerial: 'CAM1' }, { $set: { cardReminderDays: 0 } });
    assert.equal(await maintenanceService.sendCardReminders(), 0);
});
