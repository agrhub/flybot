const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ALICE, token, bearer, startApp } = require('./helpers');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('rejects requests without a token', async () => {
    const res = await app.request('/api/user/cameras');
    assert.equal(res.status, 401);
});

test('rejects tokens passed in the query string', async () => {
    const res = await app.request(`/api/user/cameras?token=${token(ALICE)}`);
    assert.equal(res.status, 401);
});

test('rejects tokens signed with the old hard-coded default secret', async () => {
    const res = await app.request('/api/user/cameras', {
        headers: { Authorization: `Bearer ${token(ALICE, 'camhub-secret-jwt-key-2026')}` }
    });
    assert.equal(res.status, 401);
});

test('accepts a valid Bearer token', async () => {
    const res = await app.request('/api/user/cameras', { headers: bearer(ALICE) });
    assert.equal(res.status, 200);
});

test('register validates email and password', async () => {
    const badEmail = await app.request('/api/auth/register', { method: 'POST', body: { email: 'nope', password: 'secret123' } });
    assert.equal(badEmail.status, 400);

    const shortPassword = await app.request('/api/auth/register', { method: 'POST', body: { email: 'a@b.co', password: '123' } });
    assert.equal(shortPassword.status, 400);

    const longPassword = await app.request('/api/auth/register', { method: 'POST', body: { email: 'a@b.co', password: 'x'.repeat(73) } });
    assert.equal(longPassword.status, 400);

    const objectEmail = await app.request('/api/auth/register', { method: 'POST', body: { email: { $ne: null }, password: 'secret123' } });
    assert.equal(objectEmail.status, 400);
});

test('login gives the same message for unknown accounts (no enumeration)', async () => {
    const res = await app.request('/api/auth/login', { method: 'POST', body: { email: 'ghost@b.co', password: 'whatever1' } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, 'Invalid email or password.');
});

test('login is rate limited per email', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
        const res = await app.request('/api/auth/login', { method: 'POST', body: { email: 'brute@b.co', password: `guess${i}` } });
        statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);

    // A different email from the same IP is not locked out
    const other = await app.request('/api/auth/login', { method: 'POST', body: { email: 'other@b.co', password: 'x' } });
    assert.equal(other.status, 401);
});

test('session endpoint sets an httpOnly cookie scoped to /api', async () => {
    const res = await app.request('/api/auth/session', { method: 'POST', headers: bearer(ALICE) });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /flybot_token=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Path=\/api/);
    assert.match(setCookie, /SameSite=Lax/i);
});

test('logout clears the cookie', async () => {
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    assert.match(res.headers.get('set-cookie') || '', /flybot_token=;/);
});

test('CORS does not allow foreign origins', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
});
