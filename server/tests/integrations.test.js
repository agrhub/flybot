const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const axios = require('axios');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const webhookService = require('../src/services/webhookService');
const notificationService = require('../src/services/notificationService');
const { dayKeyOf } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const withKey = (key, path, opts = {}) => request(path, { ...opts, headers: { Authorization: `Bearer ${key}`, ...(opts.headers || {}) } });

async function newKey(user, name = 'ERP') {
    const res = await json(await request('/api/integrations/keys', { method: 'POST', as: user, body: { name } }));
    assert.equal(res.status, 201);
    return res.body.key;
}

test('API key: shown once, stored hashed, read-only access to what its owner sees', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'MINE', deviceName: 'Plot A', alertThreshold: 9 });
    await createCamera(other, { deviceSerial: 'THEIRS' });
    await models.DailyStat.create({ deviceSerial: 'MINE', day: dayKeyOf(new Date()), scans: 3, total: 12, peak: 6, min: 1, species: [{ name: 'fruit_fly', peak: 6, total: 12 }] });

    const key = await newKey(owner);
    assert.match(key, /^fbk_/);
    const stored = await models.ApiKey.findOne().lean();
    assert.equal(stored.hash, crypto.createHash('sha256').update(key).digest('hex'));
    assert.ok(!JSON.stringify(stored).includes(key.slice(12)), 'the key itself is not stored');
    const listed = await json(await request('/api/integrations/keys', { as: owner }));
    assert.equal(listed.body.keys[0].prefix, key.slice(0, 12));
    assert.equal(listed.body.keys[0].key, undefined);

    const cams = await json(await withKey(key, '/api/v1/cameras'));
    assert.deepEqual(cams.body.data.map(c => [c.deviceSerial, c.name, c.alertThreshold]), [['MINE', 'Plot A', 9]]);
    assert.equal((await withKey(key, '/api/v1/cameras/THEIRS')).status, 404);
    const daily = await json(await withKey(key, '/api/v1/cameras/MINE/daily?days=7'));
    assert.deepEqual(daily.body.data.map(d => [d.peak, d.total]), [[6, 12]]);
    assert.equal((await json(await request('/api/v1/me', { headers: { 'X-API-Key': key } }))).body.data.email, owner.email);

    // The key does not open the app's own API, and a revoked key stops working
    assert.equal((await withKey(key, '/api/user/cameras')).status, 401);
    await request(`/api/integrations/keys/${stored._id}`, { method: 'DELETE', as: owner });
    assert.equal((await withKey(key, '/api/v1/cameras')).status, 401);
    assert.equal((await request('/api/v1/cameras', { as: owner })).status, 401, 'a login token is not an API key');
});

test('viewers cannot create keys or webhooks', async () => {
    const viewer = await createUser();
    assert.equal((await request('/api/integrations/keys', { method: 'POST', as: viewer, body: { name: 'x' } })).status, 403);
});

test('webhook URLs must be public HTTPS', async () => {
    assert.equal(webhookService.urlProblem('http://example.com/hook'), 'The URL must start with https://');
    assert.equal(webhookService.urlProblem('https://127.0.0.1/hook'), 'The URL must be a public address.');
    assert.equal(webhookService.urlProblem('https://[::1]/hook'), 'The URL must be a public address.');
    assert.equal(webhookService.urlProblem('https://user:pw@example.com/'), 'The URL must not contain a user name or password.');
    assert.equal(webhookService.urlProblem('https://hooks.example.com/flybot'), null);
    for (const ip of ['10.1.2.3', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
        assert.equal(webhookService.isPrivateAddress(ip), true, ip);
    }
    assert.equal(webhookService.isPrivateAddress('8.8.8.8'), false);

    // A public name that resolves to an internal address is refused at delivery time
    const original = webhookService.resolver.lookup;
    webhookService.resolver.lookup = (host, opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
    try {
        const err = await new Promise(resolve => webhookService.safeLookup('metadata.example.com', {}, resolve));
        assert.equal(err.code, 'EPRIVATE');
    } finally {
        webhookService.resolver.lookup = original;
    }
});

test('alerts go to subscribed webhooks, signed; failures are recorded', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'HOOK1', deviceName: 'Trap', alertThreshold: 5 });
    const created = await json(await request('/api/integrations/webhooks', { method: 'POST', as: owner, body: { url: 'https://hooks.example.com/in', events: ['pest_threshold'] } }));
    assert.equal(created.status, 201);
    const secret = created.body.secret;
    assert.match(secret, /^whsec_/);
    await request('/api/integrations/webhooks', { method: 'POST', as: owner, body: { url: 'https://other.example.com/in', events: ['camera_offline'] } });

    const calls = [];
    const original = axios.post;
    let status = 200;
    axios.post = async (url, body, config) => {
        calls.push({ url, body, headers: config.headers, lookup: config.lookup, maxRedirects: config.maxRedirects });
        return { status };
    };
    try {
        await notificationService.checkPestThreshold('HOOK1', 9);
        await new Promise(r => setTimeout(r, 100));
        assert.equal(calls.length, 1, 'only the webhook subscribed to pest_threshold');
        const [call] = calls;
        assert.equal(call.url, 'https://hooks.example.com/in');
        assert.equal(call.maxRedirects, 0);
        assert.equal(call.lookup, webhookService.safeLookup);
        const payload = JSON.parse(call.body);
        assert.equal(payload.event, 'pest_threshold');
        assert.equal(payload.deviceSerial, 'HOOK1');
        const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${call.headers['X-FlyBot-Timestamp']}.${call.body}`).digest('hex')}`;
        assert.equal(call.headers['X-FlyBot-Signature'], expected);

        // "Test" button: a ping; a 4xx is recorded and not retried
        status = 410;
        const hook = await models.Webhook.findOne({ url: 'https://hooks.example.com/in' });
        const test = await json(await request(`/api/integrations/webhooks/${hook._id}/test`, { method: 'POST', as: owner }));
        assert.deepEqual(test.body.result, { ok: false, status: 410, error: 'HTTP 410' });
        const after = await models.Webhook.findById(hook._id).lean();
        assert.equal(after.failures, 1);
        assert.equal(after.lastError, 'HTTP 410');
    } finally {
        axios.post = original;
    }

    const list = await json(await request('/api/integrations/webhooks', { as: owner }));
    assert.equal(list.body.webhooks.length, 2);
    assert.equal(list.body.webhooks[0].secret, undefined, 'the secret is not shown again');
});
