const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
// The harness first: it replaces every .env value before anything reads them
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const env = require('../src/config/env');
const ezvizService = require('../src/services/ezvizService');
const ezvizRam = require('../src/services/ezvizRamService');

before(startDb);
after(stopDb);

// Fake EZVIZ: the app token, live addresses, and the RAM endpoints
const calls = [];
let failRam = false;
const originals = {};
beforeEach(async () => {
    await clearDb();
    calls.length = 0;
    failRam = false;
    ezvizRam.tokenCache.clear();
    env.EZVIZ_RAM_TOKENS = 'true';
    Object.assign(originals, { post: axios.post, getValidToken: ezvizService.getValidToken, getCachedToken: ezvizService.getCachedToken, getLiveAddress: ezvizService.getLiveAddress });
    ezvizService.getValidToken = async () => 'MASTER';
    ezvizService.getCachedToken = () => ({ accessToken: 'MASTER', areaDomain: 'https://area.example' });
    ezvizService.getLiveAddress = async ({ deviceSerial }) => ({
        responseData: { code: '200', data: { url: `https://area.example/${deviceSerial}.m3u8`, id: 'u1' } },
        token: 'MASTER',
        areaDomain: 'https://area.example'
    });
    axios.post = async (url, body) => {
        const params = Object.fromEntries(new URLSearchParams(body));
        calls.push({ path: new URL(url).pathname, params });
        if (failRam) return { data: { code: '10002', msg: 'accessToken expired' } };
        if (url.endsWith('/ram/account/create')) return { data: { code: '200', data: { accountId: `acc-${params.accountName}` } } };
        if (url.endsWith('/ram/token/get')) return { data: { code: '200', data: { accessToken: `SUB-${params.accountId}`, expireTime: Date.now() + 7 * 864e5 } } };
        return { data: { code: '200', data: {} } };
    };
});
const restore = () => {
    axios.post = originals.post;
    Object.assign(ezvizService, { getValidToken: originals.getValidToken, getCachedToken: originals.getCachedToken, getLiveAddress: originals.getLiveAddress });
};

const live = async (user, serial) => json(await request('/api/live', { method: 'POST', as: user, body: { deviceSerial: serial } }));
const policiesSet = () => calls.filter(c => c.path.endsWith('/ram/policy/set')).map(c => JSON.parse(c.params.policy));

test('a viewer gets a sub-account token limited to their cameras', async () => {
    try {
        const owner = await createUser({ role: 'manager' });
        const viewer = await createUser({ email: 'v@example.test' });
        await createCamera(owner, { deviceSerial: 'SHARED1' });
        await createCamera(owner, { deviceSerial: 'PRIVATE1' });
        await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'SHARED1', email: 'v@example.test' } });

        const res = await live(viewer, 'SHARED1');
        assert.equal(res.status, 200);
        assert.equal(res.body.data.accessToken, `SUB-acc-fb${viewer._id}`);
        assert.notEqual(res.body.data.accessToken, 'MASTER');
        const [policy] = policiesSet();
        assert.deepEqual(policy, { Statement: [{ Permission: 'Get,Real,Replay', Resource: ['dev:SHARED1', 'cam:SHARED1:1'] }] });
        // The account creation password is the md5 form EZVIZ expects, never a plain one
        assert.match(calls.find(c => c.path.endsWith('/ram/account/create')).params.password, /^[0-9a-f]{32}$/);

        // Second time: same account, token from cache, no new policy call
        calls.length = 0;
        await live(viewer, 'SHARED1');
        assert.deepEqual(calls.map(c => c.path), []);
    } finally {
        restore();
    }
});

test('removed access leaves the policy (hourly job); disabled users get an empty policy', async () => {
    try {
        const owner = await createUser({ role: 'manager' });
        const viewer = await createUser({ email: 'v2@example.test' });
        await createCamera(owner, { deviceSerial: 'GONE1' });
        await request('/api/user/camera/share', { method: 'POST', as: owner, body: { deviceSerial: 'GONE1', email: 'v2@example.test' } });
        await live(viewer, 'GONE1');

        await request('/api/user/camera/share', { method: 'DELETE', as: owner, body: { deviceSerial: 'GONE1', email: 'v2@example.test' } });
        calls.length = 0;
        assert.equal(await ezvizRam.resyncAll(), 1);
        assert.deepEqual(policiesSet(), [{ Statement: [] }]);
        assert.equal(await ezvizRam.resyncAll(), 0, 'nothing changed since');
    } finally {
        restore();
    }
});

test('admins keep the app token; off by default; failure refuses video instead of leaking', async () => {
    try {
        const admin = await createUser({ role: 'admin' });
        const viewer = await createUser({ role: 'manager' });
        await createCamera(admin, { deviceSerial: 'ADM1' });
        await createCamera(viewer, { deviceSerial: 'OWN1' });
        assert.equal((await live(admin, 'ADM1')).body.data.accessToken, 'MASTER');

        env.EZVIZ_RAM_TOKENS = 'false';
        assert.equal((await live(viewer, 'OWN1')).body.data.accessToken, 'MASTER');

        env.EZVIZ_RAM_TOKENS = 'true';
        failRam = true;
        const res = await live(viewer, 'OWN1');
        assert.equal(res.status, 503);
        assert.ok(!JSON.stringify(res.body).includes('MASTER'));
        assert.equal(await models.User.countDocuments({ 'ezvizRam.accountId': { $exists: true } }), 0);
    } finally {
        env.EZVIZ_RAM_TOKENS = 'false';
        restore();
    }
});
