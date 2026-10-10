const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { mergeDuplicateCameras } = require('../src/services/migrations');
const notificationService = require('../src/services/notificationService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const share = (as, deviceSerial, email) =>
    request('/api/user/camera/share', { method: 'POST', as, body: { deviceSerial, email } });

test('a device can be registered only once', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'DEV1' });

    const res = await json(await request('/api/user/add-camera', { method: 'POST', as: other, body: { deviceSerial: 'DEV1', validateCode: 'ABCDEF' } }));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'CAMERA_TAKEN');

    // Re-adding your own camera just refreshes it
    const again = await request('/api/user/add-camera', { method: 'POST', as: owner, body: { deviceSerial: 'DEV1', validateCode: 'NEWCODE' } });
    assert.equal(again.status, 200);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'DEV1' })).validateCode, 'NEWCODE');
});

test('viewers (role user) cannot add cameras', async () => {
    const viewer = await createUser({ role: 'user' });
    const res = await request('/api/user/add-camera', { method: 'POST', as: viewer, body: { deviceSerial: 'DEV9', validateCode: 'ABCDEF' } });
    assert.equal(res.status, 403);
});

test('sharing with an existing account gives view-only access', async () => {
    const owner = await createUser({ role: 'manager', name: 'Owner' });
    // Emails follow the recipient's language
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test', language: 'en' });
    await createCamera(owner, { deviceSerial: 'DEV1', validateCode: 'SECRET' });

    const res = await json(await share(owner, 'DEV1', 'Viewer@Example.test'));
    assert.equal(res.status, 200);
    assert.equal(res.body.invited, false);
    assert.equal(res.body.shares[0].status, 'active');

    // In-app notification + email for the recipient
    assert.equal(await models.Notification.countDocuments({ userId: viewer._id, type: 'camera_shared' }), 1);
    assert.match(sentMails.at(-1).subject, /shared the camera/);

    // The viewer sees it, without the verification code or share list
    const list = await json(await request('/api/user/cameras', { as: viewer }));
    assert.equal(list.body.cameras.length, 1);
    const cam = list.body.cameras[0];
    assert.equal(cam.access, 'shared');
    assert.equal(cam.canManage, false);
    assert.equal(cam.owner.email, owner.email);
    assert.ok(!('validateCode' in cam) && !('sharedWith' in cam));

    // ...can watch, but cannot change, delete or re-share
    assert.equal((await request('/api/live', { method: 'POST', as: viewer, body: { deviceSerial: 'DEV1' } })).status, 200);
    assert.equal((await request('/api/user/camera', { method: 'PUT', as: viewer, body: { deviceSerial: 'DEV1', deviceName: 'Mine' } })).status, 404);
    assert.equal((await request('/api/user/delete-camera', { method: 'DELETE', as: viewer, body: { deviceSerial: 'DEV1' } })).status, 404);
    assert.equal((await share(viewer, 'DEV1', 'someone@example.test')).status, 404);
});

test('share validation: owner, duplicates and bad emails', async () => {
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    await createCamera(owner, { deviceSerial: 'DEV1' });
    assert.equal((await json(await share(owner, 'DEV1', 'OWNER@example.test'))).body.code, 'SHARE_WITH_OWNER');
    assert.equal((await share(owner, 'DEV1', 'not-an-email')).status, 400);
    await share(owner, 'DEV1', 'a@example.test');
    assert.equal((await json(await share(owner, 'DEV1', 'a@example.test'))).body.code, 'ALREADY_SHARED');
});

test('inviting an unknown email: access only after sign-up AND email confirmation', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'DEV1' });

    const res = await json(await share(owner, 'DEV1', 'newbie@example.test'));
    assert.equal(res.body.invited, true);
    assert.equal(res.body.shares[0].status, 'pending');
    assert.equal(sentMails.at(-1).to, 'newbie@example.test');
    assert.match(sentMails.at(-1).text, /mode=register/);

    // Registering is not enough: the address must be confirmed first
    await request('/api/auth/register', { method: 'POST', body: { email: 'newbie@example.test', password: 'secret123' } });
    const newbie = await models.User.findOne({ email: 'newbie@example.test' });
    assert.equal((await json(await request('/api/user/cameras', { as: newbie }))).body.cameras.length, 0);

    const verifyMail = sentMails.find(m => m.to === 'newbie@example.test' && /verify-email/.test(m.text));
    const tokenParam = new URL(verifyMail.text.match(/https:\/\/app\.example\.test\S+/)[0]).searchParams.get('token');
    assert.equal((await request('/api/auth/verify-email', { method: 'POST', body: { token: tokenParam } })).status, 200);

    const after = await json(await request('/api/user/cameras', { as: newbie }));
    assert.equal(after.body.cameras.length, 1);
    assert.equal(after.body.cameras[0].access, 'shared');
});

test('removing a share revokes access', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser({ role: 'user', email: 'v@example.test' });
    await createCamera(owner, { deviceSerial: 'DEV1' });
    await share(owner, 'DEV1', 'v@example.test');

    const res = await request('/api/user/camera/share', { method: 'DELETE', as: owner, body: { deviceSerial: 'DEV1', email: 'v@example.test' } });
    assert.equal(res.status, 200);
    assert.equal((await json(await request('/api/user/cameras', { as: viewer }))).body.cameras.length, 0);
    assert.equal((await request('/api/live', { method: 'POST', as: viewer, body: { deviceSerial: 'DEV1' } })).status, 403);
});

test('snapshot images: owner and shared viewers yes, strangers no', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser({ role: 'user', email: 'v@example.test' });
    const stranger = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'DEV1' });
    await share(owner, 'DEV1', 'v@example.test');

    const image = '/api/s3/snapshots/DEV1/DEV1_1.jpg';
    assert.equal((await request(image, { as: owner })).status, 200);
    assert.equal((await request(image, { as: viewer })).status, 200);
    assert.equal((await request(image, { as: stranger })).status, 404);
});

test('admin sees and manages every camera', async () => {
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'DEV1' });

    const list = await json(await request('/api/user/cameras', { as: admin }));
    assert.equal(list.body.cameras[0].access, 'admin');
    assert.equal(list.body.cameras[0].canManage, true);
    assert.equal((await request('/api/user/camera', { method: 'PUT', as: admin, body: { deviceSerial: 'DEV1', deviceName: 'Renamed by admin' } })).status, 200);
});

test('an owner demoted to "user" can still view but no longer manage', async () => {
    const owner = await createUser({ role: 'user' });
    await createCamera(owner, { deviceSerial: 'DEV1' });
    assert.equal((await json(await request('/api/user/cameras', { as: owner }))).body.cameras[0].canManage, false);
    assert.equal((await request('/api/user/camera', { method: 'PUT', as: owner, body: { deviceSerial: 'DEV1', deviceName: 'x' } })).status, 404);
});

test('alerts reach the owner and everyone the camera is shared with', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser({ role: 'user', email: 'v@example.test' });
    await createCamera(owner, { deviceSerial: 'DEV1', alertThreshold: 10 });
    await share(owner, 'DEV1', 'v@example.test');
    await share(owner, 'DEV1', 'pending@example.test');

    const created = await notificationService.checkPestThreshold('DEV1', 12);
    assert.deepEqual(created.map(n => String(n.userId)).sort(), [String(owner._id), String(viewer._id)].sort());
});

test('merging duplicate records left by the old per-account model', async () => {
    const first = await createUser({ role: 'manager', email: 'first@example.test' });
    const second = await createUser({ role: 'manager', email: 'second@example.test' });
    // Recreate the pre-phase-3 state: same serial twice (needs the unique index off)
    await models.Camera.collection.dropIndex('deviceSerial_1');
    await models.Camera.collection.insertMany([
        { userId: first._id, deviceSerial: 'DUP1', deviceName: 'First', addedAt: new Date('2026-01-01'), sharedWith: [] },
        { userId: second._id, deviceSerial: 'DUP1', deviceName: 'Second', addedAt: new Date('2026-02-01'), sharedWith: [] }
    ]);

    const preview = await mergeDuplicateCameras({ apply: false });
    assert.equal(preview.groups, 1);
    assert.equal(await models.Camera.countDocuments({ deviceSerial: 'DUP1' }), 2, 'preview changes nothing');

    await mergeDuplicateCameras({ apply: true });
    const merged = await models.Camera.find({ deviceSerial: 'DUP1' });
    assert.equal(merged.length, 1);
    assert.equal(String(merged[0].userId), String(first._id), 'earliest record keeps ownership');
    assert.deepEqual(merged[0].sharedWith.map(sh => sh.email), ['second@example.test']);

    await models.Camera.syncIndexes(); // the unique index can be built again
});
