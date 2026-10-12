const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { lowercaseEmails } = require('../src/services/migrations');

before(startDb);
after(stopDb);
beforeEach(clearDb);

test('emails are case-insensitive: stored lowercase, no case-variant duplicates', async () => {
    await createUser({ role: 'admin' });
    const reg = await request('/api/auth/register', { method: 'POST', body: { email: 'Boss@Corp.test', password: 'secret123' } });
    assert.equal(reg.status, 200);
    assert.ok(await models.User.exists({ email: 'boss@corp.test' }));

    const again = await request('/api/auth/register', { method: 'POST', body: { email: 'BOSS@corp.test', password: 'secret123' } });
    assert.equal(again.status, 400);

    const login = await request('/api/auth/login', { method: 'POST', body: { email: 'bOsS@corp.TEST', password: 'secret123' } });
    assert.equal(login.status, 200);
});

test('older mixed-case emails are lowercased unless that would clash', async () => {
    await models.User.collection.insertMany([
        { email: 'Farmer@Example.test', password: 'x', role: 'user' },
        { email: 'Twin@Example.test', password: 'x', role: 'user' },
        { email: 'twin@example.test', password: 'x', role: 'user' }
    ]);
    const { changed, conflicts } = await lowercaseEmails();
    assert.equal(changed, 1);
    assert.deepEqual(conflicts, ['Twin@Example.test']);
    assert.ok(await models.User.collection.findOne({ email: 'farmer@example.test' }));
});

test('sharing with an unconfirmed account stays pending until the address is confirmed', async () => {
    const owner = await createUser({ role: 'manager' });
    // Someone registered this address but never proved they own it
    const squatter = await createUser({ email: 'boss@corp.test', emailVerified: false });
    await createCamera(owner, { deviceSerial: 'CAM1' });

    const res = await json(await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'CAM1', email: 'boss@corp.test' } }));
    assert.equal(res.body.invited, true);
    // Shown as "not confirmed" (registration already tells whether an address is taken), still no access
    assert.equal(res.body.shares[0].status, 'unverified');
    assert.equal((await json(await request('/api/user/cameras', { as: squatter }))).body.cameras.length, 0);
    assert.equal(await models.Notification.countDocuments({ userId: squatter._id }), 0);
    // The real owner of the address is told, and gets access once they confirm it
    assert.equal(sentMails.at(-1).to, 'boss@corp.test');

    const { body } = await json(await request('/api/dashboards', { method: 'POST', as: owner, body: { name: 'Board', cameraSerials: ['CAM1'] } }));
    const shared = await json(await request(`/api/dashboards/${body.dashboard.id}/share`, { method: 'POST', as: owner, body: { email: 'boss@corp.test' } }));
    assert.equal(shared.body.invited, true);
    assert.equal((await request(`/api/dashboards/${body.dashboard.id}`, { as: squatter })).status, 404);
});

test('security headers are set', async () => {
    const res = await request('/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
    assert.ok(res.headers.get('referrer-policy'));
});

test('the assistant shares the capture quota with the "Capture now" button', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'CAM1' });
    const { allExecutors } = require('../src/agent/tools');
    for (let i = 0; i < 3; i++) {
        await request('/api/user/camera/capture', { method: 'POST', as: owner, body: { deviceSerial: 'CAM1' } });
    }
    const result = await allExecutors.trigger_capture_snapshot({
        deviceSerial: 'CAM1', userId: String(owner._id), user: { id: String(owner._id), role: 'manager' }, addAction: () => {}
    });
    assert.match(result.error || '', /several times/);
});

test('chat input is bounded', async () => {
    const user = await createUser();
    const long = await request('/api/ai/chat', { method: 'POST', as: user, body: { message: 'x'.repeat(4001) } });
    assert.equal(long.status, 400);
    const ctx = await request('/api/ai/chat', { method: 'POST', as: user, body: { message: 'hi', uiContext: { blob: 'y'.repeat(9000) } } });
    assert.equal(ctx.status, 400);
});

test('camera serials must be plain alphanumerics', async () => {
    const owner = await createUser({ role: 'manager' });
    for (const deviceSerial of ['../etc', 'AB/CD12', 'A B12345', 'x'.repeat(40)]) {
        const res = await request('/api/user/add-camera', { method: 'POST', as: owner, body: { deviceSerial, validateCode: 'ABCDEF' } });
        assert.equal(res.status, 400, deviceSerial);
    }
});
