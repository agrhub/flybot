const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ALICE, store, resetStore, bearer, startApp } = require('./helpers');
const models = require('../src/models');
const { riskLevel, worstRisk, thresholdOf, moderateFloor } = require('../src/constants/risk');
const { linearFit, forecast, confidenceLevel } = require('../src/services/forecastService');
const { weatherFactor } = require('../src/services/weatherService');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });
beforeEach(() => resetStore());

// ---------- Pure logic ----------

test('risk levels follow the camera threshold', () => {
    assert.equal(moderateFloor(15), 5);
    assert.equal(riskLevel(4, 15), 'low');
    assert.equal(riskLevel(5, 15), 'moderate');
    assert.equal(riskLevel(15, 15), 'high');
    assert.equal(riskLevel(10, 30), 'moderate');
    assert.equal(riskLevel(10, 8), 'high');
    assert.equal(worstRisk(['low', 'high', 'moderate']), 'high');
    assert.equal(worstRisk([]), 'low');
    assert.equal(thresholdOf({}), 15);
    assert.equal(thresholdOf({ alertThreshold: 40 }), 40);
});

test('linear fit recovers a clean trend', () => {
    const fit = linearFit([0, 1, 2, 3, 4].map(i => ({ dayIndex: i, value: 2 + 3 * i })));
    assert.equal(Math.round(fit.slope * 100) / 100, 3);
    assert.equal(Math.round(fit.intercept * 100) / 100, 2);
    assert.equal(Math.round(fit.r2 * 100) / 100, 1);
});

test('forecast extrapolates a rising trend and reports it honestly', () => {
    const points = [7, 8, 9, 10, 11, 12, 13].map((d, i) => ({ dayIndex: d, value: 4 + 2 * i }));
    const result = forecast(points, 14, 7);
    assert.equal(result.trajectory, 'surging');
    assert.equal(result.confidence, 'high');
    assert.equal(result.dataDays, 7);
    assert.ok(result.projected[0] > 16 && result.projected[6] > result.projected[0]);
});

test('with too little history the forecast holds the last value at low confidence', () => {
    const result = forecast([{ dayIndex: 12, value: 3 }, { dayIndex: 13, value: 9 }], 14, 7);
    assert.equal(result.confidence, 'low');
    assert.equal(result.trajectory, 'stable');
    assert.deepEqual(result.projected, [9, 9, 9, 9, 9, 9, 9]);
});

test('noisy data lowers confidence; projections never go negative', () => {
    assert.equal(confidenceLevel(10, 0.1), 'low');
    assert.equal(confidenceLevel(5, 0.4), 'medium');
    const falling = forecast([0, 1, 2, 3, 4].map(i => ({ dayIndex: 9 + i, value: 20 - 5 * i })), 14, 7);
    assert.equal(falling.trajectory, 'declining');
    assert.ok(falling.projected.every(v => v >= 0));
});

test('weather factor classification', () => {
    assert.equal(weatherFactor({ temperature: 29, humidity: 80 }), 'hot_humid');
    assert.equal(weatherFactor({ temperature: 15, humidity: 80 }), 'cool');
    assert.equal(weatherFactor({ temperature: 37, humidity: 60 }), 'very_hot');
    assert.equal(weatherFactor({ temperature: 27, humidity: 40 }), 'dry');
    assert.equal(weatherFactor({ temperature: 22, humidity: 60 }), 'moderate');
    assert.equal(weatherFactor(null), null);
});

// ---------- Diagnosis endpoint ----------

function stubSnapshots({ latestCount, dailyPeaks, topSpecies = 'fruit_fly' }) {
    models.Snapshot.findOne = () => {
        const q = {
            sort: () => q,
            then: (resolve, reject) => Promise.resolve(latestCount === null ? null : { aiResults: { summary: { fruit_fly: latestCount, person: 3 } } }).then(resolve, reject)
        };
        return q;
    };
    let call = 0;
    models.Snapshot.aggregate = async (pipeline) => {
        // "Latest processed snapshot per camera" (services/snapshotQueries.js)
        if (pipeline.some(stage => stage.$group?.summary)) {
            if (latestCount === null) return [];
            const serials = pipeline[0].$match.deviceSerial.$in;
            return serials.map(serial => ({ _id: serial, createdAt: new Date(), summary: { fruit_fly: latestCount, person: 3 } }));
        }
        call++;
        if (call % 2 === 1) {
            // Daily peaks: last N days ending today
            const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
            return dailyPeaks.map((peak, i) => ({
                _id: fmt.format(new Date(Date.now() - (dailyPeaks.length - 1 - i) * 86400000)),
                peak
            }));
        }
        return topSpecies ? [{ _id: topSpecies, total: 42 }] : [];
    };
}

test('diagnosis uses the camera threshold, real counts and no placeholder numbers', async () => {
    store.cameras[0].alertThreshold = 20;
    stubSnapshots({ latestCount: 12, dailyPeaks: [4, 6, 7, 9, 10, 11, 12] });

    const res = await app.request('/api/ai/diagnose', { method: 'POST', headers: bearer(ALICE), body: {} });
    assert.equal(res.status, 200);
    const { diagnosis } = await res.json();

    assert.equal(diagnosis.currentPeakCount, 12, 'non-pest "person" detections are excluded');
    assert.equal(diagnosis.riskLevel, 'moderate');
    assert.equal(diagnosis.riskScore, 60, '12 of threshold 20');
    assert.equal(diagnosis.referenceThreshold, 20);
    assert.equal(diagnosis.dominantPest, 'fruit_fly');
    assert.equal(diagnosis.forecast.trajectory, 'surging');
    assert.equal(diagnosis.forecast.dataDays, 7);
    assert.ok(['low', 'medium', 'high'].includes(diagnosis.forecast.confidence));
    assert.equal(diagnosis.forecast.days.length, 7);
    assert.equal(diagnosis.weather, null, 'no GPS on the camera, so no weather lookup');

    const lure = diagnosis.recommendations.find(r => r.key === 'pheromoneLure');
    assert.equal(lure.urgency, 'urgent', 'moderate + surging');
    assert.deepEqual(lure.targetCameras, ['Mango Lot A']);
    assert.ok(!JSON.stringify(diagnosis).includes('95.8'));
});

test('no detections means no recommendations', async () => {
    stubSnapshots({ latestCount: 0, dailyPeaks: [0, 0, 0], topSpecies: null });
    const { diagnosis } = await (await app.request('/api/ai/diagnose', { method: 'POST', headers: bearer(ALICE), body: {} })).json();
    assert.equal(diagnosis.riskLevel, 'low');
    assert.deepEqual(diagnosis.recommendations, []);
    assert.equal(diagnosis.dominantPest, null);
});

test('high risk triggers the full plan', async () => {
    stubSnapshots({ latestCount: 30, dailyPeaks: [30, 29, 31] });
    const { diagnosis } = await (await app.request('/api/ai/diagnose', { method: 'POST', headers: bearer(ALICE), body: {} })).json();
    assert.equal(diagnosis.riskLevel, 'high');
    assert.equal(diagnosis.riskScore, 100);
    assert.deepEqual(diagnosis.recommendations.map(r => r.key).sort(), ['fieldSanitation', 'fruitBagging', 'pheromoneLure', 'proteinBait']);
});

// ---------- Comparison endpoint ----------

test('comparison: period totals, % change and per-camera ranking', async () => {
    store.cameras.push({ userId: ALICE, deviceSerial: 'CAMB', deviceName: 'Lot B', alertThreshold: 10 });
    models.Snapshot.aggregate = async () => [
        { _id: { serial: 'CAMA', isCurrent: true }, total: 60, scans: 20, peak: 9 },
        { _id: { serial: 'CAMA', isCurrent: false }, total: 40, scans: 20, peak: 6 },
        { _id: { serial: 'CAMB', isCurrent: true }, total: 90, scans: 10, peak: 14 }
    ];
    const res = await app.request('/api/ai/comparison?days=7', { headers: bearer(ALICE) });
    assert.equal(res.status, 200);
    const { comparison } = await res.json();

    assert.equal(comparison.current.totalInsects, 150);
    assert.equal(comparison.previous.totalInsects, 40);
    assert.equal(comparison.change.totalInsects, 275);
    assert.equal(comparison.current.avgPerScan, 5);
    assert.equal(comparison.current.peakCount, 14);

    assert.deepEqual(comparison.cameras.map(c => c.deviceSerial), ['CAMB', 'CAMA'], 'sorted by total');
    const lotB = comparison.cameras[0];
    assert.equal(lotB.riskLevel, 'high', 'peak 14 vs its threshold 10');
    assert.equal(lotB.changePct, null, 'nothing in the previous period to compare with');
    assert.equal(comparison.cameras[1].changePct, 50);
});

test('comparison validates the period', async () => {
    const res = await app.request('/api/ai/comparison?days=9', { headers: bearer(ALICE) });
    assert.equal(res.status, 400);
});
