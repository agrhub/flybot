const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const settingsService = require('../src/services/settingsService');
const { accessFor } = require('../src/services/demoView');
const { GUEST_EMAIL, GUEST_SESSION_MS, guestMayRequest } = require('../src/services/guestAccess');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    settingsService.clearCache();
});

/** An operator with two demo traps, a customer with a camera of their own, demo access set up. */
async function setup({ guest = true, audience = 'guest' } = {}) {
    const operator = await createUser({ role: 'manager', email: 'operator@example.test' });
    await createCamera(operator, { deviceSerial: 'DEMO1', status: 1 });
    await createCamera(operator, { deviceSerial: 'DEMO2', status: 1 });
    const customer = await createUser({ email: 'farmer@example.test' });
    await createCamera(customer, { deviceSerial: 'FARM1' });
    await settingsService.updateSettings({ demoViewEnabled: true, demoViewCameras: ['DEMO1', 'DEMO2'], demoViewAudience: audience, guestAccessEnabled: guest }, null);
    return { operator, customer };
}

const guestLogin = (ip) => request('/api/auth/guest', { method: 'POST', headers: ip ? { 'X-Forwarded-For': ip } : {} });
const withToken = (token) => ({ Authorization: `Bearer ${token}` });
const serialsOf = async (headers) => (await json(await request('/api/user/cameras', { headers }))).body.cameras.map(c => c.deviceSerial).sort();

// ---------- Rules ----------

test('accessFor: the guest account sees the demo while guest access is on; others by audience', () => {
    const settings = { demoViewEnabled: true, demoViewAudience: 'guest', demoViewCameras: ['A'], guestAccessEnabled: true };
    assert.deepEqual(accessFor({ guest: true }, settings).serials, ['A']);
    assert.deepEqual(accessFor({ guest: true }, { ...settings, guestAccessEnabled: false }).serials, []);
    assert.deepEqual(accessFor({ guest: true }, { ...settings, demoViewEnabled: false }).serials, ['A'], 'guest access alone is enough');
    assert.deepEqual(accessFor({ role: 'user', createdAt: new Date() }, settings).serials, [], 'customers do not see it');
    assert.deepEqual(accessFor({ role: 'user', createdAt: new Date() }, { ...settings, demoViewAudience: 'all' }).serials, ['A']);
});

test('what a guest may send: reads, sign-out and the assistant only', () => {
    assert.equal(guestMayRequest('GET', '/api/user/cameras?x=1'), true);
    assert.equal(guestMayRequest('GET', '/api/auth/export'), false);
    assert.equal(guestMayRequest('GET', '/api/integrations/keys'), false);
    assert.equal(guestMayRequest('POST', '/api/auth/logout'), true);
    assert.equal(guestMayRequest('POST', '/api/ai/chat/stream'), true);
    assert.equal(guestMayRequest('POST', '/api/ai/chat/confirm'), false);
    for (const [method, path] of [['POST', '/api/user/add-camera'], ['PUT', '/api/admin/settings'], ['POST', '/api/auth/profile'], ['DELETE', '/api/user/delete-camera'], ['POST', '/api/dashboards']]) {
        assert.equal(guestMayRequest(method, path), false, `${method} ${path}`);
    }
});

// ---------- Signing in ----------

test('off: no button, and the endpoint refuses', async () => {
    await setup({ guest: false });
    assert.equal((await json(await request('/api/auth/config'))).body.guestAccess, false);
    const res = await json(await guestLogin());
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'GUEST_ACCESS_OFF');
    assert.equal(await models.User.countDocuments({ email: GUEST_EMAIL }), 0);
});

test('on: one shared guest account, a 2-hour session, the demo cameras and nothing else', async () => {
    const { customer } = await setup();
    assert.equal((await json(await request('/api/auth/config'))).body.guestAccess, true);
    const first = await json(await guestLogin());
    assert.equal(first.status, 200);
    assert.ok(first.body.token);
    assert.equal(first.body.user.guest, true);
    const until = new Date(first.body.user.guestUntil).getTime();
    assert.ok(Math.abs(until - (Date.now() + GUEST_SESSION_MS)) < 60 * 1000, 'ends in 2 hours');
    assert.equal(first.body.user.capabilities.addCameras, false);
    assert.equal(first.body.user.capabilities.pricing, false);
    assert.equal(first.body.user.sentinelCanDecide, false);
    const second = await json(await guestLogin());
    assert.equal(second.body.user.id, first.body.user.id, 'the same account');
    assert.equal(await models.User.countDocuments({ email: GUEST_EMAIL }), 1);
    const guest = await models.User.findOne({ email: GUEST_EMAIL }).lean();
    assert.equal(guest.guest, true);
    assert.equal(guest.emailVerified, false);
    assert.equal(guest.notificationPrefs.email, false);

    assert.deepEqual(await serialsOf(withToken(first.body.token)), ['DEMO1', 'DEMO2']);
    // The customer does not see the demo (audience: the guest account only)
    assert.deepEqual(await serialsOf({ Authorization: `Bearer ${require('jsonwebtoken').sign({ id: String(customer._id), v: 0 }, require('../src/config/env').JWT_SECRET)}` }), ['FARM1']);
    assert.equal((await json(await request('/api/auth/config'))).body.demoView, false, 'no sign-up hint for customers');
});

test('read-only: every write is refused, sign-out and the assistant pass', async () => {
    await setup();
    const { token } = (await json(await guestLogin())).body;
    const h = withToken(token);
    const writes = [
        ['POST', '/api/user/add-camera', { deviceSerial: 'NEW1', validateCode: 'ABCDEF' }],
        ['PUT', '/api/user/camera', { deviceSerial: 'DEMO1', deviceName: 'Mine' }],
        ['POST', '/api/auth/profile', { name: 'Hacker' }],
        ['POST', '/api/auth/change-password', { currentPassword: 'x', newPassword: 'yyyyyyyy' }],
        ['POST', '/api/dashboards', { name: 'x' }],
        ['POST', '/api/farms', { name: 'x' }],
        ['POST', '/api/ai/chat/confirm', { sessionId: 's', messageId: 'm', cardIndex: 0, decision: 'confirm' }],
        ['POST', '/api/telegram/link', {}]
    ];
    for (const [method, path, body] of writes) {
        const res = await json(await request(path, { method, headers: h, body }));
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.equal(res.body.code, 'GUEST_READ_ONLY');
    }
    assert.equal((await request('/api/auth/export', { headers: h })).status, 403);
    // Vietnamese for the app
    const vi = await json(await request('/api/farms', { method: 'POST', headers: { ...h, 'X-Language': 'vi' }, body: { name: 'x' } }));
    assert.equal(vi.body.message, 'Tài khoản khách chỉ được xem.');
    const guest = await models.User.findOne({ email: GUEST_EMAIL }).lean();
    assert.equal(guest.name, 'Guest');
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: h })).status, 200);
});

test('chat history is per guest session: visitors never see each other\'s questions', async () => {
    await setup();
    const a = (await json(await guestLogin())).body.token;
    const b = (await json(await guestLogin())).body.token;
    const guest = await models.User.findOne({ email: GUEST_EMAIL }).lean();
    const sessionA = (await models.Session.find({ userId: guest._id }).sort({ createdAt: 1 }).lean())[0];
    const { guestChatSession } = require('../src/services/guestAccess');
    await models.ChatSession.create({ userId: guest._id, sessionId: guestChatSession(sessionA._id, 'main'), messages: [{ id: 'm1', role: 'user', content: 'A asks', at: new Date() }] });
    const historyOf = async (token) => (await json(await request('/api/ai/chat/history?sessionId=main', { headers: withToken(token) }))).body.messages;
    assert.equal((await historyOf(a)).length, 1);
    assert.deepEqual(await historyOf(b), []);
});

test('the session ends after 2 hours, and at once when guest access is turned off', async () => {
    await setup();
    const { token } = (await json(await guestLogin())).body;
    assert.equal((await request('/api/user/cameras', { headers: withToken(token) })).status, 200);
    await models.Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await request('/api/user/cameras', { headers: withToken(token) })).status, 401);

    const fresh = (await json(await guestLogin())).body.token;
    assert.equal((await request('/api/user/cameras', { headers: withToken(fresh) })).status, 200);
    await settingsService.updateSettings({ guestAccessEnabled: false }, null);
    assert.equal((await request('/api/user/cameras', { headers: withToken(fresh) })).status, 401);
});

test('rate limited per address', async () => {
    await setup();
    let last;
    for (let i = 0; i < 21; i++) last = await guestLogin('10.99.0.1');
    assert.equal(last.status, 429);
    assert.equal((await guestLogin('10.99.0.2')).status, 200, 'another address still gets in');
});

test('admin settings: guest access and the audience are validated', async () => {
    const admin = await createUser({ role: 'admin' });
    const put = async (body) => json(await request('/api/admin/settings', { method: 'PUT', as: admin, body }));
    assert.equal((await put({ demoViewAudience: 'everyone' })).status, 400);
    assert.equal((await put({ guestAccessEnabled: 'yes' })).status, 400);
    const saved = await put({ demoViewAudience: 'since', guestAccessEnabled: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.demoViewAudience, 'since');
    assert.equal(saved.body.settings.guestAccessEnabled, true);
});
