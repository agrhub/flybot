const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const settingsService = require('../src/services/settingsService');
const { aliasOf } = require('../src/services/demoView');
const { MAX_GUEST_REPORTS, cleanupGuestReports } = require('../src/services/guestAccess');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    settingsService.clearCache();
});

const OPEN = { live: true, playback: true, location: true, device: true, realSerial: true };

/** Two shared cameras: one with its serial shown, one hidden (the owner's home camera). */
async function setup() {
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    await createCamera(owner, { deviceSerial: 'BD1234567', deviceName: 'Bình Dương', status: 1 });
    await createCamera(owner, { deviceSerial: 'ESPA1B2C3D4E5F6', deviceName: 'Vĩnh Long', platform: 'camos', status: 1 });
    await createCamera(owner, { deviceSerial: 'PRIVATE1', deviceName: 'Private' });
    await settingsService.updateSettings({
        guestAccessEnabled: true,
        demoViewShares: [{ deviceSerial: 'BD1234567', ...OPEN }, { deviceSerial: 'ESPA1B2C3D4E5F6', ...OPEN, realSerial: false, location: false }]
    }, null);
    return { owner };
}

const guestSession = async () => {
    const res = await json(await request('/api/auth/guest', { method: 'POST' }));
    return { h: { Authorization: `Bearer ${res.body.token}` }, user: res.body.user };
};
const create = async (h, body) => json(await request('/api/dashboards', { method: 'POST', headers: h, body: { name: 'My report', cameraSerials: ['BD1234567'], widgets: [{ id: 'k', type: 'kpi' }], ...body } }));

test('a guest makes reports on the cameras it sees; other guests never see them', async () => {
    await setup();
    const a = await guestSession();
    const b = await guestSession();
    assert.equal(a.user.capabilities.buildDashboards, true, 'the Reports page offers Create report');

    const made = await create(a.h, { cameraSerials: ['BD1234567', aliasOf('ESPA1B2C3D4E5F6')] });
    assert.equal(made.status, 201);
    assert.equal(made.body.dashboard.canEdit, true);
    assert.deepEqual(made.body.dashboard.cameraSerials, ['BD1234567', aliasOf('ESPA1B2C3D4E5F6')], 'the hidden serial stays hidden');
    const id = made.body.dashboard.id;
    const stored = await models.Dashboard.findById(id).lean();
    assert.ok(stored.guestSession);
    assert.deepEqual(stored.cameraSerials, ['BD1234567', 'ESPA1B2C3D4E5F6']);
    assert.equal((await request(`/api/dashboards/${id}/data`, { headers: a.h })).status, 200);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', headers: a.h, body: { name: 'Renamed' } })).status, 200);

    // Not a camera the guest sees
    const foreign = await create(a.h, { cameraSerials: ['PRIVATE1'] });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.code, 'CAMERA_NOT_FOUND');

    // Another visitor on the same account
    assert.deepEqual((await json(await request('/api/dashboards', { headers: b.h }))).body.dashboards, []);
    assert.equal((await request(`/api/dashboards/${id}`, { headers: b.h })).status, 404);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', headers: b.h, body: { name: 'Mine' } })).status, 404);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'DELETE', headers: b.h })).status, 404);
    assert.equal((await json(await request('/api/dashboards', { headers: a.h }))).body.dashboards.length, 1);

    assert.equal((await request(`/api/dashboards/${id}`, { method: 'DELETE', headers: a.h })).status, 200);
});

test('a few reports per session, never shared by email, sent or scheduled', async () => {
    await setup();
    const a = await guestSession();
    for (let i = 0; i < MAX_GUEST_REPORTS; i++) assert.equal((await create(a.h, { name: `R${i}` })).status, 201);
    const over = await create(a.h, { name: 'One more' });
    assert.equal(over.status, 400);
    assert.equal(over.body.code, 'REPORT_LIMIT');
    // Another session has its own allowance
    assert.equal((await create((await guestSession()).h)).status, 201);

    const id = (await models.Dashboard.findOne({ name: 'R0' }).lean())._id;
    const scheduled = await json(await request(`/api/dashboards/${id}`, { method: 'PUT', headers: a.h, body: { schedule: { frequency: 'weekly' } } }));
    assert.equal(scheduled.status, 400);
    assert.equal(scheduled.body.code, 'GUEST_READ_ONLY');
    const share = await json(await request(`/api/dashboards/${id}/share`, { method: 'POST', headers: a.h, body: { email: 'friend@example.test' } }));
    assert.equal(share.status, 403);
    assert.equal(share.body.code, 'GUEST_READ_ONLY');
    assert.equal((await request(`/api/dashboards/${id}/send`, { method: 'POST', headers: a.h, body: {} })).status, 403);
});

test('a public link only for cameras whose serial visitors may see', async () => {
    await setup();
    const a = await guestSession();
    const hidden = await create(a.h, { cameraSerials: [aliasOf('ESPA1B2C3D4E5F6')], visibility: 'public' });
    assert.equal(hidden.status, 400);
    assert.equal(hidden.body.code, 'PUBLIC_FOREIGN_CAMERA');
    assert.ok(!JSON.stringify(hidden.body).includes('ESPA1B2C3D4E5F6'), 'the error names the alias, not the serial');

    const shown = await create(a.h, { visibility: 'public' });
    assert.equal(shown.status, 201);
    const token = shown.body.dashboard.publicToken;
    assert.ok(token);
    const page = await json(await request(`/api/public/dashboards/${token}`));
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.cameras.map(c => c.deviceSerial), ['BD1234567']);
    assert.equal((await request(`/api/dashboards/${shown.body.dashboard.id}/public-token`, { method: 'POST', headers: a.h })).status, 200);

    // The admin hides that serial later: the link shows nothing of it any more
    await settingsService.updateSettings({ demoViewShares: [{ deviceSerial: 'BD1234567', ...OPEN, realSerial: false }] }, null);
    settingsService.clearCache();
    const after = await json(await request(`/api/public/dashboards/${(await models.Dashboard.findById(shown.body.dashboard.id).lean()).publicToken}`));
    assert.deepEqual(after.body.cameras, []);
});

test('reports end with the session: at sign-out, and by the cleanup once it has expired', async () => {
    await setup();
    const a = await guestSession();
    const b = await guestSession();
    await create(a.h);
    await create(b.h);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: a.h })).status, 200);
    assert.equal(await models.Dashboard.countDocuments({ guestSession: { $exists: true } }), 1, 'signing out removes that session\'s reports only');

    assert.equal(await cleanupGuestReports(), 0, 'a live session keeps its reports');
    await models.Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await cleanupGuestReports(), 1);
    assert.equal(await models.Dashboard.countDocuments({}), 0);

    // Turning guest access off ends them too
    const c = await guestSession();
    await create(c.h);
    await settingsService.updateSettings({ guestAccessEnabled: false }, null);
    assert.equal(await cleanupGuestReports(), 1);
});

test('reports of other accounts are unchanged', async () => {
    const { owner } = await setup();
    const made = await json(await request('/api/dashboards', { method: 'POST', as: owner, body: { name: 'Owner report', cameraSerials: ['PRIVATE1'], visibility: 'public' } }));
    assert.equal(made.status, 201);
    assert.equal((await models.Dashboard.findById(made.body.dashboard.id).lean()).guestSession, undefined);
    const a = await guestSession();
    assert.equal((await request(`/api/dashboards/${made.body.dashboard.id}`, { headers: a.h })).status, 404);
    assert.equal(await cleanupGuestReports(), 0);
    assert.equal(await models.Dashboard.countDocuments({}), 1);
});
