const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const farmService = require('../src/services/farmService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

async function setup() {
    const owner = await createUser({ role: 'manager', email: 'owner@example.test' });
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test', language: 'en' });
    const other = await createUser({ role: 'manager', email: 'other@example.test' });
    await createCamera(owner, { deviceSerial: 'CAM1', deviceName: 'Trap 1', alertThreshold: 10 });
    await createCamera(owner, { deviceSerial: 'CAM2', deviceName: 'Trap 2', alertThreshold: 10 });
    await createCamera(owner, { deviceSerial: 'CAM3', deviceName: 'Trap 3' });
    await createCamera(other, { deviceSerial: 'XCAM' });
    const farm = await json(await request('/api/farms', { method: 'POST', as: owner, body: { name: 'Mango farm' } }));
    const farmId = farm.body.farm.id;
    const plot = await json(await request(`/api/farms/${farmId}/plots`, {
        method: 'POST', as: owner,
        body: { name: 'Plot A', crop: 'Mango', areaHa: 1.5, alertThreshold: 8, boundary: [[10.8, 106.6], [10.81, 106.6], [10.81, 106.61]] }
    }));
    return { owner, viewer, other, farmId, plotId: plot.body.plot.id };
}

const setCameras = (as, farmId, plotId, cameraSerials) =>
    request(`/api/farms/${farmId}/plots/${plotId}/cameras`, { method: 'PUT', as, body: { cameraSerials } });

test('only the owner\'s cameras go into the farm\'s plots', async () => {
    const { owner, farmId, plotId } = await setup();
    assert.equal((await setCameras(owner, farmId, plotId, ['CAM1', 'XCAM'])).status, 400);
    assert.equal((await setCameras(owner, farmId, plotId, ['CAM1', 'CAM2'])).status, 200);
    const cam = await models.Camera.findOne({ deviceSerial: 'CAM1' });
    assert.equal(String(cam.plotId), plotId);
    assert.equal(String(cam.farmId), farmId);

    // Setting the list again removes the ones left out
    await setCameras(owner, farmId, plotId, ['CAM2']);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'CAM1' })).plotId, null);
});

test('sharing a farm gives view access to its cameras, and follows plot changes', async () => {
    const { owner, viewer, farmId, plotId } = await setup();
    await setCameras(owner, farmId, plotId, ['CAM1', 'CAM2']);
    const shared = await json(await request(`/api/farms/${farmId}/share`, { method: 'POST', as: owner, body: { email: 'viewer@example.test' } }));
    assert.equal(shared.body.invited, false);
    assert.equal(await models.Notification.countDocuments({ userId: viewer._id, type: 'farm_shared' }), 1);
    assert.match(sentMails.at(-1).subject, /shared the farm Mango farm/);

    const seen = async () => (await json(await request('/api/user/cameras', { as: viewer }))).body.cameras.map(c => c.deviceSerial).sort();
    assert.deepEqual(await seen(), ['CAM1', 'CAM2']);
    assert.equal((await request(`/api/farms/${farmId}`, { as: viewer })).status, 200);

    // A camera added later is shared too; a camera removed is not any more
    await setCameras(owner, farmId, plotId, ['CAM2', 'CAM3']);
    assert.deepEqual(await seen(), ['CAM2', 'CAM3']);

    // Farm access cannot be removed camera by camera
    const direct = await json(await request('/api/user/camera/share', { method: 'DELETE', as: owner, body: { deviceSerial: 'CAM2', email: 'viewer@example.test' } }));
    assert.equal(direct.body.code, 'VIA_FARM');

    // A direct share survives the farm share ending
    await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'CAM1', email: 'viewer@example.test' } });
    await request(`/api/farms/${farmId}/share`, { method: 'DELETE', as: owner, body: { email: 'viewer@example.test' } });
    assert.deepEqual(await seen(), ['CAM1']);
    assert.equal((await request(`/api/farms/${farmId}`, { as: viewer })).status, 404);
});

test('viewers and other managers cannot change a farm', async () => {
    const { owner, viewer, other, farmId, plotId } = await setup();
    await request(`/api/farms/${farmId}/share`, { method: 'POST', as: owner, body: { email: 'viewer@example.test' } });
    assert.equal((await request(`/api/farms/${farmId}`, { method: 'PUT', as: viewer, body: { name: 'x' } })).status, 403);
    assert.equal((await setCameras(viewer, farmId, plotId, [])).status, 403);
    assert.equal((await request(`/api/farms/${farmId}`, { as: other })).status, 404);
    // Their own farm, in their personal workspace, is fine
    assert.equal((await request('/api/farms', { method: 'POST', as: viewer, body: { name: 'Mine' } })).status, 201);
});

test('plot validation', async () => {
    const { owner, farmId } = await setup();
    const post = (body) => request(`/api/farms/${farmId}/plots`, { method: 'POST', as: owner, body });
    assert.equal((await post({ name: '' })).status, 400);
    assert.equal((await post({ name: 'B', boundary: [[10, 106], [10.1, 106]] })).status, 400, 'two points');
    assert.equal((await post({ name: 'B', boundary: [[95, 106], [10.1, 106], [10, 106.1]] })).status, 400, 'latitude out of range');
    assert.equal((await post({ name: 'B', color: 'red' })).status, 400);
    assert.equal((await post({ name: 'B', alertThreshold: 0 })).status, 400);
    assert.equal((await post({ name: 'B', color: '#ff8800', boundary: [] })).status, 201);
});

test('plot figures and plot alert on the average of its traps', async () => {
    const { owner, viewer, farmId, plotId } = await setup();
    await setCameras(owner, farmId, plotId, ['CAM1', 'CAM2']);
    await request(`/api/farms/${farmId}/share`, { method: 'POST', as: owner, body: { email: 'viewer@example.test' } });
    for (const [serial, count] of [['CAM1', 12], ['CAM2', 6]]) {
        await models.Snapshot.create({ deviceSerial: serial, imageUrl: 'x', s3Key: `snapshots/${serial}/1.jpg`, aiProcessed: true, aiResults: { summary: { fruit_fly: count } } });
    }
    const detail = await json(await request(`/api/farms/${farmId}`, { as: owner }));
    const stats = detail.body.plots[0].stats;
    assert.deepEqual([stats.cameras, stats.latestTotal, stats.latestAverage, stats.latestMax, stats.risk], [2, 18, 9, 12, 'high']);

    const alerts = await farmService.checkPlotThreshold('CAM1');
    assert.equal(alerts.length, 2, 'owner and the person the farm is shared with');
    assert.equal(alerts[0].params.average, 9);
    assert.equal((await farmService.checkPlotThreshold('CAM2')).length, 0, 'cool-down per plot');
    void viewer;
});

test('deleting a plot or the farm leaves the cameras unassigned and unshared', async () => {
    const { owner, viewer, farmId, plotId } = await setup();
    await setCameras(owner, farmId, plotId, ['CAM1']);
    await request(`/api/farms/${farmId}/share`, { method: 'POST', as: owner, body: { email: 'viewer@example.test' } });
    await request(`/api/farms/${farmId}`, { method: 'DELETE', as: owner });
    const cam = await models.Camera.findOne({ deviceSerial: 'CAM1' });
    assert.equal(cam.farmId, null);
    assert.equal(cam.sharedWith.length, 0);
    assert.equal((await json(await request('/api/user/cameras', { as: viewer }))).body.cameras.length, 0);
    assert.equal(await models.Plot.countDocuments(), 0);
});

test('farm invitation is claimed when the address is confirmed', async () => {
    const { owner, farmId, plotId } = await setup();
    await setCameras(owner, farmId, plotId, ['CAM1']);
    const res = await json(await request(`/api/farms/${farmId}/share`, { method: 'POST', as: owner, body: { email: 'newbie@example.test' } }));
    assert.equal(res.body.invited, true);
    await request('/api/auth/register', { method: 'POST', body: { email: 'newbie@example.test', password: 'secret123' } });
    const newbie = await models.User.findOne({ email: 'newbie@example.test' });
    assert.equal((await json(await request('/api/user/cameras', { as: newbie }))).body.cameras.length, 0);
    const verifyMail = sentMails.find(m => m.to === 'newbie@example.test' && /verify-email/.test(m.text));
    const token = new URL(verifyMail.text.match(/https:\/\/app\.example\.test\S+/)[0]).searchParams.get('token');
    await request('/api/auth/verify-email', { method: 'POST', body: { token } });
    assert.equal((await json(await request('/api/user/cameras', { as: newbie }))).body.cameras.length, 1);
    assert.equal((await request(`/api/farms/${farmId}`, { as: newbie })).status, 200);
});

test('map lists plots with a boundary', async () => {
    const { owner, farmId } = await setup();
    await request(`/api/farms/${farmId}/plots`, { method: 'POST', as: owner, body: { name: 'No boundary' } });
    const { body } = await json(await request('/api/farms/map', { as: owner }));
    assert.deepEqual(body.plots.map(p => p.name), ['Plot A']);
    assert.equal(body.plots[0].farmName, 'Mango farm');
});
