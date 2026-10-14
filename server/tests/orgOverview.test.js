const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const orgService = require('../src/services/orgService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');
const { sendOrgDigests } = require('../src/services/orgReminderService');

before(startDb);
after(stopDb);
beforeEach(() => { sentMails.length = 0; return clearDb(); });

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

test('reminding members: once a day each, only those with traps here', async () => {
    const { lead, busy, calm, org } = await seed();
    const remind = (userIds) => request(`/api/orgs/${org._id}/remind`, { method: 'POST', as: lead, body: { userIds } }).then(json);
    const first = await remind([String(busy._id), String(lead._id)]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.results.map(r => r.status), ['sent', 'skipped'], 'the lead has no traps in the organization');
    const note = await models.Notification.findOne({ userId: busy._id, type: 'log_reminder' }).lean();
    assert.equal(note.params.atThreshold, 1);
    assert.equal(note.params.sender, 'Lan');
    assert.ok(sentMails.some(m => m.to === 'ba@example.test'), 'emailed too');

    const again = await remind([String(busy._id), String(calm._id)]);
    assert.deepEqual(again.body.results.map(r => r.status), ['already', 'sent']);
    assert.equal((await request(`/api/orgs/${org._id}/remind`, { method: 'POST', as: busy, body: { userIds: [String(calm._id)] } })).status, 403);
    assert.equal((await remind([])).status, 400);
    assert.ok(await models.AuditLog.exists({ action: 'org.log_reminded' }));
});

test('Monday digest: owners and managers get the members to visit, unless turned off', async () => {
    const { lead, busy } = await seed();
    const manager = await createUser({ role: 'manager', email: 'mgr@example.test', notificationPrefs: { orgDigest: false } });
    await models.Organization.updateOne({}, { $push: { members: { userId: manager._id, email: manager.email, role: 'manager' } } });
    assert.deepEqual(await sendOrgDigests(), { sent: 1 });
    const digest = await models.Notification.findOne({ type: 'org_digest' }).lean();
    assert.equal(String(digest.userId), String(lead._id));
    assert.equal(digest.params.count, 1);
    assert.equal(digest.params.names, 'Ba');
    assert.equal(await models.Notification.countDocuments({ type: 'org_digest', userId: busy._id }), 0, 'members do not get it');
    // Once a week
    assert.deepEqual(await sendOrgDigests(), { sent: 0 });
});

test('cooperative report: members ranked, PDF download and email, owners and managers only', async () => {
    const { lead, busy, org } = await seed();
    const { coopData, buildCoopPdf } = require('../src/services/coopReportService');
    const { parsePeriod } = require('../src/services/seasonReportService');
    const data = await coopData(await models.Organization.findById(org._id), parsePeriod({ from: dayAgo(6), to: dayAgo(0) }));
    assert.deepEqual(data.members.map(m => m.name), ['Ba', 'Tu'], 'busiest first, only members with traps');
    assert.equal(data.members[0].ftd, 7);
    assert.equal(data.members[1].treatments, 1);
    assert.equal(data.totals.traps, 3);
    assert.equal(data.treatments[0].member, 'Tu');
    assert.ok(buildCoopPdf(data, { language: 'vi', owner: 'Lan' }).subarray(0, 4).equals(Buffer.from('%PDF')));

    const res = await request(`/api/orgs/${org._id}/report?from=${dayAgo(29)}&to=${dayAgo(0)}`, { as: lead });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await res.arrayBuffer()).subarray(0, 4).equals(Buffer.from('%PDF')));
    assert.equal((await request(`/api/orgs/${org._id}/report`, { as: busy })).status, 403);
    assert.equal((await request(`/api/orgs/${org._id}/report?from=2026-13-01`, { as: lead })).status, 400);

    const sent = await json(await request(`/api/orgs/${org._id}/report/send`, { method: 'POST', as: lead, body: {} }));
    assert.equal(sent.status, 200);
    const mail = sentMails.find(m => m.to === 'lan@example.test' && m.attachments?.length);
    assert.match(mail.subject, /Hoa Loc cooperative/);
    assert.match(mail.attachments[0].filename, /^FlyBot_cooperative_.*\.pdf$/);
});

test('someone who left the organization: their cameras still count, but no reminder, no visit list', async () => {
    const { lead, busy, org } = await seed();
    // Ba leaves; the cameras stay in the organization
    await models.Organization.updateOne({ _id: org._id }, { $pull: { members: { email: 'ba@example.test' } } });
    const { body } = await json(await request(`/api/orgs/${org._id}/overview`, { as: lead }));
    const ba = body.overview.members.find(m => m.email === 'ba@example.test');
    assert.equal(ba.member, false);
    assert.equal(ba.cameras, 2);
    assert.equal(ba.needsVisit, false);
    assert.equal(body.overview.totals.needsVisit, 0);

    const remind = await json(await request(`/api/orgs/${org._id}/remind`, { method: 'POST', as: lead, body: { userIds: [String(busy._id)] } }));
    assert.deepEqual(remind.body.results.map(r => r.status), ['skipped']);
    assert.equal(await models.Notification.countDocuments({ userId: busy._id, type: 'log_reminder' }), 0);
    assert.deepEqual(await sendOrgDigests(), { sent: 0 });
});

test('another organization cannot see, remind or report this one', async () => {
    const { org, outsider } = await seed();
    await models.Organization.create({ name: 'Other', members: [{ userId: outsider._id, email: outsider.email, role: 'owner' }] });
    assert.equal((await request(`/api/orgs/${org._id}/overview`, { as: outsider })).status, 404);
    assert.equal((await request(`/api/orgs/${org._id}/report`, { as: outsider })).status, 404);
    assert.equal((await request(`/api/orgs/${org._id}/report/send`, { method: 'POST', as: outsider, body: {} })).status, 404);
    assert.equal((await request(`/api/orgs/${org._id}/remind`, { method: 'POST', as: outsider, body: { userIds: ['x'] } })).status, 404);
});
