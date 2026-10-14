const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { usageStats } = require('../src/services/usageStatsService');
const { dayKeyOf } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const DAY = 24 * 60 * 60 * 1000;

test('usage: people active, features of the last 30 days and twelve weeks, counts only', async () => {
    const now = new Date();
    const admin = await createUser({ role: 'admin' });
    const grower = await createUser({ role: 'manager' });
    const quiet = await createUser();
    const old = await createUser({ createdAt: new Date(now - 90 * DAY) });
    await createCamera(grower, { deviceSerial: 'U1', status: 1 });
    await createCamera(grower, { deviceSerial: 'U2', status: 0 });

    await models.AuditLog.create([
        { action: 'auth.login', category: 'auth', actorId: grower._id, createdAt: new Date(now - 2 * DAY) },
        { action: 'treatment.created', category: 'treatment', actorId: grower._id, details: { via: 'assistant' }, createdAt: new Date(now - 3 * DAY) },
        { action: 'treatment.created', category: 'treatment', actorId: grower._id, createdAt: new Date(now - 4 * DAY) },
        { action: 'treatment.imported', category: 'treatment', actorId: grower._id, details: { count: 12 }, createdAt: new Date(now - 5 * DAY) },
        { action: 'auth.login', category: 'auth', actorId: old._id, createdAt: new Date(now - 20 * DAY) }
    ]);
    await models.Treatment.create({ cameraSerials: ['U1'], type: 'spray', at: new Date(now - 3 * DAY), product: 'Abc', createdBy: grower._id, createdAt: new Date(now - 3 * DAY) });
    await models.MaintenanceEvent.create({ deviceSerial: 'U1', type: 'card_replaced', at: new Date(now - DAY), userId: grower._id });
    await models.ChatSession.create({ userId: grower._id, sessionId: 's1', messages: [
        { id: 'm1', role: 'user', content: 'private question', at: new Date(now - DAY) },
        { id: 'm2', role: 'assistant', content: 'answer', at: new Date(now - DAY) }
    ] });
    await models.Snapshot.create({ deviceSerial: 'U1', imageUrl: 'u', s3Key: 'k', aiProcessed: true });
    await models.DailyStat.create({ deviceSerial: 'U1', day: dayKeyOf(now - DAY), scans: 24, total: 3, peak: 3, min: 0, species: [] });

    const usage = await usageStats(now);
    assert.deepEqual(usage.people, { users: 4, newUsers30: 3, active7: 1, active30: 2 });
    assert.equal(usage.features30.treatmentsLogged, 1);
    assert.equal(usage.features30.treatmentsByAssistant, 1);
    assert.equal(usage.features30.treatmentsImported, 12);
    assert.equal(usage.features30.cardChanges, 1);
    assert.equal(usage.features30.assistantQuestions, 1);
    assert.equal(usage.features30.assistantUsers, 1);
    assert.deepEqual(usage.cameras, { total: 2, online: 1, photo24h: 1, photos30: 24 });
    assert.equal(usage.weeks.length, 12);
    assert.equal(usage.weeks.at(-1).activeUsers, 1);
    assert.equal(usage.weeks.at(-1).photos, 24);
    assert.ok(!JSON.stringify(usage).includes('private question'), 'no content, counts only');

    const res = await json(await request('/api/admin/usage', { as: admin }));
    assert.equal(res.status, 200);
    assert.equal(res.body.usage.people.users, 4);
    assert.equal((await request('/api/admin/usage', { as: grower })).status, 403);
    assert.equal((await request('/api/admin/usage', { as: quiet })).status, 403);
});
