const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const settingsService = require('../src/services/settingsService');
const { aliasOf } = require('../src/services/demoView');
const camos = require('../src/platforms/camos');
const power = require('../src/services/powerHistory');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    settingsService.clearCache();
});

const SERIAL = 'ESPA1B2C3D4E5F6';
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * HOUR);

// A photo with the battery the camera sent with it
const photo = (at, battery) => models.Snapshot.create({
    deviceSerial: SERIAL, imageUrl: `snapshots/${SERIAL}/${SERIAL}_${at.getTime()}.jpg`, s3Key: `snapshots/${SERIAL}/${SERIAL}_${at.getTime()}.jpg`,
    createdAt: at, aiProcessed: true, aiResults: { summary: { fruit_fly: 1 } }, meta: { battery }
});

async function trap(owner, extra = {}) {
    return createCamera(owner, { deviceSerial: SERIAL, deviceName: 'Vĩnh Long', platform: 'camos', status: 1, device: { fw: '0.9.3-rc.3', battery: { mv: 3700, pct: 40 } }, ...extra });
}

const history = async (as, days = 1, serial = SERIAL, headers) => json(await request(`/api/cameras/${serial}/power-history?days=${days}`, { as, headers }));

test('photos and the readings in between make one time series, with charging periods and rates', async () => {
    const owner = await createUser({ role: 'manager' });
    await trap(owner);
    // Draining 20 mV an hour overnight, then a panel that only lifts the input to 3.8 V ("slow")
    await photo(ago(10), { mv: 3800, pct: 50, charging: false, solarMv: 0 });
    await photo(ago(8), { mv: 3760, pct: 47, charging: false, solarMv: 0 });
    await photo(ago(6), { mv: 3720, pct: 44, charging: false, solarMv: 900 });
    await models.PowerReading.create({ deviceSerial: SERIAL, at: ago(4), mv: 3730, pct: 45, charging: true, charge: 'slow', solarMv: 3800, measuredMv: 3950, source: 'telemetry' });
    await models.PowerReading.create({ deviceSerial: SERIAL, at: ago(3), mv: 3740, pct: 46, charging: true, charge: 'slow', solarMv: 3850, source: 'telemetry' });
    await photo(ago(2), { mv: 3735, pct: 45, charging: false, solarMv: 3500 });
    // Outside the range and another camera's: not in the answer
    await photo(ago(30), { mv: 4100, pct: 90 });
    await models.PowerReading.create({ deviceSerial: 'ESPOTHER', at: ago(1), mv: 4000, source: 'telemetry' });

    const res = await history(owner, 1);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.days, 1);
    const { points, charging, rates, summary } = res.body.battery;
    assert.deepEqual(points.map(p => p.mv), [3800, 3760, 3720, 3730, 3740, 3735]);
    assert.deepEqual(points.map(p => p.source), ['photo', 'photo', 'photo', 'telemetry', 'telemetry', 'photo']);
    assert.equal(points[3].measuredMv, 3950);
    assert.equal(points[3].charge, 'slow');
    // One charging period, from the first charging reading to the first one that is not, marked slow
    assert.equal(charging.length, 1);
    assert.equal(new Date(charging[0].from).getTime(), ago(4).getTime());
    assert.equal(new Date(charging[0].to).getTime(), ago(2).getTime());
    assert.equal(charging[0].slow, true);
    // Hourly buckets: -20 mV/h (and -1.5 %/h) overnight
    assert.equal(rates[0].mvPerHour, -20);
    assert.equal(rates[0].pctPerHour, -1.5);
    assert.equal(rates[0].charging, false);
    assert.equal(summary.drainMvPerHour, -20);
    assert.equal(summary.drainPctPerHour, -1.5);
    assert.ok(summary.chargeMvPerHour > 0);
    assert.equal(summary.solarMaxMv, 3850);
    assert.equal(summary.last.mv, 3735);
    assert.equal(summary.hoursLeft, 30);
    assert.equal(summary.chargingHours, 2);

    // A week reaches the older photo; days are clamped to 1..30
    assert.equal((await history(owner, 7)).body.battery.points.length, 7);
    assert.equal((await history(owner, 999)).body.days, 30);
    assert.equal((await history(owner, 'x')).body.days, 1);
});

test('access follows the camera: owner, shares and admins; nobody else', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser();
    const stranger = await createUser({ role: 'manager' });
    const admin = await createUser({ role: 'admin' });
    await trap(owner, { sharedWith: [{ userId: viewer._id, email: viewer.email }] });
    await photo(ago(1), { mv: 3900, pct: 60 });

    for (const who of [owner, viewer, admin]) {
        const res = await history(who);
        assert.equal(res.status, 200);
        assert.equal(res.body.battery.points.length, 1);
    }
    assert.equal((await history(stranger)).status, 404);
    assert.equal((await history(owner, 1, 'ESPNOTMINE01')).status, 404);
    assert.equal((await request(`/api/cameras/${SERIAL}/power-history`)).status, 401);
});

test('demo visitors: only with the device permission, under the camera\'s alias', async () => {
    const owner = await createUser({ role: 'manager' });
    await trap(owner);
    await photo(ago(1), { mv: 3900, pct: 60 });
    const share = async (perms) => {
        settingsService.clearCache();
        await settingsService.updateSettings({ guestAccessEnabled: true, demoViewEnabled: true, demoViewAudience: 'guest', demoViewShares: [{ deviceSerial: SERIAL, live: false, playback: false, location: false, realSerial: false, ...perms }] }, null);
        const { token } = (await json(await request('/api/auth/guest', { method: 'POST' }))).body;
        return { Authorization: `Bearer ${token}` };
    };
    const alias = aliasOf(SERIAL);

    let guest = await share({ device: false });
    assert.equal((await history(null, 1, alias, guest)).status, 404);

    guest = await share({ device: true });
    const res = await history(null, 1, alias, guest);
    assert.equal(res.status, 200);
    assert.equal(res.body.deviceSerial, alias);
    assert.equal(res.body.battery.points[0].mv, 3900);
    assert.ok(!JSON.stringify(res.body).includes(SERIAL));
});

test('telemetry, state and low_power events add readings; the retained shadow and a repeat do not', async () => {
    const owner = await createUser({ role: 'manager' });
    await trap(owner);
    const ts = NOW - 30 * 60 * 1000;
    const telemetry = { v: 7, ts, rssi: -60, battery: { voltage: 3.73, percent: 45, mv: 3730, pct: 45, measuredMv: 3950, charging: true, charge: 'slow', solarMv: 3800 } };
    await camos.handleMessage(`camos/${SERIAL}/telemetry`, telemetry);
    // The camera's battery keeps the raw reading too
    assert.equal((await models.Camera.findOne({ deviceSerial: SERIAL }).lean()).device.battery.measuredMv, 3950);
    await camos.handleMessage(`camos/${SERIAL}/telemetry`, telemetry);
    await camos.handleMessage(`camos/${SERIAL}/shadow/reported`, { battery: { mv: 3999, pct: 70 } });
    // A clock without NTP (uptime ms): FlyBot's time
    await camos.handleMessage(`camos/${SERIAL}/state`, { v: 7, ts: 12000, clock: 'uptime', online: true, battery: { mv: 3725, pct: 44 } });
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 7, type: 'low_power', ts: NOW - 60000, voltage: 3.31, percent: 4, charging: false, critical: true });
    // While charging, low_power's voltage is the lifted reading: not kept
    await camos.handleMessage(`camos/${SERIAL}/event`, { v: 7, type: 'low_power', ts: NOW - 50000, voltage: 3.95, percent: 4, charging: true });

    const readings = await models.PowerReading.find({ deviceSerial: SERIAL }).sort({ at: 1 }).lean();
    assert.deepEqual(readings.map(r => [r.source, r.mv]), [['telemetry', 3730], ['event', 3310], ['state', 3725]]);
    assert.equal(readings[0].at.getTime(), ts);
    assert.equal(readings[0].measuredMv, 3950);
    assert.equal(readings[0].charge, 'slow');
    assert.ok(Math.abs(readings[2].at.getTime() - Date.now()) < 60000);
});

test('helpers: thinning keeps charging changes; rates skip long gaps', () => {
    const points = Array.from({ length: 3000 }, (_, i) => ({ at: new Date(NOW + i * 60000), mv: 3700, charging: i >= 1501 && i < 1503 }));
    const kept = power.thin(points, 100);
    assert.ok(kept.length <= 110);
    assert.ok(kept.some(p => p.charging === true));
    assert.equal(power.chargingSpans(kept).length, 1);

    const rates = power.rates([{ at: ago(30), mv: 4000 }, { at: ago(10), mv: 3700 }, { at: ago(9), mv: 3690 }], 1);
    assert.equal(rates.length, 1);
    assert.equal(rates[0].mvPerHour, -10);
    assert.equal(power.daysOf('7'), 7);
    assert.equal(power.daysOf(0), 1);
});
