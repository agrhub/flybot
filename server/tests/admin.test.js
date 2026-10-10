const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const settingsService = require('../src/services/settingsService');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    settingsService.clearCache();
});

test('admin lists every camera with its owner, searchable by owner email', async () => {
    const admin = await createUser({ role: 'admin' });
    const alice = await createUser({ role: 'manager', email: 'alice@farm.test' });
    const bob = await createUser({ role: 'manager', email: 'bob@farm.test' });
    await createCamera(alice, { deviceSerial: 'A1' });
    await createCamera(bob, { deviceSerial: 'B1' });

    const all = await json(await request('/api/admin/cameras', { as: admin }));
    assert.equal(all.body.total, 2);
    const byAlice = await json(await request('/api/admin/cameras?q=alice@', { as: admin }));
    assert.deepEqual(byAlice.body.cameras.map(c => c.deviceSerial), ['A1']);
    assert.equal(byAlice.body.cameras[0].owner.email, 'alice@farm.test');

    assert.equal((await request('/api/admin/cameras', { as: alice })).status, 403);
});

test('transferring a camera: new owner must be a manager; old owner can keep view access', async () => {
    const admin = await createUser({ role: 'admin' });
    const alice = await createUser({ role: 'manager', email: 'alice@farm.test' });
    const bob = await createUser({ role: 'manager', email: 'bob@farm.test' });
    const viewer = await createUser({ role: 'user', email: 'viewer@farm.test' });
    await createCamera(alice, { deviceSerial: 'A1' });

    const toViewer = await json(await request('/api/admin/cameras/A1/owner', { method: 'PUT', as: admin, body: { email: 'viewer@farm.test' } }));
    assert.equal(toViewer.body.code, 'NOT_MANAGER');
    const unknown = await json(await request('/api/admin/cameras/A1/owner', { method: 'PUT', as: admin, body: { email: 'nobody@farm.test' } }));
    assert.equal(unknown.body.code, 'USER_NOT_FOUND');

    const ok = await request('/api/admin/cameras/A1/owner', { method: 'PUT', as: admin, body: { email: 'BOB@farm.test' } });
    assert.equal(ok.status, 200);
    const camera = await models.Camera.findOne({ deviceSerial: 'A1' });
    assert.equal(String(camera.userId), String(bob._id));
    assert.deepEqual(camera.sharedWith.map(sh => sh.email), ['alice@farm.test'], 'previous owner keeps view access');

    // Now Alice can be deleted (she owns nothing)
    assert.equal((await request(`/api/admin/users/${alice._id}`, { method: 'DELETE', as: admin })).status, 200);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'A1' })).sharedWith.length, 0, 'deleted user removed from shares');
    void viewer;
});

test('system settings: validated, admin-only, and applied', async () => {
    const admin = await createUser({ role: 'admin' });
    const manager = await createUser({ role: 'manager' });

    assert.equal((await request('/api/admin/settings', { as: manager })).status, 403);
    for (const body of [{ retentionMonths: 0 }, { defaultAlertThreshold: 2.5 }, { allowRegistration: 'no' }, { unknown: 1 }]) {
        assert.equal((await request('/api/admin/settings', { method: 'PUT', as: admin, body })).status, 400, JSON.stringify(body));
    }

    const saved = await json(await request('/api/admin/settings', {
        method: 'PUT', as: admin, body: { allowRegistration: false, defaultAlertThreshold: 25, retentionMonths: 6 }
    }));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.defaultAlertThreshold, 25);

    // Registration closed for everyone, and the sign-in page can tell
    const reg = await request('/api/auth/register', { method: 'POST', body: { email: 'late@example.test', password: 'secret123' } });
    assert.equal(reg.status, 403);
    assert.equal((await json(await request('/api/auth/config'))).body.allowRegistration, false);

    // New cameras start with the configured threshold
    await request('/api/user/add-camera', { method: 'POST', as: manager, body: { deviceSerial: 'NEW1', validateCode: 'ABCDEF' } });
    assert.equal((await models.Camera.findOne({ deviceSerial: 'NEW1' })).alertThreshold, 25);
});
