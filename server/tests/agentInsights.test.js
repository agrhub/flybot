const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const { allExecutors, allFunctionDeclarations } = require('../src/agent/tools');
const weatherService = require('../src/services/weatherService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const dayAgo = (n) => dayKeyOf(Date.now() - n * DAY_MS);
const run = (name, user, args = {}) => allExecutors[name]({ ...args, userId: user._id, user });

// A sticky trap catching `before` flies a day the week before last, then `after` a day
async function catches(serial, before, after) {
    const docs = [];
    let count = 0;
    for (let i = 15; i >= 0; i--) {
        count += i > 6 ? before : after;
        docs.push({ deviceSerial: serial, day: dayAgo(i), scans: 4, total: count, peak: count, min: 0, species: [] });
    }
    await models.DailyStat.insertMany(docs);
}

test('the three insight tools are declared and wired', () => {
    for (const name of ['get_treatment_effectiveness', 'compare_farms', 'get_weather_outlook']) {
        assert.ok(allFunctionDeclarations.some(d => d.name === name), name);
        assert.equal(typeof allExecutors[name], 'function', name);
    }
});

test('treatment effectiveness and farm comparison answer from the user\'s own data', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    const mango = await models.Farm.create({ ownerId: owner._id, name: 'Mango farm' });
    const theirs = await models.Farm.create({ ownerId: other._id, name: 'Not yours' });
    const plot = await models.Plot.create({ farmId: mango._id, name: 'Plot A' });
    await createCamera(owner, { deviceSerial: 'M1', farmId: mango._id, plotId: plot._id });
    await createCamera(other, { deviceSerial: 'X1', farmId: theirs._id });
    await catches('M1', 6, 2);
    await catches('X1', 6, 2);
    const at = new Date(Date.now() - 7 * DAY_MS);
    await models.Treatment.create({ cameraSerials: ['M1'], type: 'spray', at, product: 'Radiant 60SC', activeIngredient: 'Spinetoram' });
    await models.Treatment.create({ cameraSerials: ['X1'], type: 'spray', at, product: 'Hidden', activeIngredient: 'Hidden' });

    const effect = await run('get_treatment_effectiveness', owner);
    assert.deepEqual(effect.ingredients.map(g => g.activeIngredient), ['Spinetoram']);
    assert.equal(effect.ingredients[0].uses, 1);
    assert.ok(effect.ingredients[0].averageChangePct < 0, 'fewer flies after');

    const farms = await run('compare_farms', owner, { days: 7 });
    assert.equal(farms.periodDays, 7);
    assert.deepEqual(farms.farms.map(f => f.farm), ['Mango farm']);
    assert.equal(farms.farms[0].fliesPerTrapPerDay, 2);
    assert.equal(farms.farms[0].previousPeriod, 6);
    assert.equal(farms.farms[0].worstPlot.plot, 'Plot A');

    const none = await run('compare_farms', await createUser({ role: 'manager' }));
    assert.match(none.note, /No farms/);
});

test('the weather outlook uses the traps\' location, by farm on request', async () => {
    const owner = await createUser({ role: 'manager' });
    const farm = await models.Farm.create({ ownerId: owner._id, name: 'Hoa Loc' });
    await createCamera(owner, { deviceSerial: 'A1', farmId: farm._id, latitude: 10.3, longitude: 106.1 });
    const today = dayKeyOf(Date.now());
    const temps = [];
    for (let i = -20; i <= 5; i++) temps.push({ day: dayKeyOf(Date.now() + i * DAY_MS), min: 25, max: 32, humidity: 85, rain: 3, forecast: i > 0 });
    const original = weatherService.getDailyTemperatures;
    weatherService.getDailyTemperatures = async () => temps;
    try {
        const outlook = await run('get_weather_outlook', owner);
        assert.equal(outlook.days.length, 3);
        assert.ok(outlook.days.every(d => d.day > today && d.suitsFruitFlies));
        assert.equal(outlook.level, 'elevated');
        assert.equal((await run('get_weather_outlook', owner, { farm: 'hoa loc' })).days.length, 3, 'farm names match regardless of case');
        assert.match((await run('get_weather_outlook', owner, { farm: 'Nowhere' })).error, /No farm named "Nowhere"\. Farms: Hoa Loc/);
    } finally {
        weatherService.getDailyTemperatures = original;
    }
    const noGps = await createUser({ role: 'manager' });
    await createCamera(noGps, { deviceSerial: 'N1' });
    assert.match((await run('get_weather_outlook', noGps)).note, /GPS/);
});
