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

const dayKey = (n) => dailyStats.dayKeyOf(Date.now() - n * 24 * 60 * MIN);
const lureRow = (serial, n, perPhoto) => ({ deviceSerial: serial, day: dayKey(n), scans: 4, total: perPhoto * 4, peak: perPhoto, min: 0, species: [{ name: 'fruit_fly', peak: perPhoto, total: perPhoto * 4 }] });

test('reports: listed, summarized and emailed only to people who can open them', async () => {
    const { request, sentMails } = require('./dbHelpers');
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'RPT1', trapKind: 'lure' });
    await models.DailyStat.insertMany([1, 2, 3].map(n => lureRow('RPT1', n, 5)));
    const created = await (await request('/api/dashboards', { method: 'POST', as: owner, body: { name: 'Season', cameraSerials: ['RPT1'], widgets: [{ id: 'w1', type: 'trend', layout: { x: 0, y: 0, w: 24, h: 5 } }] } })).json();
    const id = created.dashboard.id;

    const list = await allExecutors.list_reports({ ...asUser(owner) });
    assert.deepEqual(list.reports.map(r => [r.id, r.name, r.mine]), [[id, 'Season', true]]);
    // Key figures even though the report itself has no key-figures block
    const summary = await allExecutors.get_report_summary({ ...asUser(owner), reportId: id, range: '7d' });
    assert.equal(summary.name, 'Season');
    assert.equal(summary.insectsCaught, 15);
    assert.equal(summary.topTraps.length, 1);

    assert.match((await allExecutors.get_report_summary({ ...asUser(other), reportId: id })).error, /not found/);
    assert.match((await allExecutors.send_report_to_me({ ...asUser(other), reportId: id })).error, /not found/);
    assert.match((await allExecutors.get_report_summary({ ...asUser(owner), reportId: 'not-an-id' })).error, /not found/);

    sentMails.length = 0;
    const sent = await allExecutors.send_report_to_me({ ...asUser(owner), reportId: id });
    assert.equal(sent.success, true);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, owner.email);
});

test('alerts: the user\'s own recent alerts and the sticky cards due now', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ALR1', deviceName: 'Mango A', addedAt: new Date(Date.now() - 40 * 24 * 60 * MIN) });
    await createCamera(owner, { deviceSerial: 'ALR2', trapKind: 'lure', addedAt: new Date(Date.now() - 40 * 24 * 60 * MIN) });
    await models.Notification.create({ userId: owner._id, type: 'pest_threshold', severity: 'critical', deviceSerial: 'ALR1', params: { count: 20 } });
    await models.Notification.create({ userId: other._id, type: 'pest_threshold', deviceSerial: 'ALR1' });
    await models.Notification.create({ userId: owner._id, type: 'camera_offline', deviceSerial: 'ALR1', createdAt: new Date(Date.now() - 10 * 24 * 60 * MIN) });

    const res = await allExecutors.get_alerts({ ...asUser(owner) });
    assert.deepEqual(res.alerts.map(a => [a.type, a.trap]), [['pest_threshold', 'Mango A']]);
    assert.deepEqual(res.cardsDue.map(c => c.serial), ['ALR1'], 'lure traps have no card');
    assert.equal((await allExecutors.get_alerts({ ...asUser(owner), days: 14 })).alerts.length, 2);
});

test('treatments: from the logbook, with their effect, only on visible cameras', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'TRT1', trapKind: 'lure' });
    // 6 flies per photo before the treatment, 2 after
    await models.DailyStat.insertMany([
        ...[10, 9, 8, 7, 6, 5, 4].map(n => lureRow('TRT1', n, 6)),
        ...[3, 2, 1, 0].map(n => lureRow('TRT1', n, 2))
    ]);
    await models.Treatment.create({ cameraSerials: ['TRT1'], type: 'spray', product: 'Bait X', at: new Date(`${dayKey(4)}T08:00:00+07:00`) });
    const res = await allExecutors.get_treatments({ ...asUser(owner) });
    assert.equal(res.treatments.length, 1);
    assert.equal(res.treatments[0].product, 'Bait X');
    assert.equal(res.treatments[0].effect.verdict, 'effective');
    assert.equal((await allExecutors.get_treatments({ ...asUser(other) })).total, 0);
    assert.match((await allExecutors.get_treatments({ ...asUser(other), deviceSerial: 'TRT1' })).error, /permission/);
});

test('compare periods: this week against the week before', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'CMP1', deviceName: 'Lure 1', trapKind: 'lure' });
    await models.DailyStat.insertMany([
        ...[13, 12, 11, 10, 9, 8, 7].map(n => lureRow('CMP1', n, 2)),
        ...[6, 5, 4, 3, 2, 1, 0].map(n => lureRow('CMP1', n, 4))
    ]);
    const res = await allExecutors.compare_periods({ ...asUser(owner), days: 7 });
    assert.equal(res.current.caught, 28);
    assert.equal(res.previous.caught, 14);
    assert.equal(res.changePct, 100);
    assert.deepEqual(res.bySpecies, [{ species: 'fruit_fly', now: 28, before: 14 }]);
    assert.deepEqual(res.biggestChanges.map(t => [t.trap, t.changePct]), [['Lure 1', 100]]);
});

test('pipeline health is for administrators only', async () => {
    const manager = await createUser({ role: 'manager' });
    const admin = await createUser({ role: 'admin' });
    assert.match((await allExecutors.get_pipeline_health({ ...asUser(manager) })).error, /administrators/);
    const res = await allExecutors.get_pipeline_health({ ...asUser(admin) });
    assert.equal(res.windowHours, 24);
    assert.ok(res.totals);
});
