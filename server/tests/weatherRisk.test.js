const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const weatherRisk = require('../src/services/weatherRiskService');
const degreeDayService = require('../src/services/degreeDayService');

before(startDb);
after(stopDb);
beforeEach(() => { sentMails.length = 0; return clearDb(); });

const TODAY = '2026-10-13';
const day = (n, extra = {}) => ({ day: `2026-10-${String(13 + n).padStart(2, '0')}`, min: 24, max: 32, humidity: 82, rain: 2, forecast: n > 0, ...extra });

test('which days suit fruit flies', () => {
    assert.equal(weatherRisk.favorable(day(1)), true);                       // mean 28 °C, humid
    assert.equal(weatherRisk.favorable(day(1, { min: 16, max: 24 })), false); // mean 20 °C
    assert.equal(weatherRisk.favorable(day(1, { humidity: 55 })), false);     // dry
    assert.equal(weatherRisk.favorable(day(1, { rain: 35 })), false);         // heavy rain
    assert.equal(weatherRisk.favorable(day(1, { humidity: null, rain: null })), true, 'unknown humidity and rain do not count against it');
});

test('the 3-day outlook: favorable days, and high when a wave is due', () => {
    const temps = [day(-1), day(0), day(1), day(2), day(3, { rain: 40 }), day(4)];
    const plain = weatherRisk.outlook(temps, null, TODAY);
    assert.deepEqual(plain.days.map(d => d.day), ['2026-10-14', '2026-10-15', '2026-10-16'], 'the next three days, not today');
    assert.equal(plain.favorableDays, 2);
    assert.equal(plain.level, 'elevated');
    assert.equal(weatherRisk.outlook(temps, { inDays: 4 }, TODAY).level, 'high');
    assert.equal(weatherRisk.outlook(temps, { inDays: 12 }, TODAY).level, 'elevated', 'a wave far off does not raise it');
    assert.equal(weatherRisk.outlook([day(1), day(2, { min: 15, max: 22 }), day(3, { humidity: 40 })], { inDays: 1 }, TODAY).level, 'low');
    assert.equal(weatherRisk.outlook([day(-1), day(0)], null, TODAY), null, 'no forecast, no outlook');
});

test('the degree-day model carries the outlook', () => {
    const temps = [];
    for (let i = -20; i <= 5; i++) temps.push(day(0, { day: new Date(Date.UTC(2026, 9, 13 + i)).toISOString().slice(0, 10), forecast: i > 0 }));
    const model = degreeDayService.computeDegreeDays({ temps, catchesByDay: new Map(), today: TODAY });
    assert.equal(model.outlook.days.length, 3);
    assert.equal(model.outlook.level, 'elevated');
});

test('farms get a weather warning only when it is high, once a day', async () => {
    const owner = await createUser({ role: 'manager', email: 'owner@example.test', language: 'vi' });
    const viewer = await createUser({ email: 'viewer@example.test' });
    const farm = await models.Farm.create({ ownerId: owner._id, name: 'Vườn Hòa Lộc', sharedWith: [{ userId: viewer._id, email: viewer.email }] });
    const quiet = await models.Farm.create({ ownerId: owner._id, name: 'Quiet farm' });
    await models.Farm.create({ ownerId: owner._id, name: 'No location' });
    await createCamera(owner, { deviceSerial: 'A1', farmId: farm._id, latitude: 10.3, longitude: 106.1 });
    await createCamera(owner, { deviceSerial: 'Q1', farmId: quiet._id, latitude: 10.4, longitude: 106.2 });

    // The model is faked: only the warning logic is under test here
    const original = degreeDayService.forCameras;
    degreeDayService.forCameras = async (cameras) => {
        const high = cameras.some(c => c.deviceSerial === 'A1');
        return {
            nextWave: { date: '2026-10-16', inDays: 3 },
            outlook: weatherRisk.outlook([day(1), day(2, { min: 25, max: 33, humidity: 90 }), day(3, { rain: 30 })], high ? { inDays: 3 } : null, TODAY)
        };
    };
    try {
        assert.deepEqual(await weatherRisk.sendWeatherAlerts(), { farms: 2, warned: 1 });
        const notes = await models.Notification.find({ type: 'weather_risk' }).lean();
        assert.deepEqual(notes.map(n => String(n.userId)).sort(), [String(owner._id), String(viewer._id)].sort());
        assert.deepEqual(notes[0].params, { farmName: 'Vườn Hòa Lộc', farmId: String(farm._id), days: '14/10, 15/10', minTemp: 24, maxTemp: 33, humidity: 90, waveDate: '16/10' });
        assert.match(sentMails.find(m => m.to === 'owner@example.test').subject, /Thời tiết thuận lợi cho ruồi vàng: Vườn Hòa Lộc/);

        // Again the same day: the cool-down holds it back
        assert.deepEqual(await weatherRisk.sendWeatherAlerts(), { farms: 2, warned: 0 });
        assert.equal(await models.Notification.countDocuments({ type: 'weather_risk' }), 2);
    } finally {
        degreeDayService.forCameras = original;
    }
});
