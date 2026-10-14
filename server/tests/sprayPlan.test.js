const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { suggest, planFor } = require('../src/services/sprayPlanService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-14T03:00:00Z'); // 10:00 farm time
const today = '2026-10-14';
const daysAgo = (n) => new Date(now.getTime() - n * DAY);
const dry = { level: 'low', days: [{ day: '2026-10-15', rain: 0 }, { day: '2026-10-16', rain: 2 }, { day: '2026-10-17', rain: 0 }] };

test('rules: traps at threshold are treated now, unless treated this week', () => {
    assert.deepEqual(suggest({ atThreshold: 2, lastTreatment: { at: daysAgo(10) }, sprays: [], wave: null, outlook: dry, today, now }),
        { action: 'treat_now', date: today, waitUntil: null, rainMoved: false, rotateFrom: null });
    const recent = suggest({ atThreshold: 2, lastTreatment: { at: daysAgo(3) }, sprays: [], wave: null, outlook: dry, today, now });
    assert.equal(recent.action, 'wait_check');
    assert.equal(recent.waitUntil, '2026-10-18');
});

test('rules: bait a few days before the next generation, never on a very wet day', () => {
    const wave = { date: '2026-10-21', inDays: 7 };
    assert.equal(suggest({ atThreshold: 0, sprays: [], wave, outlook: dry, today, now }).date, '2026-10-18');
    const soon = suggest({ atThreshold: 0, sprays: [], wave: { date: '2026-10-16', inDays: 2 }, outlook: { level: 'low', days: [{ day: '2026-10-14', rain: 30 }, { day: '2026-10-15', rain: 12 }] }, today, now });
    assert.deepEqual([soon.action, soon.date, soon.rainMoved], ['bait_before_wave', '2026-10-16', true]);
    assert.equal(suggest({ atThreshold: 0, sprays: [], wave: { date: '2026-11-20', inDays: 37 }, outlook: dry, today, now }).action, 'monitor');
});

test('rules: weather that favors flies means sanitation; the same ingredient twice means change it', () => {
    assert.equal(suggest({ atThreshold: 0, sprays: [], wave: null, outlook: { level: 'elevated', days: [] }, today, now }).action, 'sanitation');
    const sprays = [{ activeIngredient: 'Spinetoram' }, { activeIngredient: 'spinetoram ' }];
    assert.equal(suggest({ atThreshold: 1, lastTreatment: { at: daysAgo(9) }, sprays, wave: null, outlook: dry, today, now }).rotateFrom, 'Spinetoram');
    assert.equal(suggest({ atThreshold: 1, lastTreatment: { at: daysAgo(9) }, sprays: [sprays[0], { activeIngredient: 'Abamectin' }], wave: null, outlook: dry, today, now }).rotateFrom, null);
});

test('the plan: one row per plot the user sees, the most urgent first', async () => {
    const me = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    const farm = await models.Farm.create({ ownerId: me._id, name: 'Hoa Loc' });
    const busy = await models.Plot.create({ farmId: farm._id, name: 'Mango A' });
    const calm = await models.Plot.create({ farmId: farm._id, name: 'Pomelo B' });
    await createCamera(me, { deviceSerial: 'A1', farmId: farm._id, plotId: busy._id, alertThreshold: 15 });
    await createCamera(me, { deviceSerial: 'B1', farmId: farm._id, plotId: calm._id, alertThreshold: 15 });
    const theirs = await models.Farm.create({ ownerId: other._id, name: 'Not mine' });
    await createCamera(other, { deviceSerial: 'X1', farmId: theirs._id, alertThreshold: 1 });
    await models.Snapshot.create([
        { deviceSerial: 'A1', imageUrl: 'u', s3Key: 'a', aiProcessed: true, createdAt: new Date(), aiResults: { summary: { fruit_fly: 25 } } },
        { deviceSerial: 'B1', imageUrl: 'u', s3Key: 'b', aiProcessed: true, createdAt: new Date(), aiResults: { summary: { fruit_fly: 2 } } },
        { deviceSerial: 'X1', imageUrl: 'u', s3Key: 'x', aiProcessed: true, createdAt: new Date(), aiResults: { summary: { fruit_fly: 9 } } }
    ]);
    await models.Treatment.create([
        { cameraSerials: ['A1'], type: 'spray', at: new Date(Date.now() - 20 * DAY), product: 'Radiant 60SC', activeIngredient: 'Spinetoram', createdBy: me._id },
        { cameraSerials: ['A1'], type: 'spray', at: new Date(Date.now() - 12 * DAY), product: 'Success', activeIngredient: 'Spinetoram', createdBy: me._id }
    ]);

    const plan = await planFor(me);
    assert.deepEqual(plan.items.map(i => [i.plot, i.action]), [['Mango A', 'treat_now'], ['Pomelo B', 'monitor']]);
    assert.equal(plan.items[0].rotateFrom, 'Spinetoram');
    assert.equal(plan.items[0].lastTreatment.product, 'Success');

    const api = await json(await request('/api/farms/plan', { as: me }));
    assert.equal(api.status, 200);
    assert.equal(api.body.items.length, 2, "never another user's farm");
    assert.equal((await request('/api/farms/plan')).status, 401);
});
