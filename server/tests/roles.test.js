const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { ensureRoles } = require('../src/services/migrations');

before(startDb);
after(stopDb);
beforeEach(clearDb);

test('the first registered account is admin, later ones are users', async () => {
    const first = await request('/api/auth/register', { method: 'POST', body: { email: 'first@example.test', password: 'secret123' } });
    assert.equal(first.status, 200);
    await request('/api/auth/register', { method: 'POST', body: { email: 'second@example.test', password: 'secret123' } });

    assert.equal((await models.User.findOne({ email: 'first@example.test' })).role, 'admin');
    assert.equal((await models.User.findOne({ email: 'second@example.test' })).role, 'user');
});

test('startup migration gives roles to accounts created before roles existed', async () => {
    // Raw inserts without a role field, like pre-phase-3 data
    const users = models.User.collection;
    const old = new Date('2026-01-01');
    const { insertedIds } = await users.insertMany([
        { email: 'oldest@example.test', password: 'x', createdAt: old },
        { email: 'owner@example.test', password: 'x', createdAt: new Date('2026-02-01') },
        { email: 'viewer@example.test', password: 'x', createdAt: new Date('2026-03-01') }
    ]);
    await models.Camera.collection.insertOne({ userId: insertedIds[1], deviceSerial: 'OLD1' });

    await ensureRoles();
    const byEmail = async (email) => (await users.findOne({ email })).role;
    assert.equal(await byEmail('oldest@example.test'), 'admin');
    assert.equal(await byEmail('owner@example.test'), 'manager');
    assert.equal(await byEmail('viewer@example.test'), 'user');

    // Idempotent: nothing changes on the next start
    assert.deepEqual(await ensureRoles(), { changed: 0 });
});

test('admin APIs are admin-only', async () => {
    const manager = await createUser({ role: 'manager' });
    const user = await createUser({ role: 'user' });
    for (const as of [manager, user]) {
        assert.equal((await request('/api/admin/users', { as })).status, 403);
    }
});

test('admin lists users with their camera counts', async () => {
    const admin = await createUser({ role: 'admin' });
    const manager = await createUser({ role: 'manager', email: 'mgr@example.test' });
    await createCamera(manager);
    await createCamera(manager);

    const { status, body } = await json(await request('/api/admin/users?q=mgr', { as: admin }));
    assert.equal(status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.users[0].cameraCount, 2);
    assert.equal(body.users[0].role, 'manager');
    assert.ok(!('password' in body.users[0]));
});

test('admin changes roles and disables accounts; disabled accounts are signed out', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ role: 'user' });

    const promoted = await json(await request(`/api/admin/users/${user._id}`, { method: 'PUT', as: admin, body: { role: 'manager' } }));
    assert.equal(promoted.body.user.role, 'manager');

    const fresh = await models.User.findById(user._id);
    const disabled = await request(`/api/admin/users/${user._id}`, { method: 'PUT', as: admin, body: { disabled: true } });
    assert.equal(disabled.status, 200);
    assert.equal((await request('/api/auth/me', { as: fresh })).status, 401, 'old token rejected');

    const login = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password: 'secret123' } });
    assert.equal(login.status, 403);
    assert.equal((await login.json()).code, 'ACCOUNT_DISABLED');
});

test('guards: no self-demotion, always one admin, invalid roles rejected', async () => {
    const admin = await createUser({ role: 'admin' });
    const self = await json(await request(`/api/admin/users/${admin._id}`, { method: 'PUT', as: admin, body: { role: 'user' } }));
    assert.equal(self.status, 400);
    assert.equal(self.body.code, 'SELF_CHANGE');

    const other = await createUser({ role: 'admin' });
    // Disable the other admin: fine, one admin remains
    assert.equal((await request(`/api/admin/users/${other._id}`, { method: 'PUT', as: admin, body: { disabled: true } })).status, 200);

    const bad = await request(`/api/admin/users/${other._id}`, { method: 'PUT', as: admin, body: { role: 'superuser' } });
    assert.equal(bad.status, 400);
});

test('deleting a user who owns cameras is refused until they are transferred', async () => {
    const admin = await createUser({ role: 'admin' });
    const manager = await createUser({ role: 'manager' });
    await createCamera(manager);

    const refused = await json(await request(`/api/admin/users/${manager._id}`, { method: 'DELETE', as: admin }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'OWNS_CAMERAS');

    await models.Camera.deleteMany({ userId: manager._id });
    assert.equal((await request(`/api/admin/users/${manager._id}`, { method: 'DELETE', as: admin })).status, 200);
    assert.equal(await models.User.countDocuments({ _id: manager._id }), 0);
});

test('profile exposes the role', async () => {
    const manager = await createUser({ role: 'manager' });
    const { body } = await json(await request('/api/auth/me', { as: manager }));
    assert.equal(body.user.role, 'manager');
});
