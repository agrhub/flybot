const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const orgService = require('../src/services/orgService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const cameras = async (user) => (await json(await request('/api/user/cameras', { as: user }))).body.cameras;
const listed = (list) => list.map(c => c.deviceSerial);

async function newOrg(owner, name = 'Mango Co') {
    const res = await json(await request('/api/orgs', { method: 'POST', as: owner, body: { name } }));
    assert.equal(res.status, 201);
    return res.body.organization;
}

test('migration: one organization per manager, holding their cameras and farms', async () => {
    const manager = await createUser({ role: 'manager', name: 'Lan' });
    const viewer = await createUser();
    await createCamera(manager, { deviceSerial: 'M1' });
    await models.Farm.create({ ownerId: manager._id, name: 'Farm A' });
    await createCamera(viewer, { deviceSerial: 'ODD' }); // a "user" cannot own an organization

    assert.equal(await orgService.migrateToOrganizations(), 1);
    assert.equal(await orgService.migrateToOrganizations(), 0, 'idempotent');
    const org = await models.Organization.findOne().lean();
    assert.equal(org.name, 'Lan');
    assert.deepEqual(org.members.map(m => m.role), ['owner']);
    assert.equal(String((await models.Camera.findOne({ deviceSerial: 'M1' })).orgId), String(org._id));
    assert.equal(String((await models.Farm.findOne()).orgId), String(org._id));
    assert.equal((await models.Camera.findOne({ deviceSerial: 'ODD' })).orgId, null);
});

test('members see the organization\'s cameras; managers manage them; removal takes access away', async () => {
    const owner = await createUser({ role: 'manager' });
    const colleague = await createUser({ role: 'manager', email: 'col@example.test' });
    const worker = await createUser({ email: 'worker@example.test' });
    const org = await newOrg(owner);

    // New cameras go into the owner's organization
    const added = await request('/api/user/add-camera', { method: 'POST', as: owner, body: { deviceSerial: 'CAM01', validateCode: 'ABCDEF' } });
    assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
    assert.equal(String((await models.Camera.findOne({ deviceSerial: 'CAM01' })).orgId), org.id);

    await request(`/api/orgs/${org.id}/members`, { method: 'POST', as: owner, body: { email: 'col@example.test', role: 'manager' } });
    const res = await json(await request(`/api/orgs/${org.id}/members`, { method: 'POST', as: owner, body: { email: 'worker@example.test' } }));
    assert.equal(res.body.organization.members.length, 3);
    assert.match(sentMails.at(-1).subject, /Mango Co/);

    assert.deepEqual(listed(await cameras(worker)), ['CAM01']);
    assert.equal((await cameras(colleague))[0].canManage, true, 'organization manager');
    assert.equal((await cameras(worker))[0].canManage, false, 'member only views');

    // A member cannot add people; the colleague (manager) can add members but not owners
    assert.equal((await request(`/api/orgs/${org.id}/members`, { method: 'POST', as: worker, body: { email: 'x@example.test' } })).status, 403);
    assert.equal((await request(`/api/orgs/${org.id}/members`, { method: 'POST', as: colleague, body: { email: 'y@example.test', role: 'owner' } })).status, 403);

    await request(`/api/orgs/${org.id}/members`, { method: 'DELETE', as: owner, body: { email: 'worker@example.test' } });
    assert.deepEqual(listed(await cameras(worker)), []);

    // The last owner cannot leave
    const leave = await json(await request(`/api/orgs/${org.id}/members`, { method: 'DELETE', as: owner, body: { email: owner.email } }));
    assert.equal(leave.body.code, 'LAST_OWNER');
});

test('farms of the organization; moving cameras between organizations', async () => {
    const owner = await createUser({ role: 'manager' });
    const member = await createUser({ email: 'm@example.test' });
    const orgA = await newOrg(owner, 'A');
    const orgB = await newOrg(owner, 'B');
    await createCamera(owner, { deviceSerial: 'MOVE', orgId: orgA.id });
    await request(`/api/orgs/${orgA.id}/members`, { method: 'POST', as: owner, body: { email: 'm@example.test' } });
    await orgService.syncOrgShares(await models.Organization.findById(orgA.id));

    // Farms created now land in the first owned organization (A)
    const farm = await json(await request('/api/farms', { method: 'POST', as: owner, body: { name: 'North' } }));
    const farms = await json(await request('/api/farms', { as: member }));
    assert.deepEqual(farms.body.farms.map(f => f.id), [farm.body.farm.id]);
    assert.equal((await request(`/api/farms/${farm.body.farm.id}`, { method: 'PUT', as: member, body: { name: 'x' } })).status, 403);

    const moved = await json(await request(`/api/orgs/${orgB.id}/cameras`, { method: 'PUT', as: owner, body: { add: ['MOVE'] } }));
    assert.deepEqual(moved.body.organization.cameras.map(c => c.deviceSerial), ['MOVE']);
    const camera = await models.Camera.findOne({ deviceSerial: 'MOVE' }).lean();
    assert.equal(camera.sharedWith.length, 0, 'members of A lost the camera');

    // Someone else's camera cannot be pulled in
    const stranger = await createUser({ role: 'manager' });
    await createCamera(stranger, { deviceSerial: 'NOTMINE' });
    assert.equal((await request(`/api/orgs/${orgB.id}/cameras`, { method: 'PUT', as: owner, body: { add: ['NOTMINE'] } })).status, 403);
});

test('an invited email joins on verification', async () => {
    const owner = await createUser({ role: 'manager' });
    const org = await newOrg(owner);
    await createCamera(owner, { deviceSerial: 'INV', orgId: org.id });
    const res = await json(await request(`/api/orgs/${org.id}/members`, { method: 'POST', as: owner, body: { email: 'later@example.test' } }));
    assert.equal(res.body.invited, true);
    assert.match(sentMails.at(-1).text, /Create an account|Tạo tài khoản/);

    const later = await createUser({ email: 'later@example.test' });
    await require('../src/controllers/shareController').claimPendingShares(later);
    const camera = await models.Camera.findOne({ deviceSerial: 'INV' }).lean();
    assert.deepEqual(camera.sharedWith.map(sh => String(sh.userId)), [String(later._id)]);
});
