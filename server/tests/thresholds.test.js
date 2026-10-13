const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const thresholds = require('../src/services/thresholdService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const dayAgo = (n) => dayKeyOf(Date.now() - n * DAY_MS);

test('the 90th percentile of the daily figures, at least 5, with the alert days it would give', () => {
    const figures = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    assert.equal(thresholds.percentile(figures, 0.9), 18);
    assert.deepEqual(thresholds.suggest(figures, 10), { days: 20, current: 10, suggested: 18, typical: 10, alertDaysCurrent: 11, alertDaysSuggested: 3 });
    assert.equal(thresholds.suggest([1, 1, 2, 1, 2, 1, 1, 2], 15).suggested, 5, 'never below 5');
    assert.equal(thresholds.suggest([3, 4, 5], 15).suggested, null, 'fewer than 7 days: no suggestion');
});

test('suggestions for the cameras the user can change, on each trap kind\'s own figure', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser();
    await createCamera(owner, { deviceSerial: 'STICK', alertThreshold: 15 });
    await createCamera(owner, { deviceSerial: 'LURE', alertThreshold: 15, trapKind: 'lure' });
    await createCamera(owner, { deviceSerial: 'SHARED', sharedWith: [{ userId: viewer._id, email: viewer.email }] });
    const docs = [];
    for (let i = 0; i < 20; i++) {
        docs.push({ deviceSerial: 'STICK', day: dayAgo(i), scans: 10, total: 100, peak: 10 + i, min: 0, species: [] });   // card counts 10..29
        docs.push({ deviceSerial: 'LURE', day: dayAgo(i), scans: 10, total: 10 * (1 + i), peak: 99, min: 0, species: [] }); // 1..20 per photo
    }
    docs.push({ deviceSerial: 'STICK', day: dayAgo(40), scans: 10, total: 100, peak: 500, min: 0, species: [] });     // too old
    await models.DailyStat.insertMany(docs);

    const res = await json(await request('/api/user/cameras/threshold-suggestions', { as: owner }));
    assert.equal(res.status, 200);
    const by = Object.fromEntries(res.body.suggestions.map(s => [s.deviceSerial, s]));
    assert.equal(by.STICK.basis, 'cardCount');
    assert.equal(by.STICK.suggested, 27);
    assert.equal(by.STICK.alertDaysCurrent, 15);
    assert.equal(by.LURE.basis, 'dailyAverage');
    assert.equal(by.LURE.suggested, 18, 'the average per photo, not the card count');
    assert.equal(by.SHARED.suggested, null);

    // Someone who can only view a camera gets nothing to change
    const viewed = await json(await request('/api/user/cameras/threshold-suggestions', { as: viewer }));
    assert.deepEqual(viewed.body.suggestions, []);
    assert.equal((await request('/api/user/cameras/threshold-suggestions')).status, 401);
});
