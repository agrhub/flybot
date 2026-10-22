const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const notificationService = require('../src/services/notificationService');
const pushService = require('../src/services/pushService');
const surgeService = require('../src/services/surgeService');
const reportService = require('../src/services/reportService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

// A fixed instant: 2026-05-20 23:30 in Vietnam (UTC+7)
const AT_2330 = new Date('2026-05-20T16:30:00Z');
const AT_1000 = new Date('2026-05-20T03:00:00Z');

test('quiet hours, including ranges past midnight', () => {
    const user = (q) => ({ notificationPrefs: { quietHours: q } });
    assert.equal(notificationService.inQuietHours(user({ enabled: true, start: '21:00', end: '06:00' }), AT_2330), true);
    assert.equal(notificationService.inQuietHours(user({ enabled: true, start: '21:00', end: '06:00' }), AT_1000), false);
    assert.equal(notificationService.inQuietHours(user({ enabled: true, start: '09:00', end: '12:00' }), AT_1000), true);
    assert.equal(notificationService.inQuietHours(user({ enabled: false, start: '21:00', end: '06:00' }), AT_2330), false);
});

test('quiet hours hold back push, not the in-app notification', async () => {
    const pushes = [];
    const originalQueue = pushService.queueNotification;
    const originalEnabled = pushService.isEnabled;
    pushService.queueNotification = (user, payload) => pushes.push(payload);
    pushService.isEnabled = () => true;
    try {
        // A quiet window from an hour ago to an hour from now (farm time)
        const hhmm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
        const sleeper = await createUser({ notificationPrefs: { quietHours: { enabled: true, start: hhmm(new Date(Date.now() - 3600e3)), end: hhmm(new Date(Date.now() + 3600e3)) } } });
        const awake = await createUser();
        for (const user of [sleeper, awake]) {
            await notificationService.notifyUser({ userId: user._id, type: 'camera_offline', deviceSerial: 'CAM1', params: { deviceName: 'x' } });
        }
        assert.equal(await models.Notification.countDocuments({ type: 'camera_offline' }), 2);
        assert.equal(notificationService.inQuietHours(sleeper), true);
        assert.equal(pushes.length, 1, 'only the person outside quiet hours');
    } finally {
        pushService.queueNotification = originalQueue;
        pushService.isEnabled = originalEnabled;
    }
});

test('a muted camera sends that person nothing', async () => {
    const owner = await createUser({ role: 'manager', notificationPrefs: { mutedCameras: ['CAM1'] } });
    const viewer = await createUser({ email: 'v@example.test' });
    await createCamera(owner, { deviceSerial: 'CAM1', alertThreshold: 5 });
    await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'CAM1', email: 'v@example.test' } });
    const created = await notificationService.checkPestThreshold('CAM1', 9);
    assert.deepEqual(created.map(n => String(n.userId)), [String(viewer._id)]);
});

test('the same status change arriving twice at once alerts once', async () => {
    const owner = await createUser({ email: 'twice@example.test' });
    await createCamera(owner, { deviceSerial: 'CAM2', deviceName: 'Twice' });
    // Two overlapping status syncs both saw the camera online
    const results = await Promise.all([notificationService.cameraStatusChanged('CAM2', 0), notificationService.cameraStatusChanged('CAM2', 0)]);
    assert.equal(results.flat().length, 1);
    assert.equal(await models.Notification.countDocuments({ type: 'camera_offline', deviceSerial: 'CAM2' }), 1);
    assert.equal(sentMails.length, 1, 'one email');
});

test('camos: two disconnect events at once set the camera offline with one alert', async () => {
    const owner = await createUser({ email: 'camos-twice@example.test' });
    await createCamera(owner, { deviceSerial: 'ESPAB12CD34EF59', deviceName: 'Trap', platform: 'camos', status: 1, device: { thingName: 'ESPAB12CD34EF59' } });
    const camos = require('../src/platforms/camos');
    const gone = { clientId: 'ESPAB12CD34EF59', timestamp: Date.now(), disconnectReason: 'MQTT_KEEP_ALIVE_TIMEOUT' };
    await Promise.all([camos.handleMessage('$aws/events/presence/disconnected/ESPAB12CD34EF59', gone), camos.handleMessage('$aws/events/presence/disconnected/ESPAB12CD34EF59', gone)]);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await models.Camera.findOne({ deviceSerial: 'ESPAB12CD34EF59' }).lean()).status, 0);
    assert.equal(await models.Notification.countDocuments({ type: 'camera_offline' }), 1);
    assert.equal(sentMails.length, 1);
});

async function rollup(serial, peaks) {
    // peaks[0] = today, peaks[1] = yesterday, ...
    await models.DailyStat.insertMany(peaks.map((peak, i) => ({
        deviceSerial: serial, day: dayKeyOf(Date.now() - i * DAY_MS), scans: 4, total: peak, peak, min: 0, species: []
    })));
}

test('sudden rise: +50% over 3 days on the same card', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'UP', deviceName: 'Rising' });
    await createCamera(owner, { deviceSerial: 'FLAT' });
    await createCamera(owner, { deviceSerial: 'NEWCARD' });
    await rollup('UP', [12, 9, 7, 6]);
    await rollup('FLAT', [7, 7, 6, 6]);
    await rollup('NEWCARD', [12, 3, 20, 6]);
    await models.MaintenanceEvent.create({ deviceSerial: 'NEWCARD', type: 'card_replaced', at: new Date(Date.now() - 2 * DAY_MS) });

    const created = await surgeService.checkSurge('UP');
    assert.equal(created.length, 1);
    assert.deepEqual([created[0].params.previous, created[0].params.count, created[0].params.pct], [6, 12, 100]);
    assert.equal((await surgeService.checkSurge('UP')).length, 0, 'once a day');
    assert.equal(await surgeService.detectSurge('FLAT'), null);
    assert.equal(await surgeService.detectSurge('NEWCARD'), null, 'a new card is not a surge');
});

test('weekly report: catches per day this week vs last, and what needs attention', async () => {
    const owner = await createUser({ role: 'manager', language: 'en' });
    await createCamera(owner, { deviceSerial: 'A', deviceName: 'Plot A', status: 1, cardReplacedAt: new Date(Date.now() - 20 * DAY_MS) });
    await createCamera(owner, { deviceSerial: 'B', deviceName: 'Plot B', status: 0, cardReplacedAt: new Date() });
    // A: cumulative card, +2 a day last week, +5 a day this week (days 1..7 = this week, ending yesterday)
    const peaks = [];
    let count = 0;
    for (let i = 15; i >= 0; i--) {
        if (i >= 1 && i <= 7) count += 5;
        else if (i >= 8) count += 2;
        peaks[i] = count;
    }
    await rollup('A', peaks);
    await models.Treatment.create({ cameraSerials: ['A'], type: 'spray', at: new Date(Date.now() - 2 * DAY_MS), product: 'X' });

    const report = await reportService.buildWeeklyReport(owner);
    assert.equal(report.totals.current, 35);
    assert.equal(report.totals.previous, 14);
    assert.equal(report.totals.changePct, 150);
    assert.deepEqual(report.rising.map(c => c.deviceSerial), ['A']);
    assert.deepEqual(report.cardsDue.map(c => c.deviceSerial), ['A']);
    assert.deepEqual(report.offline.map(c => c.deviceSerial), ['B']);
    assert.equal(report.treatments, 1);

    // "Send me now" goes out by email (verified address)
    const res = await json(await request('/api/notifications/weekly-report', { method: 'POST', as: owner }));
    assert.equal(res.body.sent.email, true);
    assert.match(sentMails.at(-1).subject, /weekly report/);
    assert.match(sentMails.at(-1).text, /Insects caught: 35 \(\+150%\), previous week 14/);
});

test('no cameras, no report; weekly job skips people who turned it off', async () => {
    const lonely = await createUser({ role: 'manager' });
    assert.equal(await reportService.buildWeeklyReport(lonely), null);
    const optedOut = await createUser({ role: 'manager', notificationPrefs: { weeklyReport: false } });
    await createCamera(optedOut, { deviceSerial: 'Z' });
    assert.equal(await reportService.sendWeeklyReports(), 0);
});

test('notification preferences are validated', async () => {
    const user = await createUser();
    const put = (notificationPrefs) => request('/api/auth/profile', { method: 'POST', as: user, body: { notificationPrefs } });
    assert.equal((await put({ quietHours: { enabled: true, start: '25:00' } })).status, 400);
    assert.equal((await put({ weeklyReport: 'yes' })).status, 400);
    assert.equal((await put({ mutedCameras: 'CAM1' })).status, 400);
    const ok = await json(await put({ weeklyReport: false, quietHours: { enabled: true, start: '22:00', end: '05:30' }, mutedCameras: ['CAM1', 'CAM1'] }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.notificationPrefs.weeklyReport, false);
    assert.deepEqual(ok.body.user.notificationPrefs.quietHours, { enabled: true, start: '22:00', end: '05:30' });
    assert.deepEqual(ok.body.user.notificationPrefs.mutedCameras, ['CAM1']);
});
