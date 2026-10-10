const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const HOUR = 60 * 60 * 1000;

function snapshot(deviceSerial, summary, hoursAgo = 1) {
    const createdAt = new Date(Date.now() - hoursAgo * HOUR);
    return models.Snapshot.create({
        deviceSerial,
        imageUrl: 'x',
        s3Key: `snapshots/${deviceSerial}/${deviceSerial}_${createdAt.getTime()}.jpg`,
        createdAt,
        aiProcessed: true,
        aiResults: { detected: true, summary }
    });
}

const ALL_WIDGETS = [
    { id: 'k', type: 'kpi', rangeDays: 7 },
    { id: 't', type: 'trend', rangeDays: 7 },
    { id: 's', type: 'species', rangeDays: 7 },
    { id: 'r', type: 'cameraRanking', rangeDays: 7 },
    { id: 'l', type: 'latestSnapshot', rangeDays: 7 }
];

const create = (as, body) => request('/api/dashboards', { method: 'POST', as, body });

test('only admins and managers build dashboards', async () => {
    const viewer = await createUser({ role: 'user' });
    assert.equal((await create(viewer, { name: 'Mine' })).status, 403);
});

test('build a dashboard and read widget data', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1', deviceName: 'Plot A', alertThreshold: 10, status: 1 });
    await createCamera(owner, { deviceSerial: 'B1', deviceName: 'Plot B', alertThreshold: 10 });
    // A1: two scans today (peak 12), B1: one scan (3 fruit flies + 1 person, which is not a pest)
    await snapshot('A1', { fruit_fly: 5 }, 2);
    await snapshot('A1', { fruit_fly: 10, moth: 2 }, 1);
    await snapshot('B1', { 'ruồi vàng': 3, person: 1 }, 1);

    const created = await json(await create(owner, { name: '  Farm overview ', cameraSerials: ['A1', 'B1'], widgets: ALL_WIDGETS }));
    assert.equal(created.status, 201);
    assert.equal(created.body.dashboard.name, 'Farm overview');
    assert.equal(created.body.dashboard.visibility, 'private');
    const id = created.body.dashboard.id;

    const { body } = await json(await request(`/api/dashboards/${id}/data`, { as: owner }));
    const w = body.widgets;
    assert.equal(w.k.cameras, 2);
    assert.equal(w.k.online, 1);
    assert.equal(w.k.scans, 3);
    assert.equal(w.k.totalPests, 15, 'per-camera daily peak, then summed: 12 + 3');
    assert.equal(w.k.alertCameras, 1);
    assert.equal(w.t.points.length, 7);
    assert.equal(w.t.points.reduce((sum, p) => sum + p.value, 0), 15);
    assert.deepEqual(w.s.species, [{ label: 'fruit_fly', value: 13 }, { label: 'moth', value: 2 }]);
    assert.deepEqual(w.r.cameras.map(c => [c.deviceSerial, c.total, c.risk]), [['A1', 12, 'high'], ['B1', 3, 'moderate']]);
    assert.match(w.l.snapshots[0].imageUrl, /^\/api\/s3\/snapshots\/A1\//);
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
    assert.match(sentMails.at(-1).subject, /shared the dashboard Shared board/);

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
