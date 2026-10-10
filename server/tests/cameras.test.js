const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ALICE, BOB, store, resetStore, bearer, startApp } = require('./helpers');
const models = require('../src/models');
const ezvizService = require('../src/services/ezvizService');
const { dueSerials, deviceSchedules, isDaytime } = require('../src/services/captureSchedule');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const disableCalls = [];
beforeEach(() => {
    resetStore();
    disableCalls.length = 0;
    ezvizService.disableLiveAddress = async (args) => { disableCalls.push(args); return { code: '200' }; };
    let n = 0;
    ezvizService.getLiveAddress = async () => ({
        responseData: { code: '200', data: { url: 'https://example.test/live.m3u8', id: `stream-${++n}` } },
        token: 'ez-token',
        areaDomain: 'https://open.example.test'
    });
});

// ---------- Capture schedule (pure) ----------

// 10:00 and 22:00 in Vietnam (UTC+7)
const DAY = new Date('2026-10-10T03:00:00Z');
const NIGHT = new Date('2026-10-10T15:00:00Z');
const minutesAgo = (now, m) => new Date(now.getTime() - m * 60 * 1000);

test('daytime window uses Vietnam local time', () => {
    assert.equal(isDaytime(DAY), true);
    assert.equal(isDaytime(NIGHT), false);
});

test('a camera is due once its interval has passed', () => {
    const cams = [
        { deviceSerial: 'A', captureIntervalMinutes: 30, lastCaptureAt: minutesAgo(DAY, 31) },
        { deviceSerial: 'B', captureIntervalMinutes: 60, lastCaptureAt: minutesAgo(DAY, 31) },
        { deviceSerial: 'C', captureIntervalMinutes: 15, lastCaptureAt: null },
        { deviceSerial: 'D', captureIntervalMinutes: 30, lastCaptureAt: minutesAgo(DAY, 29) } // within tolerance
    ];
    assert.deepEqual(dueSerials(cams, DAY).sort(), ['A', 'C', 'D']);
});

test('daytime-only cameras are skipped at night', () => {
    const cams = [
        { deviceSerial: 'A', captureIntervalMinutes: 30, captureDaytimeOnly: true, lastCaptureAt: null },
        { deviceSerial: 'B', captureIntervalMinutes: 30, captureDaytimeOnly: false, lastCaptureAt: null }
    ];
    assert.deepEqual(dueSerials(cams, NIGHT), ['B']);
    assert.deepEqual(dueSerials(cams, DAY).sort(), ['A', 'B']);
});

test('a shared device uses the most frequent interval and captures at night if any owner wants it', () => {
    const merged = deviceSchedules([
        { deviceSerial: 'S', captureIntervalMinutes: 60, captureDaytimeOnly: true },
        { deviceSerial: 'S', captureIntervalMinutes: 15, captureDaytimeOnly: false }
    ]).get('S');
    assert.equal(merged.intervalMinutes, 15);
    assert.equal(merged.daytimeOnly, false);
});

test('invalid stored intervals fall back to the default', () => {
    assert.equal(deviceSchedules([{ deviceSerial: 'X', captureIntervalMinutes: 7 }]).get('X').intervalMinutes, 30);
});

// ---------- Streams ----------

test('opening a stream never disables every stream of the device', async () => {
    const res = await app.request('/api/live', { method: 'POST', headers: bearer(ALICE), body: { deviceSerial: 'CAMA' } });
    assert.equal(res.status, 200);
    assert.equal(disableCalls.length, 0, 'no previous stream known, so nothing is disabled');
});

test('switching streams only closes the same viewer\'s previous stream', async () => {
    store.cameras.push({ userId: BOB, deviceSerial: 'CAMA', deviceName: 'Shared', validateCode: '', status: 1 });

    // Sessions live in server memory across tests: start counting after Alice's first open
    await app.request('/api/live', { method: 'POST', headers: bearer(ALICE), body: { deviceSerial: 'CAMA' } }); // stream-1
    disableCalls.length = 0;
    await app.request('/api/live', { method: 'POST', headers: bearer(BOB), body: { deviceSerial: 'CAMA' } });   // stream-2
    assert.equal(disableCalls.length, 0, 'Bob opening the camera does not touch Alice\'s stream');

    await app.request('/api/live', { method: 'POST', headers: bearer(ALICE), body: { deviceSerial: 'CAMA' } }); // stream-3
    assert.deepEqual(disableCalls.map(c => c.urlId), ['stream-1'], 'Alice re-opening closes only her own stream');

    await app.request('/api/live/disable', { method: 'POST', headers: bearer(BOB), body: { deviceSerial: 'CAMA' } });
    assert.deepEqual(disableCalls.map(c => c.urlId), ['stream-1', 'stream-2']);
});

// ---------- Settings, health, capture ----------

test('capture schedule settings are validated', async () => {
    const ok = await app.request('/api/user/camera', {
        method: 'PUT', headers: bearer(ALICE),
        body: { deviceSerial: 'CAMA', captureIntervalMinutes: 60, captureDaytimeOnly: true }
    });
    assert.equal(ok.status, 200);
    assert.equal(store.cameras[0].captureIntervalMinutes, 60);
    assert.equal(store.cameras[0].captureDaytimeOnly, true);

    for (const body of [{ captureIntervalMinutes: 45 }, { captureIntervalMinutes: '30' }, { captureDaytimeOnly: 'yes' }]) {
        const bad = await app.request('/api/user/camera', { method: 'PUT', headers: bearer(ALICE), body: { deviceSerial: 'CAMA', ...body } });
        assert.equal(bad.status, 400, JSON.stringify(body));
    }
});

test('health reports 24h capture and AI success per camera', async () => {
    models.Snapshot.aggregate = async (pipeline) => {
        if (pipeline.some(stage => stage.$sort)) return [{ _id: 'CAMA', lastSnapshotAt: new Date('2026-10-10T02:00:00Z') }];
        return [{ _id: 'CAMA', total: 48, analyzed: 45 }];
    };
    const res = await app.request('/api/user/cameras/health', { headers: bearer(ALICE) });
    assert.equal(res.status, 200);
    const { health } = await res.json();
    assert.equal(health.length, 1);
    assert.equal(health[0].snapshots24h, 48);
    assert.equal(health[0].aiSuccessRate, 94);

    const bob = await (await app.request('/api/user/cameras/health', { headers: bearer(BOB) })).json();
    assert.deepEqual(bob.health, []);
});

test('capture now requires owning the camera', async () => {
    const res = await app.request('/api/user/camera/capture', { method: 'POST', headers: bearer(BOB), body: { deviceSerial: 'CAMA' } });
    assert.equal(res.status, 404);
});
