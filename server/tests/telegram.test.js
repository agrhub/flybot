const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Must be set before config/env loads (helpers loads it)
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-TOKEN';
process.env.TELEGRAM_BOT_USERNAME = 'flybot_test_bot';

const axios = require('axios');
const { ALICE, BOB, store, resetStore, bearer, flush, startApp } = require('./helpers');
const telegramService = require('../src/services/telegramService');
const notificationService = require('../src/services/notificationService');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

// Capture Telegram API calls instead of sending them
const sent = [];
const originalPost = axios.post;
beforeEach(() => {
    resetStore();
    sent.length = 0;
    axios.post = async (url, body, opts) => {
        if (String(url).startsWith('https://api.telegram.org/')) {
            sent.push({ method: url.split('/').pop(), body });
            return { data: { ok: true } };
        }
        return originalPost(url, body, opts);
    };
});

const startMessage = (chatId, text, username = 'farmer') => ({
    update_id: 1,
    message: { text, chat: { id: chatId, type: 'private' }, from: { username, language_code: 'en' } }
});

async function createLinkCode(userId) {
    const res = await app.request('/api/telegram/link', { method: 'POST', headers: bearer(userId) });
    assert.equal(res.status, 200);
    const { url } = await res.json();
    const parsed = new URL(url);
    assert.equal(parsed.host, 't.me');
    assert.equal(parsed.pathname, '/flybot_test_bot');
    return parsed.searchParams.get('start');
}

test('pressing Start with the link code connects the account (once)', async () => {
    const code = await createLinkCode(ALICE);
    assert.ok(/^[A-Za-z0-9_-]{20,64}$/.test(code), 'valid Telegram start payload');

    await telegramService.handleUpdate(startMessage(555, `/start ${code}`));
    await flush();
    assert.equal(store.users.get(ALICE).telegram.chatId, '555');
    assert.match(sent.at(-1).body.text, /Connected to FlyBot account/);

    // Reusing the code does nothing
    await telegramService.handleUpdate(startMessage(777, `/start ${code}`));
    await flush();
    assert.equal(store.users.get(ALICE).telegram.chatId, '555');
    assert.match(sent.at(-1).body.text, /invalid or has expired/);
});

test('a chat belongs to one account; /stop disconnects', async () => {
    store.users.get(BOB).telegram = { chatId: '555' };
    const code = await createLinkCode(ALICE);
    await telegramService.handleUpdate(startMessage(555, `/start ${code}`));
    assert.equal(store.users.get(BOB).telegram, undefined, 'moved away from Bob');

    await telegramService.handleUpdate(startMessage(555, '/stop'));
    assert.equal(store.users.get(ALICE).telegram, undefined);
});

test('group chats and unknown commands are not linked', async () => {
    const code = await createLinkCode(ALICE);
    await telegramService.handleUpdate({ update_id: 2, message: { text: `/start ${code}`, chat: { id: -100, type: 'group' }, from: {} } });
    assert.equal(store.users.get(ALICE).telegram, undefined);
});

test('alerts go to the linked chat with camera names escaped', async () => {
    store.users.get(ALICE).telegram = { chatId: '555' };
    store.cameras[0].deviceName = '<b>Lot</b> & "A"';
    await notificationService.checkPestThreshold('CAMA', 20);
    await flush();

    const message = sent.find(m => m.method === 'sendMessage');
    assert.equal(message.body.chat_id, '555');
    assert.equal(message.body.parse_mode, 'HTML');
    assert.ok(message.body.text.includes('&lt;b&gt;Lot&lt;/b&gt; &amp; &quot;A&quot;'));
    assert.ok(message.body.text.includes('https://app.example.test/dashboard'));
});

test('no Telegram alert when the user turned it off', async () => {
    store.users.get(ALICE).telegram = { chatId: '555' };
    store.users.get(ALICE).notificationPrefs.telegram = false;
    await notificationService.checkPestThreshold('CAMA', 20);
    await flush();
    assert.equal(sent.filter(m => m.method === 'sendMessage').length, 0);
});

test('test message and unlink endpoints', async () => {
    const notLinked = await app.request('/api/telegram/test', { method: 'POST', headers: bearer(ALICE) });
    assert.equal(notLinked.status, 400);

    store.users.get(ALICE).telegram = { chatId: '555' };
    const ok = await app.request('/api/telegram/test', { method: 'POST', headers: bearer(ALICE) });
    assert.equal(ok.status, 200);
    assert.match(sent.at(-1).body.text, /Test message from FlyBot/);

    await app.request('/api/telegram/link', { method: 'DELETE', headers: bearer(ALICE) });
    assert.equal(store.users.get(ALICE).telegram, undefined);
});

test('profile reports the Telegram connection', async () => {
    store.users.get(ALICE).telegram = { chatId: '555', username: 'farmer' };
    const { user } = await (await app.request('/api/auth/me', { headers: bearer(ALICE) })).json();
    assert.deepEqual(user.telegram, { connected: true, username: 'farmer' });
    assert.equal(user.notificationPrefs.telegram, true);
});
