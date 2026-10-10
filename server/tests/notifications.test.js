const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ALICE, BOB, store, sentMails, resetStore, bearer, cookie, flush, startApp } = require('./helpers');
const notificationService = require('../src/services/notificationService');
const { alertEmail } = require('../src/services/emailTemplates');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });
beforeEach(() => resetStore());

test('pest alert fires only at or above the camera owner threshold', async () => {
    assert.equal((await notificationService.checkPestThreshold('CAMA', 14)).length, 0);
    const [created] = await notificationService.checkPestThreshold('CAMA', 15);
    assert.equal(created.type, 'pest_threshold');
    assert.equal(created.severity, 'critical');
    assert.deepEqual(created.params, { deviceName: 'Mango Lot A', count: 15, threshold: 15 });
});

test('each owner of a shared camera gets their own alert with their own threshold', async () => {
    store.cameras.push({ userId: BOB, deviceSerial: 'CAMA', deviceName: 'Bob view', alertThreshold: 50 });
    const created = await notificationService.checkPestThreshold('CAMA', 20);
    assert.deepEqual(created.map(n => String(n.userId)), [ALICE]);
});

test('cooldown suppresses repeats of the same alert', async () => {
    assert.equal((await notificationService.checkPestThreshold('CAMA', 30)).length, 1);
    assert.equal((await notificationService.checkPestThreshold('CAMA', 40)).length, 0);
    // A different type is not affected
    assert.equal((await notificationService.cameraStatusChanged('CAMA', 0)).length, 1);
});

test('alert emails go only to verified users who opted in', async () => {
    await notificationService.checkPestThreshold('CAMA', 20);
    await flush();
    assert.equal(sentMails.length, 1);
    assert.match(sentMails[0].subject, /20 insects at Mango Lot A/);

    resetStore();
    store.users.get(ALICE).emailVerified = false;
    await notificationService.checkPestThreshold('CAMA', 20);
    assert.equal(sentMails.length, 0, 'unverified address gets no alert email');
    assert.equal(store.notifications.length, 1, 'in-app notification is still created');

    resetStore();
    store.users.get(ALICE).notificationPrefs.email = false;
    await notificationService.checkPestThreshold('CAMA', 20);
    assert.equal(sentMails.length, 0, 'opted-out user gets no alert email');
});

test('"back online" is in-app only', async () => {
    await notificationService.cameraStatusChanged('CAMA', 1);
    assert.equal(store.notifications[0].type, 'camera_online');
    assert.equal(sentMails.length, 0);
});

test('AI failure alert needs several failures in a row; a success resets the count', async () => {
    const { AI_FAILURE_THRESHOLD } = notificationService;
    for (let i = 1; i < AI_FAILURE_THRESHOLD; i++) {
        assert.equal((await notificationService.recordAiResult('CAMA', false)).length, 0);
    }
    await notificationService.recordAiResult('CAMA', true);
    for (let i = 1; i < AI_FAILURE_THRESHOLD; i++) await notificationService.recordAiResult('CAMA', false);
    assert.equal(store.notifications.length, 0);
    const [alert] = await notificationService.recordAiResult('CAMA', false);
    assert.equal(alert.type, 'ai_failure');
    assert.equal(alert.params.failures, AI_FAILURE_THRESHOLD);
});

test('pest counts exclude non-pest detections', () => {
    assert.equal(notificationService.countPests({ fruit_fly: 7, moth: 2, person: 1, car: 3 }), 9);
    assert.equal(notificationService.countPests(new Map([['fruit_fly', 4]])), 4);
    assert.equal(notificationService.countPests(null), 0);
});

test('alert email escapes camera names and keeps the subject on one line', () => {
    const mail = alertEmail({
        user: { email: 'a@example.test', name: 'A' },
        language: 'en',
        type: 'pest_threshold',
        params: { deviceName: '<img src=x onerror=alert(1)>\r\nBcc: victim@example.test', count: 20, threshold: 15 },
        url: 'https://app.example.test/dashboard'
    });
    assert.ok(!mail.html.includes('<img src=x'));
    assert.ok(mail.html.includes('&lt;img src=x'));
    assert.ok(!/[\r\n]/.test(mail.subject));
});

test('notification API is scoped to the signed-in user', async () => {
    await notificationService.checkPestThreshold('CAMA', 20);

    const alice = await (await app.request('/api/notifications', { headers: bearer(ALICE) })).json();
    assert.equal(alice.notifications.length, 1);
    assert.equal(alice.unreadCount, 1);

    const bob = await (await app.request('/api/notifications', { headers: bearer(BOB) })).json();
    assert.equal(bob.notifications.length, 0);

    // Bob cannot mark Alice's notification as read
    const id = String(alice.notifications[0].id);
    await app.request('/api/notifications/read', { method: 'POST', headers: bearer(BOB), body: { ids: [id] } });
    assert.equal(store.notifications[0].read, false);

    const marked = await (await app.request('/api/notifications/read', { method: 'POST', headers: bearer(ALICE), body: { ids: [id] } })).json();
    assert.equal(marked.unreadCount, 0);
});

test('mark-read validates its input', async () => {
    for (const body of [{}, { ids: [] }, { ids: ['not-an-id'] }, { ids: [{ $ne: null }] }]) {
        const res = await app.request('/api/notifications/read', { method: 'POST', headers: bearer(ALICE), body });
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    const all = await app.request('/api/notifications/read', { method: 'POST', headers: bearer(ALICE), body: { all: true } });
    assert.equal(all.status, 200);
});

test('SSE stream requires auth and delivers new notifications live', async () => {
    assert.equal((await app.request('/api/notifications/stream')).status, 401);

    const controller = new AbortController();
    const res = await fetch(app.base + '/api/notifications/stream', { headers: cookie(ALICE), signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    await notificationService.checkPestThreshold('CAMA', 25);

    let received = '';
    const deadline = Date.now() + 2000;
    while (!received.includes('event: notification') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
    }
    controller.abort();
    assert.match(received, /event: notification/);
    assert.match(received, /"type":"pest_threshold"/);
});

test('camera alert threshold can be updated and is validated', async () => {
    const ok = await app.request('/api/user/camera', { method: 'PUT', headers: bearer(ALICE), body: { deviceSerial: 'CAMA', alertThreshold: 30 } });
    assert.equal(ok.status, 200);
    assert.equal(store.cameras[0].alertThreshold, 30);

    for (const alertThreshold of [0, 2.5, '20', 100000]) {
        const bad = await app.request('/api/user/camera', { method: 'PUT', headers: bearer(ALICE), body: { deviceSerial: 'CAMA', alertThreshold } });
        assert.equal(bad.status, 400, String(alertThreshold));
    }
});
