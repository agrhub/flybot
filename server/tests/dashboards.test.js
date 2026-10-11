const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const dailyStats = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const HOUR = 60 * 60 * 1000;

// Stored as the AI pipeline does: snapshot first, then that day's rollup
async function snapshot(deviceSerial, summary, hoursAgo = 1) {
    const createdAt = new Date(Date.now() - hoursAgo * HOUR);
    const doc = await models.Snapshot.create({
        deviceSerial,
        imageUrl: 'x',
        s3Key: `snapshots/${deviceSerial}/${deviceSerial}_${createdAt.getTime()}.jpg`,
        createdAt,
        aiProcessed: true,
        aiResults: { detected: true, summary }
    });
    await dailyStats.refreshForSnapshot(doc);
    return doc;
}

const ALL_WIDGETS = [
    { id: 'k', type: 'kpi' },
    { id: 't', type: 'trend' },
    { id: 'c', type: 'catchesByTrap' },
    { id: 's', type: 'species' },
    { id: 'r', type: 'cameraRanking' },
    { id: 'd', type: 'dailyTable' },
    { id: 'a', type: 'activity' },
    { id: 'l', type: 'latestSnapshot' }
];

const create = (as, body) => request('/api/dashboards', { method: 'POST', as, body });
const day = (n) => dailyStats.dayKeyOf(Date.now() - n * 24 * HOUR);
const row = (serial, n, peak, total, species = 'fruit_fly') => ({
    deviceSerial: serial, day: day(n), scans: 4, total: total ?? peak * 4, peak, min: 0,
    species: [{ name: species, peak, total: total ?? peak * 4 }]
});

test('only admins and managers build dashboards', async () => {
    const viewer = await createUser({ role: 'user' });
    assert.equal((await create(viewer, { name: 'Mine' })).status, 403);
});

test('build a report and read widget data over its time range', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1', deviceName: 'Plot A', alertThreshold: 10, status: 1 });
    await createCamera(owner, { deviceSerial: 'B1', deviceName: 'Plot B', alertThreshold: 10, trapKind: 'lure' });
    await models.DailyStat.insertMany([
        // Sticky: +2 on day 7 (the week before); day 2 follows a gap (unknown), then +3 and +5
        row('A1', 8, 2), row('A1', 7, 4), row('A1', 2, 4), row('A1', 1, 7), row('A1', 0, 12),
        // Lure: 3 then 2 flies present on average
        row('B1', 1, 5, 12, 'moth'), row('B1', 0, 4, 8, 'moth')
    ]);
    await models.Snapshot.create({
        deviceSerial: 'A1', imageUrl: 'x', s3Key: `snapshots/A1/A1_${Date.now()}.jpg`,
        aiProcessed: true, aiResults: { detected: true, summary: { fruit_fly: 12 } }
    });

    const created = await json(await create(owner, { name: '  Farm overview ', cameraSerials: ['A1', 'B1'], widgets: ALL_WIDGETS }));
    assert.equal(created.status, 201);
    assert.equal(created.body.dashboard.name, 'Farm overview');
    assert.equal(created.body.dashboard.visibility, 'private');
    assert.deepEqual(created.body.dashboard.range, { preset: '7d' });
    const id = created.body.dashboard.id;

    const { body } = await json(await request(`/api/dashboards/${id}/data`, { as: owner }));
    assert.equal(body.range.days, 7);
    const w = body.widgets;
    assert.equal(w.k.cameras, 2);
    assert.equal(w.k.online, 1);
    assert.equal(w.k.scans, 20);
    assert.equal(w.k.catches, 13, 'sticky 3 + 5, lure 3 + 2');
    assert.equal(w.k.ftd, 3.3, '13 over 4 trap-days');
    assert.equal(w.k.previousCatches, 2);
    assert.equal(w.k.changePct, 550);
    assert.deepEqual(w.k.busiestDay, { day: day(0), value: 7 });
    assert.equal(w.k.alertCameras, 1);
    assert.equal(w.t.points.length, 7);
    assert.equal(w.t.points.reduce((sum, p) => sum + (p.value || 0), 0), 13);
    assert.equal(w.t.points.at(-1).previous, 2, 'today lines up with the same day a week earlier');
    assert.equal(w.c.unit, 'day');
    assert.equal(w.c.series.find(x => x.deviceSerial === 'A1').data.reduce((a, b) => a + (b || 0), 0), 8);
    assert.deepEqual(w.s.species, [{ label: 'fruit_fly', value: 8 }, { label: 'moth', value: 5 }]);
    assert.deepEqual(w.r.cameras.map(c => [c.deviceSerial, c.trapKind, c.total, c.ftd, c.risk]), [['A1', 'sticky', 8, 4, 'high'], ['B1', 'lure', 5, 2.5, 'low']]);
    assert.equal(w.d.rows.length, 7);
    assert.deepEqual([w.d.rows[0].from, w.d.rows[0].total, w.d.rows[0].topSpecies.label], [day(0), 7, 'fruit_fly']);
    assert.equal(w.a.windowDays, 7);
    assert.equal(w.a.cells.length, 7);
    assert.match(w.l.snapshots[0].imageUrl, /^\/api\/s3\/snapshots\/A1\//);

    // Another range for this view only
    const month = await json(await request(`/api/dashboards/${id}/data?range=30d`, { as: owner }));
    assert.equal(month.body.range.days, 30);
    assert.equal(month.body.widgets.k.catches, 15);
    assert.equal(month.body.widgets.k.changePct, null, 'nothing in the month before');
    const custom = await json(await request(`/api/dashboards/${id}/data?range=custom&from=${day(8)}&to=${day(7)}`, { as: owner }));
    assert.deepEqual([custom.body.range.from, custom.body.range.to, custom.body.range.days], [day(8), day(7), 2]);
    assert.equal(custom.body.widgets.k.catches, 2);
    assert.equal((await request(`/api/dashboards/${id}/data?range=custom&from=2026-02-30&to=2026-03-02`, { as: owner })).status, 400);
    assert.equal((await request(`/api/dashboards/${id}/data?range=custom&from=2024-01-01&to=2025-06-01`, { as: owner })).status, 400);
    assert.equal((await request(`/api/dashboards/${id}/data?range=5y`, { as: owner })).status, 400);

    // The saved default range
    const saved = await json(await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { range: { preset: '3m' } } }));
    assert.deepEqual(saved.body.dashboard.range, { preset: '3m' });
    const quarter = await json(await request(`/api/dashboards/${id}/data`, { as: owner }));
    assert.equal(quarter.body.range.days, 90);
    assert.equal(quarter.body.widgets.c.unit, 'week');
    assert.equal(quarter.body.widgets.c.labels.length, 13);
});

test('sharing ends at the expiry date for the public link and the people it is shared with', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test' });
    await createCamera(owner, { deviceSerial: 'A1' });
    const { body } = await json(await create(owner, { name: 'Season', cameraSerials: ['A1'], visibility: 'public', widgets: [{ id: 'k', type: 'kpi' }] }));
    const id = body.dashboard.id;
    const token = body.dashboard.publicToken;
    await request(`/api/dashboards/${id}/share`, { method: 'POST', as: owner, body: { email: 'viewer@example.test' } });

    const past = new Date(Date.now() - HOUR).toISOString();
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { expiresAt: past } })).status, 400);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { expiresAt: 'soon' } })).status, 400);
    const future = new Date(Date.now() + HOUR).toISOString();
    const set = await json(await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { expiresAt: future } }));
    assert.equal(set.body.dashboard.expiresAt, future);
    assert.equal(set.body.dashboard.expired, false);
    assert.equal((await request(`/api/dashboards/${id}`, { as: viewer })).status, 200);
    assert.equal((await request(`/api/public/dashboards/${token}`)).status, 200);

    // Time passes
    await models.Dashboard.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await request(`/api/dashboards/${id}`, { as: viewer })).status, 404);
    assert.equal((await json(await request('/api/dashboards', { as: viewer }))).body.dashboards.length, 0);
    const expired = await json(await request(`/api/public/dashboards/${token}`));
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, 'EXPIRED');
    // The owner keeps it and can extend or remove the end date
    const own = await json(await request(`/api/dashboards/${id}`, { as: owner }));
    assert.equal(own.body.dashboard.expired, true);
    await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { expiresAt: null } });
    assert.equal((await request(`/api/dashboards/${id}`, { as: viewer })).status, 200);
    assert.equal((await request(`/api/public/dashboards/${token}`)).status, 200);
    assert.equal(await models.AuditLog.countDocuments({ action: 'dashboard.expiry_changed' }), 2);
});

test('input validation', async () => {
    const owner = await createUser({ role: 'manager' });
    const stranger = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1' });
    await createCamera(stranger, { deviceSerial: 'X1' });

    assert.equal((await create(owner, { name: '' })).status, 400);
    const foreign = await json(await create(owner, { name: 'D', cameraSerials: ['A1', 'X1'] }));
    assert.equal(foreign.body.code, 'CAMERA_NOT_FOUND');
    assert.deepEqual(foreign.body.cameras, ['X1']);
    // Widget cameras must belong to the dashboard
    assert.equal((await create(owner, { name: 'D', cameraSerials: [], widgets: [{ id: 'a', type: 'kpi', cameraSerials: ['A1'] }] })).status, 400);
    assert.equal((await create(owner, { name: 'D', widgets: [{ id: 'a', type: 'pie' }] })).status, 400);
    assert.equal((await create(owner, { name: 'D', widgets: [{ id: 'a', type: 'kpi' }, { id: 'a', type: 'trend' }] })).status, 400);
    assert.equal((await create(owner, { name: 'D', widgets: [{ id: 'a', type: 'kpi', layout: { x: 20, y: 0, w: 8, h: 4 } }] })).status, 400);
});

test('sharing by email: existing account and invitation', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test', language: 'en' });
    await createCamera(owner, { deviceSerial: 'A1' });
    const { body } = await json(await create(owner, { name: 'Shared board', cameraSerials: ['A1'], widgets: [{ id: 'k', type: 'kpi' }] }));
    const id = body.dashboard.id;

    // Not visible before sharing
    assert.equal((await request(`/api/dashboards/${id}`, { as: viewer })).status, 404);

    const shared = await json(await request(`/api/dashboards/${id}/share`, { method: 'POST', as: owner, body: { email: 'Viewer@example.test' } }));
    assert.equal(shared.body.invited, false);
    assert.equal(await models.Notification.countDocuments({ userId: viewer._id, type: 'dashboard_shared' }), 1);
    assert.match(sentMails.at(-1).subject, /shared the report Shared board/);

    const list = await json(await request('/api/dashboards', { as: viewer }));
    assert.equal(list.body.dashboards.length, 1);
    assert.equal(list.body.dashboards[0].access, 'shared');
    assert.equal(list.body.dashboards[0].canEdit, false);
    const detail = await json(await request(`/api/dashboards/${id}`, { as: viewer }));
    assert.ok(!('sharedWith' in detail.body.dashboard) && !('publicToken' in detail.body.dashboard));
    // The dashboard gives the viewer the owner's camera data, but not the right to edit
    assert.equal((await json(await request(`/api/dashboards/${id}/data`, { as: viewer }))).body.widgets.k.cameras, 1);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', as: viewer, body: { name: 'Hacked' } })).status, 403);
    assert.equal((await request(`/api/dashboards/${id}/share`, { method: 'POST', as: viewer, body: { email: 'x@example.test' } })).status, 403);

    // Invitation: access only after sign-up and email confirmation
    const invited = await json(await request(`/api/dashboards/${id}/share`, { method: 'POST', as: owner, body: { email: 'newbie@example.test' } }));
    assert.equal(invited.body.invited, true);
    assert.equal(invited.body.shares.find(sh => sh.email === 'newbie@example.test').status, 'pending');
    await request('/api/auth/register', { method: 'POST', body: { email: 'newbie@example.test', password: 'secret123' } });
    const newbie = await models.User.findOne({ email: 'newbie@example.test' });
    assert.equal((await request(`/api/dashboards/${id}`, { as: newbie })).status, 404);
    const verifyMail = sentMails.find(m => m.to === 'newbie@example.test' && /verify-email/.test(m.text));
    const token = new URL(verifyMail.text.match(/https:\/\/app\.example\.test\S+/)[0]).searchParams.get('token');
    await request('/api/auth/verify-email', { method: 'POST', body: { token } });
    assert.equal((await request(`/api/dashboards/${id}`, { as: newbie })).status, 200);

    // Unshare removes access
    await request(`/api/dashboards/${id}/share`, { method: 'DELETE', as: owner, body: { email: 'viewer@example.test' } });
    assert.equal((await request(`/api/dashboards/${id}/data`, { as: viewer })).status, 404);
});

test('sharing a dashboard never leaks a camera that was only shared with its owner', async () => {
    const builder = await createUser({ role: 'manager', email: 'builder@example.test' });
    const other = await createUser({ role: 'manager' });
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test' });
    await createCamera(builder, { deviceSerial: 'OWN' });
    await createCamera(other, { deviceSerial: 'FOREIGN' });
    await request('/api/user/camera/share', { method: 'POST', as: other, body: { deviceSerial: 'FOREIGN', email: 'builder@example.test' } });

    const { body } = await json(await create(builder, { name: 'Mixed', cameraSerials: ['OWN', 'FOREIGN'], widgets: [{ id: 'k', type: 'kpi' }] }));
    const id = body.dashboard.id;
    assert.equal((await json(await request(`/api/dashboards/${id}/data`, { as: builder }))).body.widgets.k.cameras, 2);

    await request(`/api/dashboards/${id}/share`, { method: 'POST', as: builder, body: { email: 'viewer@example.test' } });
    const viewerData = await json(await request(`/api/dashboards/${id}/data`, { as: viewer }));
    assert.equal(viewerData.body.widgets.k.cameras, 1, 'FOREIGN is hidden from the viewer');

    // ...and it cannot go public with a camera the builder does not own
    const pub = await json(await request(`/api/dashboards/${id}`, { method: 'PUT', as: builder, body: { visibility: 'public' } }));
    assert.equal(pub.body.code, 'PUBLIC_FOREIGN_CAMERA');
    assert.deepEqual(pub.body.cameras, ['FOREIGN']);
});

test('public link: read-only, no sign-in, images scoped to the dashboard', async () => {
    const owner = await createUser({ role: 'manager', name: 'Farm Co' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1' });
    await createCamera(owner, { deviceSerial: 'A2' });
    await createCamera(other, { deviceSerial: 'X1' });
    await snapshot('A1', { fruit_fly: 4 });

    const { body } = await json(await create(owner, {
        name: 'Public board', cameraSerials: ['A1'], visibility: 'public', widgets: [{ id: 'l', type: 'latestSnapshot' }]
    }));
    const token = body.dashboard.publicToken;
    assert.ok(token && token.length >= 20);

    const pub = await json(await request(`/api/public/dashboards/${token}`));
    assert.equal(pub.status, 200);
    assert.equal(pub.body.dashboard.name, 'Public board');
    assert.equal(pub.body.dashboard.ownerName, 'Farm Co');
    assert.ok(!JSON.stringify(pub.body).includes(owner.email), 'no owner email on a public page');
    const imageUrl = pub.body.widgets.l.snapshots[0].imageUrl;
    assert.match(imageUrl, new RegExp(`^/api/public/dashboards/${token}/images/snapshots/A1/`));
    assert.equal((await request(imageUrl)).status, 200);
    // Another camera of the same owner, or someone else's, is not reachable through this link
    assert.equal((await request(`/api/public/dashboards/${token}/images/snapshots/A2/A2_1.jpg`)).status, 404);
    assert.equal((await request(`/api/public/dashboards/${token}/images/snapshots/X1/X1_1.jpg`)).status, 404);
    assert.equal((await request('/api/public/dashboards/not-a-real-token-123456')).status, 404);

    // New link: the old one stops working
    const id = body.dashboard.id;
    const rotated = await json(await request(`/api/dashboards/${id}/public-token`, { method: 'POST', as: owner }));
    assert.notEqual(rotated.body.publicToken, token);
    assert.equal((await request(`/api/public/dashboards/${token}`)).status, 404);
    assert.equal((await request(`/api/public/dashboards/${rotated.body.publicToken}`)).status, 200);

    // Making it private kills the link
    await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { visibility: 'private' } });
    assert.equal((await request(`/api/public/dashboards/${rotated.body.publicToken}`)).status, 404);
});

test('public dashboards stop showing cameras the owner no longer owns, and go offline with a disabled owner', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    const next = await createUser({ role: 'manager', email: 'next@example.test' });
    await createCamera(owner, { deviceSerial: 'A1' });
    const { body } = await json(await create(owner, { name: 'P', cameraSerials: ['A1'], visibility: 'public', widgets: [{ id: 'k', type: 'kpi' }] }));
    const token = body.dashboard.publicToken;

    await request('/api/admin/cameras/A1/owner', { method: 'PUT', as: admin, body: { email: 'next@example.test' } });
    assert.equal((await json(await request(`/api/public/dashboards/${token}`))).body.widgets.k.cameras, 0);

    await request(`/api/admin/users/${owner._id}`, { method: 'PUT', as: admin, body: { disabled: true } });
    assert.equal((await request(`/api/public/dashboards/${token}`)).status, 404);
    void next;
});

test('admins see, edit and publish any dashboard; managers only their own', async () => {
    const admin = await createUser({ role: 'admin' });
    const m1 = await createUser({ role: 'manager' });
    const m2 = await createUser({ role: 'manager' });
    await createCamera(m2, { deviceSerial: 'M2CAM' });
    const { body } = await json(await create(m1, { name: 'M1 board' }));
    const id = body.dashboard.id;

    assert.equal((await request(`/api/dashboards/${id}`, { as: m2 })).status, 404);
    assert.equal((await json(await request('/api/dashboards', { as: admin }))).body.dashboards.length, 1);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', as: admin, body: { name: 'Renamed' } })).status, 200);

    // An admin's own public dashboard may use any camera
    const adminBoard = await create(admin, { name: 'Overview', cameraSerials: ['M2CAM'], visibility: 'public' });
    assert.equal(adminBoard.status, 201);

    assert.equal((await request(`/api/dashboards/${id}`, { method: 'DELETE', as: m2 })).status, 404);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'DELETE', as: m1 })).status, 200);
});

test('widgets can have their own range, grouping, camera status and threshold filters', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1', deviceName: 'Plot A', alertThreshold: 10, status: 1 });
    await createCamera(owner, { deviceSerial: 'B1', deviceName: 'Plot B', alertThreshold: 10, status: 0 });
    await models.DailyStat.insertMany([
        row('A1', 20, 1), row('A1', 19, 3), row('A1', 1, 2), row('A1', 0, 6),
        row('B1', 1, 1), row('B1', 0, 2)
    ]);
    await models.Snapshot.create({
        deviceSerial: 'A1', imageUrl: 'x', s3Key: `snapshots/A1/A1_${Date.now()}.jpg`,
        aiProcessed: true, aiResults: { detected: true, summary: { fruit_fly: 12 } }
    });
    const widgets = [
        { id: 'week', type: 'kpi' },
        { id: 'month', type: 'kpi', range: { preset: '30d' } },
        { id: 'online', type: 'kpi', status: 'online' },
        { id: 'alarm', type: 'cameraRanking', risk: 'high' },
        { id: 'weekly', type: 'trend', range: { preset: '30d' }, granularity: 'week' }
    ];
    const { body } = await json(await create(owner, { name: 'Filters', cameraSerials: ['A1', 'B1'], widgets }));
    assert.equal(body.dashboard.widgets[1].range.preset, '30d');
    assert.equal(body.dashboard.widgets[0].range, null);
    const w = (await json(await request(`/api/dashboards/${body.dashboard.id}/data`, { as: owner }))).body.widgets;
    assert.equal(w.week.catches, 5, 'A1 +4, B1 +1 this week');
    assert.equal(w.week.range.own, false);
    assert.equal(w.month.catches, 7, 'the widget reads 30 days: A1 +2 on day 19 too');
    assert.deepEqual([w.month.range.days, w.month.range.own], [30, true]);
    assert.equal(w.online.cameras, 1);
    assert.deepEqual(w.alarm.cameras.map(c => c.deviceSerial), ['A1']);
    assert.equal(w.weekly.unit, 'week');
    assert.equal(w.weekly.points.length, 5);

    const bad = await create(owner, { name: 'Bad', widgets: [{ id: 'x', type: 'kpi', granularity: 'year' }] });
    assert.equal(bad.status, 400);
});
