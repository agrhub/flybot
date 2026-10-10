const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { ALICE, store, sentMails, resetStore, token, bearer, flush, startApp } = require('./helpers');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });
// The per-address limit (3/hour) persists across tests, so each test uses its own address
let testNo = 0;
let aliceEmail;
beforeEach(() => {
    resetStore();
    aliceEmail = `alice+${++testNo}@example.test`;
    store.users.get(ALICE).email = aliceEmail;
});

let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const forgot = (email, language, ip = freshIp()) =>
    app.request('/api/auth/forgot-password', { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: { email, language } });

function linkToken(mail, pathname) {
    const url = mail.text.match(/https:\/\/app\.example\.test\S+/)[0];
    const parsed = new URL(url);
    assert.equal(parsed.pathname, pathname);
    return parsed.searchParams.get('token');
}

test('forgot-password gives the same answer for known and unknown emails', async () => {
    const known = await forgot(aliceEmail);
    const unknown = await forgot('nobody@example.test');
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());

    await flush();
    assert.equal(sentMails.length, 1, 'only the real account gets an email');
    assert.equal(sentMails[0].to, aliceEmail);
});

test('reset email links to APP_BASE_URL (never the request Host) and stores only a hash', async () => {
    await app.request('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-For': freshIp() },
        body: { email: aliceEmail }
    }).catch(() => {});
    await forgot(aliceEmail);
    await flush();

    const mail = sentMails.at(-1);
    const raw = linkToken(mail, '/auth/reset-password');
    assert.ok(raw.length >= 40);
    assert.ok(!mail.text.includes('evil.example'));
    assert.ok(store.authTokens.every(t => t.tokenHash !== raw), 'raw token is not stored');
});

test('reset email follows the requested language', async () => {
    await forgot(aliceEmail, 'vi');
    await flush();
    assert.match(sentMails[0].subject, /Đặt lại mật khẩu/);
});

test('reset-password works once, bumps the session version and sends a notice', async () => {
    await forgot(aliceEmail);
    await flush();
    const raw = linkToken(sentMails[0], '/auth/reset-password');
    const oldSession = bearer(ALICE);

    const res = await app.request('/api/auth/reset-password', { method: 'POST', body: { token: raw, password: 'newpass123' } });
    assert.equal(res.status, 200);
    const user = store.users.get(ALICE);
    assert.ok(await bcrypt.compare('newpass123', user.password));
    assert.equal(user.tokenVersion, 1);
    assert.match(sentMails.at(-1).subject, /password was changed/i);

    // Old sessions are signed out
    const stale = await app.request('/api/auth/me', { headers: oldSession });
    assert.equal(stale.status, 401);
    const fresh = await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${token(ALICE)}` } });
    assert.equal(fresh.status, 200);

    // The link cannot be reused
    const again = await app.request('/api/auth/reset-password', { method: 'POST', body: { token: raw, password: 'another123' } });
    assert.equal(again.status, 400);
    assert.equal((await again.json()).code, 'INVALID_TOKEN');
});

test('a newer reset link revokes the older one', async () => {
    await forgot(aliceEmail);
    await flush();
    const first = linkToken(sentMails[0], '/auth/reset-password');
    await forgot(aliceEmail);
    await flush();

    const res = await app.request('/api/auth/reset-password', { method: 'POST', body: { token: first, password: 'newpass123' } });
    assert.equal(res.status, 400);
});

test('expired and malformed tokens are rejected', async () => {
    await forgot(aliceEmail);
    await flush();
    const raw = linkToken(sentMails[0], '/auth/reset-password');
    store.authTokens.forEach(t => { t.expiresAt = new Date(Date.now() - 1000); });

    const expired = await app.request('/api/auth/reset-password', { method: 'POST', body: { token: raw, password: 'newpass123' } });
    assert.equal(expired.status, 400);

    const objectToken = await app.request('/api/auth/reset-password', { method: 'POST', body: { token: { $ne: null }, password: 'newpass123' } });
    assert.equal(objectToken.status, 400);

    const weak = await app.request('/api/auth/reset-password', { method: 'POST', body: { token: raw, password: '123' } });
    assert.equal(weak.status, 400);
});

test('changing the password returns a fresh token and signs out other sessions', async () => {
    store.users.get(ALICE).password = await bcrypt.hash('oldpass123', 4);
    const otherSession = bearer(ALICE);

    const res = await app.request('/api/auth/change-password', {
        method: 'POST',
        headers: bearer(ALICE),
        body: { currentPassword: 'oldpass123', newPassword: 'newpass123' }
    });
    assert.equal(res.status, 200);
    const { token: freshToken } = await res.json();

    assert.equal((await app.request('/api/auth/me', { headers: otherSession })).status, 401);
    assert.equal((await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${freshToken}` } })).status, 200);
});

test('email verification: register sends a link, the link verifies once', async () => {
    const res = await app.request('/api/auth/register', {
        method: 'POST',
        body: { email: 'new.user@example.test', password: 'secret123', language: 'vi' }
    });
    assert.equal(res.status, 200);
    await flush();
    const created = [...store.users.values()].find(u => u.email === 'new.user@example.test');
    assert.equal(created.emailVerified, false);
    assert.equal(created.language, 'vi');
    assert.equal(sentMails.at(-1).to, 'new.user@example.test');
    assert.match(sentMails.at(-1).subject, /Xác nhận email/);
    linkToken(sentMails.at(-1), '/auth/verify-email');

    // Use the resend endpoint for an existing, unverified user
    store.users.get(ALICE).emailVerified = false;
    const resend = await app.request('/api/auth/resend-verification', { method: 'POST', headers: bearer(ALICE) });
    assert.equal(resend.status, 200);
    const raw = linkToken(sentMails.at(-1), '/auth/verify-email');

    const verify = await app.request('/api/auth/verify-email', { method: 'POST', body: { token: raw } });
    assert.equal(verify.status, 200);
    assert.equal(store.users.get(ALICE).emailVerified, true);

    const reuse = await app.request('/api/auth/verify-email', { method: 'POST', body: { token: raw } });
    assert.equal(reuse.status, 400);
});

test('forgot-password is rate limited per email', async () => {
    const statuses = [];
    // Different IPs, same address: the per-email limit (3/hour) applies
    for (let i = 0; i < 4; i++) statuses.push((await forgot('limit.me@example.test')).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
});
