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
    for (const name of ['get_cameras_status', 'get_insect_statistics', 'get_recent_snapshots', 'get_overview_metrics', 'get_catch_summary', 'list_reports', 'get_report_summary', 'send_report_to_me', 'get_alerts', 'get_treatments', 'compare_periods', 'get_pipeline_health']) {
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

    // The assistant cannot change verification codes at all (prompt-injection risk)
    assert.equal(allExecutors.update_camera_validate_code, undefined);
});

test('tool UI actions go to the per-request collector', async () => {
    const actions = [];
    await allExecutors.navigate_ui({
        tab: 'analytics',
        addAction: (type, payload) => actions.push({ type, payload })
    });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'NAVIGATE');
});

test('chat history is keyed per user', () => {
    assert.deepEqual(agent.getChatHistory(ALICE, 'default-session'), []);
    agent.clearChatHistory(BOB, 'default-session');
    assert.deepEqual(agent.getChatHistory(ALICE, 'default-session'), []);
});

test('navigate_ui opens only known pages, with their own sub-tabs', async () => {
    const actions = [];
    const addAction = (type, payload) => actions.push(payload);
    assert.match((await allExecutors.navigate_ui({ tab: '//evil.example', addAction })).error, /Unknown page/);
    await allExecutors.navigate_ui({ tab: 'settings', subTab: 'notifications', addAction });
    await allExecutors.navigate_ui({ tab: 'reports', subTab: 'history', deviceSerial: 'CAMA', addAction });
    await allExecutors.navigate_ui({ tab: 'analytics', subTab: 'history', deviceSerial: 'CAMA', addAction });
    assert.deepEqual(actions, [
        { tab: 'settings', subTab: 'notifications' },
        { tab: 'reports' },
        { tab: 'analytics', subTab: 'history', deviceSerial: 'CAMA' }
    ]);
});

test('chat history is trimmed between questions, never inside a tool exchange', () => {
    const question = (n) => ({ role: 'user', parts: [{ text: `q${n}` }] });
    const call = { role: 'model', parts: [{ functionCall: { name: 'get_catch_summary', args: {} } }] };
    const result = { role: 'user', parts: [{ functionResponse: { name: 'get_catch_summary', response: {} } }] };
    const answer = { role: 'model', parts: [{ text: 'a' }] };
    const history = [];
    for (let n = 0; n < 5; n++) history.push(question(n), call, result, answer);
    agent.trimHistory(history, 6);
    assert.deepEqual(history[0], question(4), 'starts at a question');
    assert.equal(history.length, 4);
    // A window with no question at all keeps the last question onwards
    const long = [question(0), ...Array.from({ length: 4 }, () => [call, result]).flat(), answer];
    agent.trimHistory(long, 3);
    assert.deepEqual(long[0], question(0));
});
