const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');

// Keys must be in place before the config is loaded
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.test';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const notificationService = require('../src/services/notificationService');

// Record pushes instead of sending them; endpoints listed in `gone` answer 410
const sent = [];
const gone = new Set();
webpush.sendNotification = async (subscription, body, options) => {
    if (gone.has(subscription.endpoint)) {
        const err = new Error('Gone');
        err.statusCode = 410;
        throw err;
    }
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body), options });
    return { statusCode: 201 };
};

before(startDb);
after(stopDb);
beforeEach(async () => {
    sent.length = 0;
    gone.clear();
    await clearDb();
});

const FCM = 'https://fcm.googleapis.com/fcm/send/device-1';
const subscription = (endpoint = FCM) => ({ endpoint, keys: { p256dh: 'BPublicKeyOfTheBrowser', auth: 'authSecret' } });
const subscribe = (as, sub = subscription()) => request('/api/push/subscriptions', { method: 'POST', as, body: { subscription: sub } });

async function waitFor(check) {
    for (let i = 0; i < 50; i++) {
        if (await check()) return true;
        await new Promise(r => setTimeout(r, 20));
    }
    return false;
}

test('config exposes the public key only', async () => {
    const user = await createUser();
    const { body } = await json(await request('/api/push/config', { as: user }));
    assert.equal(body.enabled, true);
    assert.equal(body.publicKey, keys.publicKey);
    assert.ok(!JSON.stringify(body).includes(keys.privateKey));
    assert.equal((await request('/api/push/config')).status, 401);
});

test('only real push services are accepted as endpoints', async () => {
    const user = await createUser();
    for (const endpoint of [
        'http://fcm.googleapis.com/fcm/send/x',
        'https://127.0.0.1/steal',
        'https://evil.example/fcm.googleapis.com',
        'https://fcm.googleapis.com.evil.example/x',
        'https://fcm.googleapis.com:8443/x',
        'not a url'
    ]) {
        assert.equal((await subscribe(user, subscription(endpoint))).status, 400, endpoint);
    }
    assert.equal((await subscribe(user, { endpoint: FCM, keys: { p256dh: 'x<y', auth: 'a' } })).status, 400);
    for (const endpoint of [FCM, 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QGx', 'https://wns2-par02p.notify.windows.com/w/?token=abc']) {
        assert.equal((await subscribe(user, subscription(endpoint))).status, 200, endpoint);
    }
    assert.equal(await models.PushSubscription.countDocuments({ userId: user._id }), 4);
});

test('a device moves to the account that subscribes from it', async () => {
    const first = await createUser();
    const second = await createUser();
    await subscribe(first);
    await subscribe(second);
    const subs = await models.PushSubscription.find({ endpoint: FCM });
    assert.equal(subs.length, 1);
    assert.equal(String(subs[0].userId), String(second._id));

    // Someone else cannot remove my device
    await request('/api/push/subscriptions', { method: 'DELETE', as: first, body: { endpoint: FCM } });
    assert.equal(await models.PushSubscription.countDocuments(), 1);
    await request('/api/push/subscriptions', { method: 'DELETE', as: second, body: { endpoint: FCM } });
    assert.equal(await models.PushSubscription.countDocuments(), 0);
});

test('pest alerts are pushed in the user language; expired devices are removed', async () => {
    const owner = await createUser({ role: 'manager', language: 'vi' });
    await createCamera(owner, { deviceSerial: 'CAM1', deviceName: 'Lô A', alertThreshold: 10 });
    await subscribe(owner);
    await subscribe(owner, subscription('https://fcm.googleapis.com/fcm/send/old-phone'));
    gone.add('https://fcm.googleapis.com/fcm/send/old-phone');

    await notificationService.checkPestThreshold('CAM1', 12);
    assert.ok(await waitFor(() => sent.length === 1));
    const [{ payload, options }] = sent;
    assert.equal(payload.type, 'pest_threshold');
    assert.match(payload.title, /Lô A/);
    assert.match(payload.body, /12/);
    assert.equal(payload.url, '/analytics');
    assert.equal(payload.tag, 'pest_threshold:CAM1');
    assert.equal(options.urgency, 'high');
    assert.ok(await waitFor(async () => (await models.PushSubscription.countDocuments()) === 1), 'the 410 device is dropped');
});

test('"back online" stays in-app; disabled accounts get nothing', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'CAM1' });
    await subscribe(owner);
    await notificationService.notifyUser({ userId: owner._id, type: 'camera_online', deviceSerial: 'CAM1', params: { deviceName: 'x' } });
    await models.User.updateOne({ _id: owner._id }, { $set: { disabled: true } });
    await notificationService.notifyUser({ userId: owner._id, type: 'camera_offline', deviceSerial: 'CAM1', params: { deviceName: 'x' } });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(sent.length, 0);
});

test('test push and cleanup when an admin disables an account', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ language: 'en' });
    await subscribe(user);
    const res = await json(await request('/api/push/test', { method: 'POST', as: user }));
    assert.equal(res.body.delivered, 1);
    assert.match(sent[0].payload.title, /FlyBot/);

    await request(`/api/admin/users/${user._id}`, { method: 'PUT', as: admin, body: { disabled: true } });
    assert.equal(await models.PushSubscription.countDocuments({ userId: user._id }), 0);
});
