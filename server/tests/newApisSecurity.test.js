const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const ENDPOINTS = [
    ['GET', '/api/farms/compare'],
    ['GET', '/api/treatments/effectiveness'],
    ['GET', '/api/treatments/withholding'],
    ['POST', '/api/treatments/vietgap/send']
];

test('the new summaries need a signed-in user', async () => {
    for (const [method, path] of ENDPOINTS) {
        assert.equal((await request(path, { method })).status, 401, `${method} ${path}`);
    }
});

test('nobody sees another farm\'s figures, treatments or intervals', async () => {
    const owner = await createUser({ role: 'manager' });
    const stranger = await createUser({ role: 'manager' });
    const viewer = await createUser();
    const farm = await models.Farm.create({ ownerId: owner._id, name: 'Secret farm' });
    await createCamera(owner, { deviceSerial: 'S1', farmId: farm._id });
    await models.Treatment.create({ cameraSerials: ['S1'], type: 'spray', at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), product: 'Secret product', activeIngredient: 'Secret ingredient', preHarvestDays: 7 });

    for (const user of [stranger, viewer]) {
        const compare = await json(await request('/api/farms/compare', { as: user }));
        assert.equal(compare.status, 200);
        assert.deepEqual(compare.body.farms, []);
        const effect = await json(await request('/api/treatments/effectiveness', { as: user }));
        assert.deepEqual(effect.body.ingredients, []);
        const withholding = await json(await request('/api/treatments/withholding', { as: user }));
        assert.deepEqual(withholding.body.treatments, []);
        // Naming the camera does not help
        assert.equal((await request('/api/treatments/effectiveness?deviceSerial=S1', { as: user })).status, 403);
    }
    // The owner sees all of it
    const own = await json(await request('/api/treatments/effectiveness', { as: owner }));
    assert.deepEqual(own.body.ingredients.map(g => g.name), ['Secret ingredient']);
});

test('the farm comparison and the ingredient table are rate-limited per person', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    let last;
    for (let i = 0; i < 31; i++) last = await request('/api/farms/compare?days=7', { as: owner });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
    // Per person: someone else is not affected
    assert.equal((await request('/api/farms/compare?days=7', { as: other })).status, 200);
});
