const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const webhookService = require('../src/services/webhookService');
const orgService = require('../src/services/orgService');
const { runOnce, cardRemindersOffForExisting } = require('../src/services/migrations');

before(startDb);
after(stopDb);
beforeEach(clearDb);

test('webhook URLs: IPv6 forms of internal addresses are refused', () => {
    for (const url of ['https://[::ffff:127.0.0.1]/', 'https://[::ffff:169.254.169.254]/', 'https://[::7f00:1]/',
        'https://[64:ff9b::7f00:1]/', 'https://[fec0::1]/', 'https://[2002:7f00:1::]/', 'https://[fd00::1]/']) {
        assert.equal(webhookService.urlProblem(url), 'The URL must be a public address.', url);
    }
    assert.equal(webhookService.isPrivateAddress('2606:4700::1111'), false);
});

test('an organization manager runs the camera but cannot take it or give it away', async () => {
    const owner = await createUser({ role: 'manager' });
    const manager = await createUser({ role: 'manager', email: 'boss2@example.test' });
    const org = await orgService.createOrg(owner, 'Owner Co');
    await createCamera(owner, { deviceSerial: 'OWNED1', orgId: org._id });
    org.members.push({ userId: manager._id, email: manager.email, role: 'manager' });
    await org.save();
    await orgService.syncOrgShares(org);

    // Day to day: allowed (threshold change)
    const update = await request('/api/user/update-camera', { method: 'POST', as: manager, body: { deviceSerial: 'OWNED1', alertThreshold: 20 } });
    assert.equal(update.status, 200);

    // Taking it: moving it into the manager's own organization, sharing it out, deleting it
    const own = await json(await request('/api/orgs', { method: 'POST', as: manager, body: { name: 'Mine' } }));
    assert.equal((await request(`/api/orgs/${own.body.organization.id}/cameras`, { method: 'PUT', as: manager, body: { add: ['OWNED1'] } })).status, 403);
    assert.equal((await request('/api/user/camera/share', { method: 'POST', as: manager, body: { deviceSerial: 'OWNED1', email: 'x@example.test' } })).status, 404);
    assert.equal((await request('/api/user/delete-camera', { method: 'DELETE', as: manager, body: { deviceSerial: 'OWNED1' } })).status, 404);
    assert.ok(await models.Camera.exists({ deviceSerial: 'OWNED1', orgId: org._id }));
});

test('the organization migration runs once; existing cameras start with card reminders off', async () => {
    const manager = await createUser({ role: 'manager' });
    await createCamera(manager, { deviceSerial: 'OLD1' });
    await models.Camera.collection.updateOne({ deviceSerial: 'OLD1' }, { $unset: { cardReminderDays: '' } });

    await runOnce('card-reminders-existing-off', cardRemindersOffForExisting);
    await runOnce('organizations-v1', () => orgService.migrateToOrganizations());
    assert.equal((await models.Camera.findOne({ deviceSerial: 'OLD1' }).lean()).cardReminderDays, 0);

    // The owner takes the camera out of the organization; a restart does not put it back
    await models.Camera.updateOne({ deviceSerial: 'OLD1' }, { $set: { orgId: null } });
    assert.equal(await runOnce('organizations-v1', () => orgService.migrateToOrganizations()), null);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'OLD1' }).lean()).orgId, null);
});

test('an admin transfer moves the camera to the new owner\'s organization', async () => {
    const admin = await createUser({ role: 'admin' });
    const from = await createUser({ role: 'manager' });
    const to = await createUser({ role: 'manager', email: 'newowner@example.test' });
    const member = await createUser({ email: 'm@example.test' });
    const oldOrg = await orgService.createOrg(from, 'Old');
    const newOrg = await orgService.createOrg(to, 'New');
    await createCamera(from, { deviceSerial: 'MOVEME', orgId: oldOrg._id });
    oldOrg.members.push({ userId: member._id, email: member.email, role: 'member' });
    await oldOrg.save();
    await orgService.syncOrgShares(oldOrg);

    const res = await request('/api/admin/cameras/MOVEME/owner', { method: 'PUT', as: admin, body: { email: 'newowner@example.test', keepPreviousOwnerAccess: false } });
    assert.equal(res.status, 200);
    const camera = await models.Camera.findOne({ deviceSerial: 'MOVEME' }).lean();
    assert.equal(String(camera.orgId), String(newOrg._id));
    assert.deepEqual(camera.sharedWith.map(sh => sh.email), [], 'the old organization\'s members lost it');
});
