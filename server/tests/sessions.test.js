const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { ALICE, BOB, store, resetStore, token, startApp } = require('./helpers');
const { describeDevice } = require('../src/middlewares/auth');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let ipCounter = 0;
async function login(userAgent) {
    const res = await app.request('/api/auth/login', {
        method: 'POST',
        // Distinct client IPs keep the per-IP login limit out of the way
        headers: { 'User-Agent': userAgent, 'X-Forwarded-For': `10.9.0.${++ipCounter}` },
        body: { email: store.users.get(ALICE).email, password: 'secret123' }
    });
    assert.equal(res.status, 200);
    return (await res.json()).token;
}
const auth = (tok) => ({ Authorization: `Bearer ${tok}` });

beforeEach(async () => {
    resetStore();
    store.users.get(ALICE).email = `alice.s${ipCounter}@example.test`;
    store.users.get(ALICE).password = await bcrypt.hash('secret123', 4);
});

test('device labels from the user agent', () => {
    assert.deepEqual(describeDevice(CHROME_WINDOWS), { browser: 'Chrome', os: 'Windows' });
    assert.deepEqual(describeDevice(SAFARI_IPHONE), { browser: 'Safari', os: 'iOS' });
    assert.deepEqual(describeDevice(''), { browser: 'Other', os: 'Other' });
});

test('each login is a listed session; the current one is flagged', async () => {
    const laptop = await login(CHROME_WINDOWS);
    await login(SAFARI_IPHONE);

    const res = await app.request('/api/auth/sessions', { headers: auth(laptop) });
    const { sessions } = await res.json();
    assert.equal(sessions.length, 2);
    const current = sessions.find(s => s.current);
    assert.equal(current.browser, 'Chrome');
    assert.equal(current.os, 'Windows');
});

test('signing out one device invalidates only its token', async () => {
    const laptop = await login(CHROME_WINDOWS);
    const phone = await login(SAFARI_IPHONE);
    const { sessions } = await (await app.request('/api/auth/sessions', { headers: auth(laptop) })).json();
    const phoneSession = sessions.find(s => !s.current);

    const res = await app.request(`/api/auth/sessions/${phoneSession.id}`, { method: 'DELETE', headers: auth(laptop) });
    assert.equal(res.status, 200);
    assert.equal((await app.request('/api/auth/me', { headers: auth(phone) })).status, 401);
    assert.equal((await app.request('/api/auth/me', { headers: auth(laptop) })).status, 200);
});

test('another user cannot sign out my session', async () => {
    await login(CHROME_WINDOWS);
    const target = store.sessions[0];
    const res = await app.request(`/api/auth/sessions/${target._id}`, { method: 'DELETE', headers: auth(token(BOB)) });
    assert.equal(res.status, 404);
    assert.equal(target.revokedAt, null);
});

test('"sign out everywhere else" keeps this device with a fresh token', async () => {
    const laptop = await login(CHROME_WINDOWS);
    const phone = await login(SAFARI_IPHONE);
    const legacy = token(ALICE); // token from before session tracking

    const res = await app.request('/api/auth/sessions/revoke-others', { method: 'POST', headers: auth(laptop) });
    assert.equal(res.status, 200);
    const fresh = (await res.json()).token;

    assert.equal((await app.request('/api/auth/me', { headers: auth(phone) })).status, 401);
    assert.equal((await app.request('/api/auth/me', { headers: auth(legacy) })).status, 401, 'legacy tokens are cut via tokenVersion');
    assert.equal((await app.request('/api/auth/me', { headers: auth(fresh) })).status, 200);
});

test('logout revokes the session behind the token', async () => {
    const laptop = await login(CHROME_WINDOWS);
    const res = await app.request('/api/auth/logout', { method: 'POST', headers: auth(laptop) });
    assert.equal(res.status, 200);
    assert.equal((await app.request('/api/auth/me', { headers: auth(laptop) })).status, 401);
});

test('changing the password signs out other devices but keeps this one', async () => {
    const laptop = await login(CHROME_WINDOWS);
    const phone = await login(SAFARI_IPHONE);
    const res = await app.request('/api/auth/change-password', {
        method: 'POST',
        headers: auth(laptop),
        body: { currentPassword: 'secret123', newPassword: 'newsecret456' }
    });
    assert.equal(res.status, 200);
    const fresh = (await res.json()).token;
    assert.equal((await app.request('/api/auth/me', { headers: auth(phone) })).status, 401);
    assert.equal((await app.request('/api/auth/me', { headers: auth(fresh) })).status, 200);
    const { sessions } = await (await app.request('/api/auth/sessions', { headers: auth(fresh) })).json();
    assert.equal(sessions.length, 1);
});

test('tokens from before session tracking still work until revoked', async () => {
    const res = await app.request('/api/auth/sessions', { headers: auth(token(ALICE)) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).currentUntracked, true);
});
