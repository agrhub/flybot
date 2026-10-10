const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

// Audit writes are fire-and-forget: wait until the expected entries land
async function auditEntries(filter = {}, expected = 1) {
    for (let i = 0; i < 50; i++) {
        const entries = await models.AuditLog.find(filter).sort({ createdAt: 1 }).lean();
        if (entries.length >= expected) return entries;
        await new Promise(r => setTimeout(r, 20));
    }
    return models.AuditLog.find(filter).sort({ createdAt: 1 }).lean();
}

test('sign-ins and failed sign-ins are recorded, without passwords', async () => {
    const user = await createUser({ email: 'farmer@example.test', password: await bcrypt.hash('right-pass', 4) });

    await request('/api/auth/login', { method: 'POST', body: { email: 'farmer@example.test', password: 'wrong-pass' } });
    await request('/api/auth/login', { method: 'POST', body: { email: 'ghost@example.test', password: 'whatever' } });
    await request('/api/auth/login', { method: 'POST', body: { email: 'farmer@example.test', password: 'right-pass' } });

    const failed = await auditEntries({ action: 'auth.login_failed' }, 2);
    assert.deepEqual(failed.map(e => [e.actorEmail, e.details.reason]), [
        ['farmer@example.test', 'wrong_password'],
        ['ghost@example.test', 'unknown_account']
    ]);
    const [ok] = await auditEntries({ action: 'auth.login' });
    assert.equal(String(ok.actorId), String(user._id));
    assert.ok(ok.ip, 'records the client IP');
    const all = JSON.stringify(await models.AuditLog.find().lean());
    assert.ok(!all.includes('right-pass') && !all.includes('wrong-pass'));
});

test('admin and owner actions are recorded with labels', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin@example.test' });
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    const next = await createUser({ role: 'manager', email: 'next@example.test' });
    await createCamera(owner, { deviceSerial: 'CAM1', deviceName: 'Plot A', validateCode: 'SECRET1' });

    await request('/api/user/camera', { method: 'PUT', as: owner, body: { deviceSerial: 'CAM1', deviceName: 'Plot A2', validateCode: 'SECRET2' } });
    await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'CAM1', email: 'friend@example.test' } });
    await request('/api/admin/cameras/CAM1/owner', { method: 'PUT', as: admin, body: { email: 'next@example.test' } });
    await request(`/api/admin/users/${owner._id}`, { method: 'PUT', as: admin, body: { role: 'user' } });
    await request('/api/admin/settings', { method: 'PUT', as: admin, body: { retentionMonths: 6 } });

    const [updated] = await auditEntries({ action: 'camera.updated' });
    assert.deepEqual(updated.details.fields.sort(), ['deviceName', 'validateCode']);
    assert.equal(updated.details.deviceName, 'Plot A2');
    assert.ok(!JSON.stringify(updated).includes('SECRET'), 'never stores the verification code');

    const [shared] = await auditEntries({ action: 'camera.shared' });
    assert.equal(shared.actorEmail, 'owner@example.test');
    assert.deepEqual([shared.targetId, shared.details.email, shared.details.invited], ['CAM1', 'friend@example.test', true]);

    const [moved] = await auditEntries({ action: 'camera.transferred' });
    assert.deepEqual([moved.details.from, moved.details.to], ['owner@example.test', 'next@example.test']);

    const [role] = await auditEntries({ action: 'user.role_changed' });
    assert.deepEqual([role.targetLabel, role.details.from, role.details.to], ['owner@example.test', 'manager', 'user']);

    const [settings] = await auditEntries({ action: 'settings.updated' });
    assert.equal(settings.details.retentionMonths, 6);
    void next;
});

test('admins read, filter and export the log; others cannot', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin@example.test' });
    const manager = await createUser({ role: 'manager', email: 'boss@example.test' });
    await createCamera(manager, { deviceSerial: 'CAM1', deviceName: '=HYPERLINK("x")' });
    await request('/api/user/camera/share', { method: 'POST', as: manager, body: { deviceSerial: 'CAM1', email: 'a@example.test' } });
    const { body } = await json(await request('/api/dashboards', { method: 'POST', as: manager, body: { name: 'Board', cameraSerials: ['CAM1'] } }));
    await request(`/api/dashboards/${body.dashboard.id}`, { method: 'PUT', as: manager, body: { visibility: 'public' } });
    await auditEntries({}, 3);

    assert.equal((await request('/api/admin/audit', { as: manager })).status, 403);

    const all = await json(await request('/api/admin/audit', { as: admin }));
    assert.deepEqual(all.body.entries.map(e => e.action), ['dashboard.published', 'dashboard.created', 'camera.shared']);
    assert.equal(all.body.entries[2].actor.email, 'boss@example.test');

    const cameras = await json(await request('/api/admin/audit?category=camera', { as: admin }));
    assert.equal(cameras.body.total, 1);
    const search = await json(await request('/api/admin/audit?q=board', { as: admin }));
    assert.equal(search.body.total, 2);
    const future = await json(await request(`/api/admin/audit?from=${new Date(Date.now() + 60000).toISOString()}`, { as: admin }));
    assert.equal(future.body.total, 0);

    const csv = await request('/api/admin/audit/export', { as: admin });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const bytes = Buffer.from(await csv.arrayBuffer());
    // UTF-8 BOM first, so Excel shows Vietnamese names correctly
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    assert.ok(text.includes('time,action,actor'));
    // Formula-looking cells are neutralized for spreadsheet apps
    assert.ok(text.includes(`"'=HYPERLINK(""x"")"`));
});
