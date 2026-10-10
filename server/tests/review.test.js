const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ALICE, BOB, resetStore, bearer, startApp } = require('./helpers');
const models = require('../src/models');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const SNAP_ID = '64c000000000000000000aaa';
let snap;

function makeSnapshot() {
    const doc = {
        _id: SNAP_ID,
        deviceSerial: 'CAMA',
        aiProcessed: true,
        createdAt: new Date(),
        aiResults: { detected: true, summary: { fruit_fly: 7, moth: 1 }, insects: [] },
        review: undefined
    };
    doc.set = (path, value) => {
        const parts = path.split('.');
        let node = doc;
        for (const p of parts.slice(0, -1)) node = node[p] = node[p] || {};
        node[parts[parts.length - 1]] = value;
    };
    doc.save = async () => doc;
    doc.toJSON = () => ({ ...doc, set: undefined, save: undefined, toJSON: undefined });
    return doc;
}

beforeEach(() => {
    resetStore();
    snap = makeSnapshot();
    models.Snapshot.findById = async (id) => (String(id) === SNAP_ID ? snap : null);
});

const review = (headers, body, id = SNAP_ID) =>
    app.request(`/api/ai/snapshots/${id}/review`, { method: 'PUT', headers, body });

test('only owners of the camera can review a snapshot', async () => {
    assert.equal((await review(bearer(BOB), { status: 'confirmed' })).status, 404);
    assert.equal((await review(bearer(ALICE), { status: 'confirmed' }, 'not-an-id')).status, 404);
});

test('confirming keeps the AI counts and records who reviewed', async () => {
    const res = await review(bearer(ALICE), { status: 'confirmed' });
    assert.equal(res.status, 200);
    assert.equal(snap.review.status, 'confirmed');
    assert.equal(String(snap.review.reviewedBy), ALICE);
    assert.deepEqual(snap.aiResults.summary, { fruit_fly: 7, moth: 1 });
});

test('a correction replaces the counts used by statistics and keeps the model output', async () => {
    const res = await review(bearer(ALICE), { status: 'corrected', summary: { 'Ruồi vàng': 4, moth: 0 }, note: 'Two were leaves' });
    assert.equal(res.status, 200);
    assert.deepEqual(snap.aiResults.summary, { fruit_fly: 4, moth: 0 }, 'legacy label normalized');
    assert.deepEqual(snap.review.originalSummary, { fruit_fly: 7, moth: 1 });
    assert.equal(snap.review.note, 'Two were leaves');

    // A second correction still remembers the original model output
    await review(bearer(ALICE), { status: 'corrected', summary: { fruit_fly: 5 } });
    assert.deepEqual(snap.review.originalSummary, { fruit_fly: 7, moth: 1 });
    assert.deepEqual(snap.aiResults.summary, { fruit_fly: 5 });
});

test('corrections are validated', async () => {
    const bad = [
        { status: 'deleted' },
        { status: 'corrected' },
        { status: 'corrected', summary: [] },
        { status: 'corrected', summary: { fruit_fly: -1 } },
        { status: 'corrected', summary: { fruit_fly: 2.5 } },
        { status: 'corrected', summary: { 'a.b': 1 } },
        { status: 'corrected', summary: { $where: 1 } },
        { status: 'confirmed', note: 'x'.repeat(501) }
    ];
    for (const body of bad) {
        const res = await review(bearer(ALICE), body);
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(snap.review, undefined, 'nothing saved');
});

test('unanalyzed snapshots cannot be reviewed', async () => {
    snap.aiProcessed = false;
    assert.equal((await review(bearer(ALICE), { status: 'confirmed' })).status, 400);
});
