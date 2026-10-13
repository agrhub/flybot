const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
// The harness first: it replaces every .env value before anything reads them
const { sentMails, startDb, stopDb, clearDb, request, createUser, json } = require('./dbHelpers');
const env = require('../src/config/env');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    env.CONTACT_EMAIL = '';
});

const send = (body) => request('/api/public/contact', { method: 'POST', body });
const form = { name: 'Lan', email: 'lan@farm.example', subject: 'Báo giá', message: 'Vườn 2 ha.\nCần 6 bẫy.' };

test('the contact form emails CONTACT_EMAIL, with a reply-to the sender', async () => {
    env.CONTACT_EMAIL = 'hello@flybot.example';
    const res = await json(await send(form));
    assert.equal(res.status, 200);
    const mail = sentMails.at(-1);
    assert.equal(mail.to, 'hello@flybot.example');
    assert.equal(mail.replyTo, 'lan@farm.example');
    assert.match(mail.subject, /Báo giá/);
    assert.match(mail.text, /Cần 6 bẫy/);
    assert.equal((await json(await request('/api/auth/config'))).body.contactEmail, 'hello@flybot.example');
});

test('without CONTACT_EMAIL it goes to the admins; bots and bad input are turned away', async () => {
    await createUser({ role: 'admin', email: 'boss@example.test' });
    await send(form);
    assert.equal(sentMails.at(-1).to, 'boss@example.test');

    const before = sentMails.length;
    assert.equal((await send({ ...form, website: 'http://spam.example' })).status, 200);
    assert.equal(sentMails.length, before, 'honeypot filled: no email');
    assert.equal((await send({ ...form, email: 'nope' })).status, 400);
    assert.equal((await send({ ...form, message: '' })).status, 400);
});
