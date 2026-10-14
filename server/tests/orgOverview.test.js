const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const orgService = require('../src/services/orgService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const dayAgo = (n) => dayKeyOf(Date.now() - n * DAY_MS);

// Daily rows where the card gains `perDay` flies a day
async function dailyRise(serial, perDay, days = 14) {
    const docs = [];
    let count = 0;
    for (let i = days; i >= 0; i--) {
        count += perDay;
        docs.push({ deviceSerial: serial, day: dayAgo(i), scans: 4, total: count, peak: count, min: 0, species: [] });
    }
    await models.DailyStat.insertMany(docs);
}

async function seed() {
    const lead = await createUser({ role: 'manager', name: 'Lan', email: 'lan@example.test' });
    const busy = await createUser({ name: 'Ba', email: 'ba@example.test' });
    const calm = await createUser({ name: 'Tu', email: 'tu@example.test' });
    const outsider = await createUser({ role: 'manager' });
    const org = await models.Organization.create({
        name: 'Hoa Loc cooperative',
        members: [
            { userId: lead._id, email: lead.email, role: 'owner' },
            { userId: busy._id, email: busy.email, role: 'member' },
            { userId: calm._id, email: calm.email, role: 'member' },
            { email: 'later@example.test', role: 'member' }
        ]
    });
    await createCamera(busy, { deviceSerial: 'B1', orgId: org._id, alertThreshold: 15 });
    await createCamera(busy, { deviceSerial: 'B2', orgId: org._id, alertThreshold: 15 });
    await createCamera(calm, { deviceSerial: 'C1', orgId: org._id, alertThreshold: 15 });
    await createCamera(outsider, { deviceSerial: 'X1' });
    await orgService.syncOrgShares(org);
    await dailyRise('B1', 9);
    await dailyRise('B2', 5);
    await dailyRise('C1', 1);
    await dailyRise('X1', 50);
    const now = new Date();
    // Latest photos: B1 at its threshold, C1 calm; B2 has had no photo for two days
    await models.Snapshot.create([
        { deviceSerial: 'B1', imageUrl: 'u', s3Key: 'b1', aiProcessed: true, createdAt: now, aiResults: { summary: { fruit_fly: 20 } } },
        { deviceSerial: 'B2', imageUrl: 'u', s3Key: 'b2', aiProcessed: true, createdAt: new Date(now - 2 * DAY_MS), aiResults: { summary: { fruit_fly: 3 } } },
        { deviceSerial: 'C1', imageUrl: 'u', s3Key: 'c1', aiProcessed: true, createdAt: now, aiResults: { summary: { fruit_fly: 2 } } }
    ]);
    await models.Treatment.create({ cameraSerials: ['C1'], type: 'spray', at: new Date(now - DAY_MS), product: 'Radiant 60SC', createdBy: calm._id });
    return { lead, busy, calm, outsider, org };
}

test('cooperative overview: one row per member, busy traps with no treatment flagged first', async () => {
    const { lead, org } = await seed();
    const { status, body } = await json(await request(`/api/orgs/${org._id}/overview`, { as: lead }));
    assert.equal(status, 200);
    const o = body.overview;
    assert.equal(o.days, 7);
    assert.deepEqual(o.members.map(m => m.email), ['ba@example.test', 'tu@example.test', 'lan@example.test', 'later@example.test']);

    const [ba, tu, lan, later] = o.members;
    assert.equal(ba.cameras, 2);
    assert.equal(ba.atThreshold, 1);
    assert.equal(ba.silent, 1, 'B2 sent no photo for two days');
    assert.equal(ba.needsVisit, true);
    assert.equal(ba.ftd, 7, 'B1 9/day and B2 5/day');
    assert.equal(ba.lastTreatmentAt, null);

    assert.equal(tu.cameras, 1);
    assert.equal(tu.ftd, 1);
    assert.equal(tu.needsVisit, false);
    assert.ok(tu.lastTreatmentAt);

    assert.equal(lan.cameras, 0);
    assert.equal(lan.ftd, null);
    assert.equal(later.userId, null, 'an invited member without an account still shows');

    assert.equal(o.totals.cameras, 3, "the outsider's camera is not counted");
    assert.equal(o.totals.ftd, 5);
    assert.equal(o.totals.needsVisit, 1);
    assert.equal(o.totals.silent, 1);

    const month = await json(await request(`/api/orgs/${org._id}/overview?days=30`, { as: lead }));
    assert.equal(month.body.overview.days, 30);
});

test('cooperative overview: only its owners and managers', async () => {
    const { busy, outsider, org } = await seed();
    assert.equal((await request(`/api/orgs/${org._id}/overview`, { as: busy })).status, 403);
    assert.equal((await request(`/api/orgs/${org._id}/overview`, { as: outsider })).status, 404);
    assert.equal((await request(`/api/orgs/${org._id}/overview`)).status, 401);
});
