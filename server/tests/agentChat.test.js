const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, createUser, createCamera, request } = require('./dbHelpers');
const agent = require('../src/agent/agent');
const dailyStats = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const userOf = (u) => ({ id: String(u._id), role: u.role, language: u.language });
const chunk = (...parts) => ({ candidates: [{ content: { role: 'model', parts } }] });

/**
 * A fake model: each call plays the next scripted turn (an array of chunks, or a function
 * that throws), as an async stream. Returns the history each call was given.
 */
function scriptModel(turns) {
    const requests = [];
    agent.setModelClient({
        stream: async (req) => {
            requests.push(JSON.parse(JSON.stringify(req.contents)));
            const turn = turns.shift();
            if (!turn) throw new Error('no more turns');
            const chunks = typeof turn === 'function' ? turn(req) : turn;
            return (async function* () { for (const c of chunks) yield c; })();
        }
    });
    return requests;
}

async function photo(serial, minutesAgo, count) {
    const doc = await models.Snapshot.create({
        deviceSerial: serial, imageUrl: 'x', s3Key: `snapshots/${serial}/${minutesAgo}.jpg`, aiProcessed: true,
        createdAt: new Date(Date.now() - minutesAgo * 60000), aiResults: { summary: { fruit_fly: count } }
    });
    await dailyStats.refreshForSnapshot(doc);
}

test('a question with a tool call: streamed answer, tool events, cards, stored conversation', async () => {
    const owner = await createUser({ role: 'manager', language: 'vi' });
    await createCamera(owner, { deviceSerial: 'CHT1', deviceName: 'Mango A' });
    await photo('CHT1', 30, 4);
    const requests = scriptModel([
        [chunk({ functionCall: { name: 'get_recent_snapshots', args: { limit: 2 } } })],
        [chunk({ text: 'Bẫy Mango A có ' }), chunk({ text: '4 con.\n[SUGG' }), chunk({ text: 'ESTIONS]["Xem ảnh", "So sánh tuần"][/SUGGESTIONS]' })]
    ]);
    const events = [];
    const result = await agent.chatWithAgent({
        sessionId: 's1', message: 'Ảnh mới nhất?', userId: String(owner._id), user: userOf(owner),
        onEvent: (type, data) => events.push([type, data])
    });

    assert.equal(result.reply, 'Bẫy Mango A có 4 con.');
    assert.deepEqual(result.suggestions, ['Xem ảnh', 'So sánh tuần']);
    const shown = events.filter(([type]) => type === 'delta').map(([, d]) => d.text).join('');
    assert.equal(shown, 'Bẫy Mango A có 4 con.\n', 'no tail block reaches the screen');
    assert.deepEqual(events.filter(([type]) => type === 'tool').map(([, d]) => [d.name, d.phase, d.status]), [
        ['get_recent_snapshots', 'start', undefined],
        ['get_recent_snapshots', 'end', 'success']
    ]);
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0].type, 'photos');
    assert.deepEqual(result.cards[0].items.map(i => [i.name, i.count, i.imageKey]), [['Mango A', 4, 'snapshots/CHT1/30.jpg']]);
    // The second model call got the tool result
    assert.ok(requests[1].at(-1).parts[0].functionResponse);

    // Shown again after a reload, and the model keeps the context
    const messages = await agent.getChatHistory(String(owner._id), 's1');
    assert.deepEqual(messages.map(m => [m.role, m.content]), [['user', 'Ảnh mới nhất?'], ['assistant', 'Bẫy Mango A có 4 con.']]);
    assert.equal(messages[1].id, result.messageId);
    assert.equal(messages[1].cards[0].type, 'photos');
    const stored = await models.ChatSession.findOne({ sessionId: 's1' }).lean();
    assert.equal(stored.contents.length, 4, 'question, tool call, tool result, answer');

    const next = scriptModel([[chunk({ text: 'Vẫn 4 con.' })]]);
    await agent.chatWithAgent({ sessionId: 's1', message: 'Còn bây giờ?', userId: String(owner._id), user: userOf(owner) });
    assert.equal(next[0].length, 5, 'earlier turns sent along with the new question');
});

test('a failed question leaves the stored history as it was, with a message in the user language', async () => {
    const owner = await createUser({ role: 'manager', language: 'vi' });
    scriptModel([[chunk({ text: 'Xin chào.' })]]);
    await agent.chatWithAgent({ sessionId: 's2', message: 'Chào', userId: String(owner._id), user: userOf(owner) });
    scriptModel([
        [chunk({ functionCall: { name: 'get_catch_summary', args: {} } })],
        () => { throw new Error('Vertex down'); }
    ]);
    const result = await agent.chatWithAgent({ sessionId: 's2', message: 'Bẫy nào nặng nhất?', userId: String(owner._id), user: userOf(owner) });
    assert.match(result.reply, /Trợ lý gặp lỗi/);
    const stored = await models.ChatSession.findOne({ sessionId: 's2' }).lean();
    assert.equal(stored.contents.length, 2, 'no tool call left without its result');
    assert.equal(stored.messages.length, 4, 'the failed exchange is still shown');
});

test('ratings only on the user own answers; history is per user', async () => {
    const owner = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    scriptModel([[chunk({ text: 'Hello.' })]]);
    const { messageId } = await agent.chatWithAgent({ sessionId: 's3', message: 'Hi', userId: String(owner._id), user: userOf(owner) });

    const rate = (as, body) => request('/api/ai/chat/feedback', { method: 'POST', as, body });
    assert.equal((await rate(owner, { sessionId: 's3', messageId, rating: 'down' })).status, 200);
    assert.equal((await rate(other, { sessionId: 's3', messageId, rating: 'up' })).status, 404);
    assert.equal((await rate(owner, { sessionId: 's3', messageId, rating: 'meh' })).status, 400);
    let [, answer] = await agent.getChatHistory(String(owner._id), 's3');
    assert.equal(answer.feedback.rating, 'down');
    await rate(owner, { sessionId: 's3', messageId, rating: null });
    [, answer] = await agent.getChatHistory(String(owner._id), 's3');
    assert.equal(answer.feedback, undefined);

    const history = async (as) => (await (await request('/api/ai/chat/history?sessionId=s3', { as })).json()).messages;
    assert.equal((await history(owner)).length, 2);
    assert.deepEqual(await history(other), []);
    assert.equal((await request('/api/ai/chat/history?sessionId=../x', { as: owner })).status, 400);

    await request('/api/ai/chat/clear', { method: 'POST', as: owner, body: { sessionId: 's3' } });
    assert.deepEqual(await history(owner), []);
});

test('the stream endpoint sends the answer as server-sent events', async () => {
    const owner = await createUser({ role: 'manager' });
    scriptModel([[chunk({ text: 'Part one, ' }), chunk({ text: 'part two.' })]]);
    const res = await request('/api/ai/chat/stream', { method: 'POST', as: owner, body: { sessionId: 's4', message: 'Hi' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = (await res.text()).split('\n\n').filter(Boolean)
        .map(block => Object.fromEntries(block.split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)])))
        .filter(e => e.event);
    assert.deepEqual(events.map(e => e.event), ['delta', 'delta', 'done']);
    assert.equal(JSON.parse(events[2].data).reply, 'Part one, part two.');
    assert.equal((await request('/api/ai/chat/stream', { method: 'POST', as: owner, body: { sessionId: 's4', message: ' ' } })).status, 400);
});
