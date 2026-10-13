const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const weatherService = require('../src/services/weatherService');
const { dayDegrees, computeDegreeDays, forCameras, GENERATION_DD } = require('../src/services/degreeDayService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const TODAY = '2026-06-15';
const addDays = (key, n) => new Date(new Date(`${key}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);

// Constant weather from 31 days ago to 16 days ahead: (min + max) / 2 - 12 degree-days a day
function weather(min, max, today = TODAY) {
    const temps = [];
    for (let i = -31; i <= 16; i++) temps.push({ day: addDays(today, i), min, max, forecast: i > 0 });
    return temps;
}

test('degree-days of a day: base 12 °C, cut off at 35 °C', () => {
    assert.equal(dayDegrees(22, 32), 15);
    assert.equal(dayDegrees(8, 14), 0);
    assert.equal(dayDegrees(30, 40), 20.5);
});

test('next wave: generation time from the last big catch', () => {
    // 21.5 dd a day: 350 dd reached on day 17. Peak 10 days ago -> next adults in 7 days
    const catchesByDay = new Map([[addDays(TODAY, -20), 6], [addDays(TODAY, -10), 30], [addDays(TODAY, -2), 3]]);
    const model = computeDegreeDays({ temps: weather(32, 42), catchesByDay, today: TODAY });
    assert.equal(model.avgDailyDd, 21.5);
    assert.equal(model.generationDays, Math.round(GENERATION_DD / 21.5));
    assert.deepEqual(model.anchor, { day: addDays(TODAY, -10), catches: 30 });
    assert.equal(model.accumulated, 215);
    assert.equal(model.progressPct, 61);
    assert.equal(model.nextWave.date, addDays(TODAY, 7));
    assert.equal(model.nextWave.inDays, 7);
    assert.equal(model.nextWave.generation, 1);
    assert.equal(model.nextWave.estimated, false);
    assert.equal(model.days.length, 14 + 16);
});

test('cool weather pushes the wave past the forecast; no big catch, no wave', () => {
    const catchesByDay = new Map([[TODAY, 8]]);
    const cool = computeDegreeDays({ temps: weather(14, 20), catchesByDay, today: TODAY });
    // 5 dd a day: 70 days
    assert.equal(cool.nextWave.inDays, 70);
    assert.equal(cool.nextWave.estimated, true);

    const quiet = computeDegreeDays({ temps: weather(25, 31), catchesByDay: new Map([[TODAY, 2]]), today: TODAY });
    assert.equal(quiet.anchor, null);
    assert.equal(quiet.nextWave, null);
    assert.equal(quiet.generationDays, 22);
});

test('an old peak points at a later generation; a wave just due still shows', () => {
    // 23 dd a day: generation 1 on day 16, generation 2 on day 31
    const old = computeDegreeDays({ temps: weather(35, 40), catchesByDay: new Map([[addDays(TODAY, -30), 12]]), today: TODAY });
    assert.deepEqual([old.nextWave.generation, old.nextWave.inDays], [2, 1]);
    const due = computeDegreeDays({ temps: weather(35, 40), catchesByDay: new Map([[addDays(TODAY, -17), 12]]), today: TODAY });
    assert.deepEqual([due.nextWave.generation, due.nextWave.inDays], [1, -1]);
});

test('from the cameras: catches from the rollup, location from GPS', async () => {
    const original = weatherService.getDailyTemperatures;
    weatherService.getDailyTemperatures = async () => weather(32, 42, dayKeyOf(new Date()));
    try {
        const owner = await createUser({ role: 'manager' });
        const noGps = await createCamera(owner, { deviceSerial: 'NOGPS' });
        assert.equal(await forCameras([noGps]), null);

        const cam = await createCamera(owner, { deviceSerial: 'GPS', latitude: 10.8, longitude: 106.6 });
        // Sticky-card count: 0, 0, 25 (a jump 6 days ago), then flat
        const peaks = [0, 0, 25, 25, 25, 25, 25, 25, 25];
        await models.DailyStat.insertMany(peaks.map((peak, i) => ({
            deviceSerial: 'GPS', day: dayKeyOf(Date.now() - (peaks.length - 1 - i) * DAY_MS), scans: 3, total: peak, peak, min: 0, species: []
        })));
        const model = await forCameras([cam]);
        assert.equal(model.anchor.catches, 25);
        assert.equal(model.anchor.day, dayKeyOf(Date.now() - 6 * DAY_MS));
        assert.equal(model.nextWave.inDays, 17 - 6);
    } finally {
        weatherService.getDailyTemperatures = original;
    }
});
