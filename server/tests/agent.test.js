const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ALICE, BOB } = require('./helpers'); // installs model stubs
const { allExecutors, allFunctionDeclarations } = require('../src/agent/tools');
const agent = require('../src/agent/agent');

const noopAction = () => {};

test('agent refuses to run without an authenticated user', async () => {
    await assert.rejects(() => agent.chatWithAgent({ message: 'hi' }), /userId/);
});

test('tool declarations do not let the model choose a userId', () => {
    for (const decl of allFunctionDeclarations) {
        assert.ok(!('userId' in (decl.parameters?.properties || {})), decl.name);
    }
});

test('every data tool refuses calls without a userId', async () => {
    for (const name of ['get_cameras_status', 'get_insect_statistics', 'get_recent_snapshots', 'get_overview_metrics']) {
        const result = await allExecutors[name]({ deviceSerial: 'CAMA', addAction: noopAction });
        assert.ok(result.error, name);
    }
});

test('a user with no cameras cannot query another user\'s camera', async () => {
    for (const name of ['get_insect_statistics', 'get_recent_snapshots']) {
        const result = await allExecutors[name]({ deviceSerial: 'CAMA', userId: BOB, addAction: noopAction });
        assert.match(result.error || '', /permission/, name);
    }
});

test('camera control tools enforce ownership', async () => {
    const capture = await allExecutors.trigger_capture_snapshot({ deviceSerial: 'CAMA', userId: BOB, addAction: noopAction });
    assert.match(capture.error || '', /permission/);

    const update = await allExecutors.update_camera_validate_code({ deviceSerial: 'CAMA', validateCode: 'X', userId: BOB, addAction: noopAction });
    assert.match(update.error || '', /permission/);
});

test('tool UI actions go to the per-request collector', async () => {
    const actions = [];
    await allExecutors.update_camera_validate_code({
        deviceSerial: 'CAMA',
        validateCode: 'ABCDEF',
        userId: ALICE,
        addAction: (type, payload) => actions.push({ type, payload })
    });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'UPDATE_CODE');
});

test('chat history is keyed per user', () => {
    assert.deepEqual(agent.getChatHistory(ALICE, 'default-session'), []);
    agent.clearChatHistory(BOB, 'default-session');
    assert.deepEqual(agent.getChatHistory(ALICE, 'default-session'), []);
});
