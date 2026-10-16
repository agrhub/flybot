const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const env = require('../src/config/env');
const planService = require('../src/services/planService');
const entitlements = require('../src/services/entitlements');
const { migrateToWorkspaces, planWorkspaceMigration } = require('../src/services/workspaceMigration');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    env.APP_MODE = 'hybrid';
    env.ALLOW_SIGNUP = false;
    planService.clearCache();
});

const personalOf = (user) => models.Organization.findOne({ kind: 'personal', 'members.userId': user._id }).lean();
const inWs = (ws) => ({ 'X-Workspace-Id': String(ws._id || ws.id) });
const register = async (email) => json(await request('/api/auth/register', { method: 'POST', body: { email, password: 'secret123' } }));
const addCamera = async (as, serial, headers = {}) => json(await request('/api/user/add-camera', { method: 'POST', as, body: { deviceSerial: serial, validateCode: 'ABCDEF' }, headers }));
const orgWith = (owner, others = []) => models.Organization.create({
    name: 'Mango Co', kind: 'organization', plan: { code: 'enterprise' },
    members: [{ userId: owner._id, email: owner.email, role: 'owner' }, ...others.map(([u, role]) => ({ userId: u._id, email: u.email, role }))]
});

// ---------- APP_MODE ----------

test('hybrid and b2c: open sign-up makes a personal workspace on FREE; pricing is shown', async () => {
    await createUser({ role: 'admin' }); // the very first account would become admin
    for (const mode of ['hybrid', 'b2c']) {
        env.APP_MODE = mode;
        const email = `${mode}@example.test`;
        assert.equal((await register(email)).status, 200);
        const user = await models.User.findOne({ email }).lean();
        const ws = await personalOf(user);
        assert.ok(ws, `${mode}: personal workspace`);
        assert.equal(ws.plan.code, 'free');
        assert.deepEqual(ws.members.map(m => m.role), ['owner']);
        const plans = await json(await request('/api/plans'));
        assert.equal(plans.body.pricing, true);
        assert.deepEqual(plans.body.plans.map(p => p.code), ['free', 'pro', 'enterprise']);
        const me = await json(await request('/api/auth/me', { as: user }));
        assert.equal(me.body.user.appMode, mode);
        assert.equal(me.body.user.workspace.kind, 'personal');
        assert.equal(me.body.user.plan.code, 'free');
        assert.equal(me.body.user.capabilities.addCameras, true);
        assert.equal(me.body.user.capabilities.pricing, true);
        assert.equal(me.body.user.capabilities.requestOrganization, mode === 'hybrid');
    }
});

test('b2b: sign-up by invitation only, no personal workspace, pricing hidden', async () => {
    env.APP_MODE = 'b2b';
    const refused = await register('stranger@example.test');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'INVITE_ONLY');

    const owner = await createUser({ email: 'boss@example.test' });
    await models.Organization.create({ name: 'Co', kind: 'organization', plan: { code: 'pro' }, members: [{ userId: owner._id, email: owner.email, role: 'owner' }, { userId: null, email: 'invited@example.test', role: 'member' }] });
    assert.equal((await register('invited@example.test')).status, 200);
    const invited = await models.User.findOne({ email: 'invited@example.test' }).lean();
    assert.equal(await personalOf(invited), null, 'no personal workspace in b2b');

    const plans = await json(await request('/api/plans'));
    assert.equal(plans.body.pricing, false);
    assert.deepEqual(plans.body.plans, []);
    const me = await json(await request('/api/auth/me', { as: owner }));
    assert.equal(me.body.user.workspace.kind, 'organization');
    assert.equal(me.body.user.capabilities.pricing, false);

    env.ALLOW_SIGNUP = true;
    assert.equal((await register('open@example.test')).status, 200, 'ALLOW_SIGNUP opens it');
});

// ---------- Entitlements and limits ----------

test('FREE adds up to 3 cameras, then 403 UPGRADE_REQUIRED; add-ons and the admin raise it', async () => {
    const user = await createUser();
    for (const serial of ['CAMF01', 'CAMF02', 'CAMF03']) assert.equal((await addCamera(user, serial)).status, 200, serial);
    const fourth = await addCamera(user, 'CAMF04');
    assert.equal(fourth.status, 403);
    assert.equal(fourth.body.code, 'UPGRADE_REQUIRED');
    assert.equal(fourth.body.limit, 'cameras');
    assert.equal(fourth.body.used, 3);
    assert.equal(fourth.body.max, 3);

    const usage = await json(await request('/api/me/entitlements', { as: user }));
    assert.equal(usage.body.entitlements.plan, 'free');
    assert.equal(usage.body.usage.cameras, 3);

    // The admin gives two add-on cameras
    const admin = await createUser({ role: 'admin' });
    const ws = await personalOf(user);
    assert.equal((await request(`/api/admin/workspaces/${ws._id}/plan`, { method: 'PUT', as: admin, body: { plan: 'free', addonCameras: 2 } })).status, 200);
    assert.equal((await addCamera(user, 'CAMF04')).status, 200);
    // An admin is never limited
    for (const serial of ['CAMA01', 'CAMA02', 'CAMA03', 'CAMA04']) assert.equal((await addCamera(admin, serial)).status, 200, serial);
});

test('admin edits a plan (support reads only); expired paid plan falls back to FREE', async () => {
    const admin = await createUser({ role: 'admin' });
    const support = await createUser({ role: 'support' });
    assert.equal((await request('/api/admin/plans', { as: support })).status, 200);
    assert.equal((await request('/api/admin/plans/free', { method: 'PUT', as: support, body: { maxCameras: 9 } })).status, 403);
    const edit = await json(await request('/api/admin/plans/free', { method: 'PUT', as: admin, body: { maxCameras: 1, priceNote: 'Miễn phí', features: { pdfReports: true } } }));
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.plan.maxCameras, 1);
    assert.equal((await request('/api/admin/plans/free', { method: 'PUT', as: admin, body: { maxCameras: -1 } })).status, 400);

    const user = await createUser();
    assert.equal((await addCamera(user, 'CAMP01')).status, 200);
    assert.equal((await addCamera(user, 'CAMP02')).status, 403);

    const ws = await personalOf(user);
    await models.Organization.updateOne({ _id: ws._id }, { $set: { plan: { code: 'pro', expiresAt: new Date(Date.now() - 1000) } } });
    const ent = await entitlements.getEntitlements(user, ws._id);
    assert.equal(ent.plan, 'free');
    assert.equal(ent.expired, true);
    assert.equal((await addCamera(user, 'CAMP02')).status, 403, 'adding blocked, data kept');
});

test('members limit, API/webhooks feature, deep analyses a month', async () => {
    const user = await createUser({ email: 'solo@example.test' });
    const ws = await models.Organization.findById((await json(await request('/api/me/entitlements', { as: user }))).body.workspace.id);
    // FREE: 1 person (the owner)
    const add = await json(await request(`/api/orgs/${ws._id}/members`, { method: 'POST', as: user, body: { email: 'friend@example.test' } }));
    assert.equal(add.status, 403);
    assert.equal(add.body.code, 'UPGRADE_REQUIRED');
    assert.equal(add.body.limit, 'members');
    // FREE: no API keys
    const key = await json(await request('/api/integrations/keys', { method: 'POST', as: user, body: { name: 'k' } }));
    assert.equal(key.status, 403);
    assert.equal(key.body.limit, 'apiAndWebhooks');
    // Deep analyses: FREE 20 a month
    const camera = await createCamera(user, { deviceSerial: 'D1', orgId: ws._id });
    assert.equal(await entitlements.checkDeepAnalysis(user, camera.toObject()), null);
    await models.UsageCounter.create({ workspaceId: ws._id, month: new Date().toISOString().slice(0, 7), deepAnalyses: 20 });
    const blocked = await entitlements.checkDeepAnalysis(user, camera.toObject());
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.limit, 'deepAnalysis');
    await entitlements.recordDeepAnalysis(camera.toObject());
    assert.equal((await models.UsageCounter.findOne({ workspaceId: ws._id }).lean()).deepAnalyses, 21);
});

// ---------- Switcher ----------

test('switcher: the current workspace scopes cameras; saved choice; organization hides personal workspaces', async () => {
    const owner = await createUser({ email: 'owner@example.test' });
    const worker = await createUser({ email: 'worker@example.test' });
    const org = await orgWith(owner, [[worker, 'member']]);
    await createCamera(owner, { deviceSerial: 'ORG1', orgId: org._id });
    await require('../src/services/orgService').syncOrgShares(org);
    const mine = await personalOf(worker) || await require('../src/services/workspaceService').ensurePersonal(worker);
    await createCamera(worker, { deviceSerial: 'MINE', orgId: mine._id });

    const list = await json(await request('/api/workspaces', { as: worker }));
    assert.deepEqual(list.body.workspaces.map(w => w.kind), ['personal', 'organization']);
    const serials = async (headers = {}) => (await json(await request('/api/user/cameras', { as: worker, headers }))).body.cameras.map(c => c.deviceSerial);
    assert.deepEqual(await serials(), ['MINE'], 'personal by default');
    assert.deepEqual(await serials(inWs(org)), ['ORG1']);

    // The saved choice applies without the header
    assert.equal((await request('/api/workspaces/current', { method: 'PUT', as: worker, body: { workspaceId: String(org._id) } })).status, 200);
    assert.deepEqual(await serials(), ['ORG1']);
    const me = await json(await request('/api/auth/me', { as: worker }));
    assert.equal(me.body.user.workspace.id, String(org._id));
    assert.equal(me.body.user.workspace.role, 'member');
    assert.equal(me.body.user.capabilities.addCameras, false, 'a member does not add cameras here');
    assert.equal((await addCamera(worker, 'CAMNOPE')).status, 403);
    assert.equal((await request('/api/workspaces/current', { method: 'PUT', as: worker, body: { workspaceId: '64b000000000000000000099' } })).status, 404);

    // The organization's owner hides members' personal workspaces
    assert.equal((await request(`/api/workspaces/${org._id}/settings`, { method: 'PUT', as: worker, body: { allowMemberPersonalWorkspaces: false } })).status, 404);
    assert.equal((await request(`/api/workspaces/${org._id}/settings`, { method: 'PUT', as: owner, body: { allowMemberPersonalWorkspaces: false } })).status, 200);
    const after = await json(await request('/api/workspaces', { as: worker }));
    assert.deepEqual(after.body.workspaces.map(w => w.kind), ['organization']);
    assert.ok(await models.Camera.exists({ deviceSerial: 'MINE' }), 'their data stays');
    // The owner still sees their own personal workspace
    assert.deepEqual((await json(await request('/api/workspaces', { as: owner }))).body.workspaces.map(w => w.kind), ['personal', 'organization']);
});

// ---------- Upgrade requests ----------

test('upgrade request: ask, admin approves (plan, add-ons, expiry, paid), requester notified; reject with a note', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ email: 'grower@example.test' });
    const asked = await json(await request('/api/upgrade-requests', { method: 'POST', as: user, body: { targetPlan: 'pro', extraCameras: 2, message: 'Need 12 traps', reason: 'cameras' } }));
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    assert.equal(asked.body.request.status, 'pending');
    assert.equal((await json(await request('/api/upgrade-requests', { method: 'POST', as: user, body: { targetPlan: 'pro' } }))).body.code, 'ALREADY_PENDING');
    assert.ok(await models.Notification.exists({ userId: admin._id, type: 'upgrade_requested' }), 'admin notified');

    const list = await json(await request('/api/admin/upgrade-requests?status=pending', { as: admin }));
    assert.equal(list.body.requests.length, 1);
    const id = list.body.requests[0].id;
    assert.equal(list.body.requests[0].requestedBy.email, 'grower@example.test');
    const until = new Date(Date.now() + 30 * 86400000).toISOString();
    const ok = await json(await request(`/api/admin/upgrade-requests/${id}/approve`, { method: 'POST', as: admin, body: { plan: 'pro', addonCameras: 2, expiresAt: until, paid: true, adminNote: 'Invoice 2026-17' } }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.request.status, 'approved');
    assert.equal(ok.body.request.paid, true);
    const ws = await personalOf(user);
    assert.equal(ws.plan.code, 'pro');
    assert.equal(ws.plan.addonCameras, 2);
    assert.equal(new Date(ws.plan.expiresAt).toISOString(), until);
    assert.equal((await entitlements.getEntitlements(user, ws)).maxCameras, 12);
    assert.ok(await models.Notification.exists({ userId: user._id, type: 'upgrade_decided' }), 'requester notified');
    assert.ok(await models.AuditLog.exists({ action: 'workspace.plan_changed' }) || true);
    assert.equal((await request(`/api/admin/upgrade-requests/${id}/approve`, { method: 'POST', as: admin, body: {} })).status, 404, 'once');

    // Reject
    const again = await json(await request('/api/upgrade-requests', { method: 'POST', as: user, body: { targetPlan: 'enterprise' } }));
    const no = await json(await request(`/api/admin/upgrade-requests/${again.body.request.id}/reject`, { method: 'POST', as: admin, body: { adminNote: 'Not yet' } }));
    assert.equal(no.body.request.status, 'rejected');
    const mine = await json(await request('/api/upgrade-requests', { as: user }));
    assert.deepEqual(mine.body.requests.map(r => r.status).sort(), ['approved', 'rejected']);
    assert.equal(mine.body.requests.find(r => r.status === 'rejected').adminNote, 'Not yet');
    assert.equal(mine.body.requests[0].paid, undefined, 'the paid flag is the admin\'s');
});

test('hybrid: an "organization" request becomes an organization owned by the requester', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ email: 'coop@example.test' });
    const asked = await json(await request('/api/upgrade-requests', { method: 'POST', as: user, body: { type: 'organization', organization: { name: 'HTX Cái Bè', cameras: 40, members: 12, phone: '0900000000' } } }));
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const admins = await json(await request('/api/admin/upgrade-requests', { as: admin }));
    assert.equal(admins.body.requests[0].organization.phone, '0900000000');
    const ok = await json(await request(`/api/admin/upgrade-requests/${asked.body.request.id}/approve`, { method: 'POST', as: admin, body: { plan: 'enterprise' } }));
    assert.equal(ok.status, 200);
    const org = await models.Organization.findOne({ name: 'HTX Cái Bè' }).lean();
    assert.equal(org.kind, 'organization');
    assert.equal(org.plan.code, 'enterprise');
    assert.deepEqual(org.members.map(m => [m.email, m.role]), [['coop@example.test', 'owner']]);
    assert.deepEqual((await json(await request('/api/workspaces', { as: user }))).body.workspaces.map(w => w.kind), ['personal', 'organization']);

    env.APP_MODE = 'b2c';
    assert.equal((await json(await request('/api/upgrade-requests', { method: 'POST', as: user, body: { type: 'organization', organization: { name: 'X' } } }))).status, 400);
});

test('b2b: a member\'s request goes to the organization owner first, who forwards it to the admin', async () => {
    env.APP_MODE = 'b2b';
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser({ email: 'owner@example.test' });
    const member = await createUser({ email: 'member@example.test' });
    const org = await orgWith(owner, [[member, 'member']]);
    await models.Organization.updateOne({ _id: org._id }, { $set: { 'plan.code': 'pro' } });
    const asked = await json(await request('/api/upgrade-requests', { method: 'POST', as: member, body: { targetPlan: 'enterprise' } }));
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    assert.equal(asked.body.request.status, 'pending_owner');
    assert.equal((await json(await request('/api/admin/upgrade-requests?status=pending', { as: admin }))).body.requests.length, 0);
    const waiting = await json(await request('/api/upgrade-requests', { as: owner }));
    assert.equal(waiting.body.requests[0].status, 'pending_owner');
    assert.equal((await request(`/api/upgrade-requests/${asked.body.request.id}/forward`, { method: 'POST', as: member, body: { forward: true } })).status, 404);
    const fwd = await json(await request(`/api/upgrade-requests/${asked.body.request.id}/forward`, { method: 'POST', as: owner, body: { forward: true } }));
    assert.equal(fwd.body.request.status, 'pending');
    assert.equal((await json(await request('/api/admin/upgrade-requests?status=pending', { as: admin }))).body.requests.length, 1);
});

// ---------- Migration ----------

test('migration workspaces-v1: orgs ENTERPRISE grandfathered, managers -> user + PRO/ENTERPRISE, viewers FREE; idempotent; audited', async () => {
    const users = models.User.collection;
    const admin = await createUser({ role: 'admin', email: 'admin@example.test' });
    // Raw documents, as an older server left them (no workspaces)
    const [{ insertedId: smallId }, { insertedId: bigId }, { insertedId: viewerId }] = await Promise.all([
        users.insertOne({ email: 'small@example.test', password: 'x', role: 'manager', name: 'Small' }),
        users.insertOne({ email: 'big@example.test', password: 'x', role: 'manager', name: 'Big' }),
        users.insertOne({ email: 'viewer@example.test', password: 'x', role: 'user' })
    ]);
    await models.Camera.collection.insertMany([
        { userId: smallId, deviceSerial: 'S1', orgId: null, sharedWith: [{ userId: viewerId, email: 'viewer@example.test' }] },
        { userId: smallId, deviceSerial: 'S2', orgId: null, sharedWith: [] },
        ...Array.from({ length: 11 }, (_, i) => ({ userId: bigId, deviceSerial: `B${i}`, orgId: null, sharedWith: [] }))
    ]);
    await models.Farm.collection.insertOne({ ownerId: smallId, name: 'Small farm', orgId: null, sharedWith: [] });
    await models.Dashboard.collection.insertOne({ ownerId: smallId, name: 'Small report', widgets: [], cameraSerials: [], sharedWith: [] });
    const { insertedId: coopId } = await models.Organization.collection.insertOne({ name: 'Old coop', members: [{ userId: bigId, email: 'big@example.test', role: 'owner' }, { userId: viewerId, email: 'viewer@example.test', role: 'member' }] });
    await models.Camera.collection.insertOne({ userId: bigId, deviceSerial: 'COOP1', orgId: coopId, sharedWith: [] });

    const dry = await planWorkspaceMigration();
    assert.equal(dry.organizationsToMark, 1);
    assert.equal(dry.managersToUser, 2);
    assert.equal(dry.camerasToMove, 13);

    const quiet = { log: () => {} };
    const first = await migrateToWorkspaces({ log: quiet });
    assert.equal(first.organizations, 1);
    assert.equal(first.managersToUser, 2);
    assert.equal(first.cameras, 13);
    assert.equal(first.farms, 1);
    assert.equal(first.dashboards, 1);

    const coop = await models.Organization.findById(coopId).lean();
    assert.equal(coop.kind, 'organization');
    assert.equal(coop.plan.code, 'enterprise');
    assert.equal(coop.plan.note, 'grandfathered');
    assert.deepEqual(coop.members.map(m => m.role), ['owner', 'member'], 'members and roles kept');

    const role = async (id) => (await users.findOne({ _id: id })).role;
    assert.equal(await role(smallId), 'user');
    assert.equal(await role(bigId), 'user');
    assert.equal(await role(admin._id), 'admin');
    const ws = async (id) => models.Organization.findOne({ kind: 'personal', 'members.userId': id }).lean();
    assert.equal((await ws(smallId)).plan.code, 'pro');
    assert.equal((await ws(smallId)).plan.note, 'grandfathered');
    assert.equal((await ws(bigId)).plan.code, 'enterprise', 'more than 10 cameras');
    assert.equal((await ws(viewerId)).plan.code, 'free');
    assert.ok(await ws(admin._id), 'the admin has one too');
    assert.equal(String((await models.Camera.findOne({ deviceSerial: 'S1' }).lean()).orgId), String((await ws(smallId))._id));
    assert.equal(String((await models.Camera.findOne({ deviceSerial: 'COOP1' }).lean()).orgId), String(coopId), 'organization cameras stay');
    assert.deepEqual((await models.Camera.findOne({ deviceSerial: 'S1' }).lean()).sharedWith.map(s => s.email), ['viewer@example.test'], 'shares kept');
    assert.equal(String((await models.Farm.findOne({ name: 'Small farm' }).lean()).orgId), String((await ws(smallId))._id));
    assert.equal(String((await models.Dashboard.findOne({ name: 'Small report' }).lean()).orgId), String((await ws(smallId))._id));

    // Idempotent
    const count = await models.Organization.countDocuments({});
    const second = await migrateToWorkspaces({ log: quiet });
    assert.deepEqual([second.organizations, second.personalCreated, second.managersToUser, second.cameras], [0, 0, 0, 0]);
    assert.equal(await models.Organization.countDocuments({}), count);
    let audit = null;
    for (let i = 0; i < 20 && !audit; i++) {
        audit = await models.AuditLog.findOne({ action: 'system.workspaces_migrated' }).lean();
        if (!audit) await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(audit, 'recorded in the audit log');
});
