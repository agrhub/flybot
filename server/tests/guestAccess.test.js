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

test('what a guest may send: reads, sign-out, the AI diagnosis and the assistant only', () => {
    assert.equal(guestMayRequest('GET', '/api/user/cameras?x=1'), true);
    assert.equal(guestMayRequest('GET', '/api/auth/export'), false);
    assert.equal(guestMayRequest('GET', '/api/integrations/keys'), false);
    assert.equal(guestMayRequest('POST', '/api/auth/logout'), true);
    assert.equal(guestMayRequest('POST', '/api/ai/chat/stream'), true);
    assert.equal(guestMayRequest('POST', '/api/ai/chat/confirm'), false);
    assert.equal(guestMayRequest('POST', '/api/ai/diagnose'), true, 'the dashboard diagnosis only reads');
    assert.equal(guestMayRequest('POST', '/api/ai/analyze-roboflow/abc'), false);
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
    // The agent's console is what judges come for: guests read it, never decide
    const env = require('../src/config/env');
    const wasConsole = env.SENTINEL_CONSOLE;
    env.SENTINEL_CONSOLE = true;
    try {
        const me = await json(await request('/api/auth/me', { headers: withToken(first.body.token) }));
        assert.equal(me.body.user.sentinelEnabled, true);
        assert.equal(me.body.user.sentinelCanDecide, false);
        assert.equal((await request('/api/sentinel/ui/summary', { headers: withToken(first.body.token) })).status, 200);
        assert.equal((await request('/api/sentinel/ui/approvals/64b000000000000000000009/decide', { method: 'POST', headers: withToken(first.body.token), body: { decision: 'approve' } })).status, 403);
    } finally {
        env.SENTINEL_CONSOLE = wasConsole;
    }
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

test('the dashboard AI diagnosis runs for a guest on the demo cameras, and saves nothing', async () => {
    await setup();
    const { token } = (await json(await guestLogin())).body;
    const countAll = async () => {
        const counts = {};
        // The audit log is left out: the sign-in may still be writing to it
        for (const [name, model] of Object.entries(models)) {
            if (name !== 'AuditLog' && typeof model?.countDocuments === 'function') counts[name] = await model.countDocuments();
        }
        return counts;
    };
    const before = await countAll();
    const res = await json(await request('/api/ai/diagnose', { method: 'POST', headers: withToken(token), body: { timeRange: '7d' } }));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(['DEMO1', 'DEMO2'].includes(res.body.diagnosis.peakCamera.deviceSerial), 'the demo traps, not a customer\'s');
    assert.deepEqual(await countAll(), before);
    // A camera the guest cannot see stays refused
    const other = await json(await request('/api/ai/diagnose', { method: 'POST', headers: withToken(token), body: { deviceSerial: 'FARM1' } }));
    assert.equal(other.status, 403);
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

// ---------- Sample reports ----------

test('reports: the simulated farm\'s sample reports are shared with the guest, who reads them and copies the public link', async () => {
    const demoSim = require('../src/services/demoSim');
    const owner = await createUser({ email: demoSim.SYSTEM_EMAIL });
    const org = await models.Organization.create({ simulated: true, name: demoSim.ORG_NAME, kind: 'organization', members: [{ userId: owner._id, email: owner.email, role: 'owner', addedBy: owner._id }] });
    const mango = await models.Farm.create({ simulated: true, ownerId: owner._id, orgId: org._id, name: 'Cái Bè mango orchard (simulated)', description: 'Hòa Lộc mango, Đồng Tháp. Simulated data.' });
    const pomelo = await models.Farm.create({ simulated: true, ownerId: owner._id, orgId: org._id, name: 'Chợ Lách pomelo orchard (simulated)', description: 'Green-skin pomelo, Vĩnh Long. Simulated data.' });
    await createCamera(owner, { deviceSerial: 'SIM-A', simulated: true, platform: 'simulated', orgId: org._id, farmId: mango._id, trapKind: 'sticky', status: 1 });
    await createCamera(owner, { deviceSerial: 'SIM-B', simulated: true, platform: 'simulated', orgId: org._id, farmId: pomelo._id, trapKind: 'lure', status: 1 });
    await settingsService.updateSettings({ guestAccessEnabled: true, demoViewSimulated: true }, null);

    assert.deepEqual(await demoSim.ensureReports({ force: true }), { created: 3, updated: 0 });
    assert.deepEqual(await demoSim.ensureReports({ force: true }), { created: 0, updated: 3 }, 'kept up to date, never doubled');
    assert.equal(await demoSim.ensureReports(), null, 'checked at most every 10 minutes');
    const kinds = await models.Dashboard.findOne({ simKey: 'kinds' }).lean();
    assert.deepEqual(kinds.widgets.filter(w => w.title).map(w => [w.title, w.cameraSerials]), [['Sticky traps', ['SIM-A']], ['Lure traps', ['SIM-B']]]);
    assert.deepEqual((await models.Dashboard.findOne({ simKey: 'mango' }).lean()).cameraSerials, ['SIM-A'], 'mango orchards only');
    assert.equal(kinds.schedule.frequency, 'off', 'nothing is ever sent');

    const h = withToken((await json(await guestLogin())).body.token);
    const list = (await json(await request('/api/dashboards', { headers: h }))).body.dashboards;
    assert.equal(list.length, 3);
    const overview = list.find(d => d.name.startsWith('Weekly'));
    const detail = (await json(await request(`/api/dashboards/${overview.id}`, { headers: h }))).body.dashboard;
    assert.equal(detail.access, 'shared');
    assert.equal(detail.canEdit, false);
    assert.ok(detail.publicToken, 'a shared viewer gets the public link to pass on');
    assert.equal(detail.sharedWith, undefined, 'but not the share list');
    assert.equal((await request(`/api/dashboards/${overview.id}/data`, { headers: h })).status, 200);
    assert.equal((await request(`/api/public/dashboards/${detail.publicToken}`)).status, 200);
    assert.equal((await request(`/api/dashboards/${overview.id}`, { method: 'PUT', headers: h, body: { name: 'Mine' } })).status, 403, 'read-only');
    assert.equal((await request(`/api/dashboards/${overview.id}/share`, { method: 'POST', headers: h, body: { email: 'a@example.test' } })).status, 403);

    const counts = await demoSim.remove({ dryRun: true });
    assert.equal(counts.reports, 3);
});
