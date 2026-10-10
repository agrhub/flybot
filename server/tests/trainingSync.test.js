const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const env = require('../src/config/env');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const trainingSync = require('../src/services/trainingSync');
const settingsService = require('../src/services/settingsService');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    settingsService.clearCache();
    env.ROBOFLOW_UPLOAD_PROJECT = '';
});

// Record calls to Roboflow instead of sending them
function fakeRoboflow({ fail = false } = {}) {
    const calls = [];
    const original = axios.post;
    axios.post = async (url, body) => {
        calls.push({ url: new URL(url), body });
        if (fail) throw Object.assign(new Error('Request failed'), { response: { data: { error: { message: 'Invalid API key' } } } });
        if (url.includes('/upload')) return { data: { success: true, id: `img-${calls.length}` } };
        return { data: { success: true } };
    };
    return { calls, restore: () => { axios.post = original; } };
}

async function reviewedSnapshot(owner, status, extra = {}) {
    await createCamera(owner, { deviceSerial: 'CAM1' }).catch(() => {});
    const snap = await models.Snapshot.create({
        deviceSerial: 'CAM1', imageUrl: 'x', s3Key: 'snapshots/CAM1/a.jpg', aiProcessed: true,
        aiResults: { detected: true, summary: { fruit_fly: 2 }, insects: [{ name: 'fruit_fly', confidence: 0.9, bbox: [10, 10, 30, 40] }, { name: 'fruit_fly', confidence: 0.8, bbox: [50, 60, 70, 80] }] },
        ...extra
    });
    const body = status === 'corrected' ? { status, summary: { fruit_fly: 5 } } : { status };
    const res = await request(`/api/ai/snapshots/${snap._id}/review`, { method: 'PUT', as: owner, body });
    assert.equal(res.status, 200);
    return snap;
}

test('a review queues the photo; nothing is sent while off or not configured', async () => {
    const owner = await createUser({ role: 'manager' });
    const snap = await reviewedSnapshot(owner, 'confirmed');
    assert.equal((await models.Snapshot.findById(snap._id)).trainingSync.status, 'pending');

    const rf = fakeRoboflow();
    try {
        assert.equal(await trainingSync.syncPending(), null, 'not configured');
        env.ROBOFLOW_UPLOAD_PROJECT = 'flies';
        assert.equal(await trainingSync.syncPending(), null, 'turned off by default');
        assert.equal(rf.calls.length, 0);
    } finally {
        rf.restore();
    }
});

test('confirmed goes up labeled, corrected goes up tagged for labeling', async () => {
    const owner = await createUser({ role: 'manager' });
    const confirmed = await reviewedSnapshot(owner, 'confirmed');
    const corrected = await reviewedSnapshot(owner, 'corrected');
    env.ROBOFLOW_UPLOAD_PROJECT = 'flies';
    await settingsService.updateSettings({ trainingSync: true });

    const rf = fakeRoboflow();
    try {
        assert.deepEqual(await trainingSync.syncPending(), { uploaded: 2, failed: 0 });
    } finally {
        rf.restore();
    }
    const uploads = rf.calls.filter(c => c.url.pathname === '/dataset/flies/upload');
    assert.equal(uploads.length, 2);
    const byName = (id) => uploads.find(c => c.url.searchParams.get('name') === `${id}.jpg`);
    assert.equal(byName(confirmed._id).url.searchParams.get('batch'), 'flybot-confirmed');
    assert.deepEqual(byName(corrected._id).url.searchParams.getAll('tag'), ['review-corrected', 'count-5', 'ai-count-2', 'camera-CAM1']);

    // Only the confirmed one is annotated, with the AI boxes
    const annotations = rf.calls.filter(c => c.url.pathname.includes('/annotate/'));
    assert.equal(annotations.length, 1);
    const [entry] = JSON.parse(annotations[0].body);
    assert.deepEqual(entry.annotations[0], { label: 'fruit_fly', coordinates: { x: 20, y: 25, width: 20, height: 30 } });

    const stored = await models.Snapshot.findById(confirmed._id).lean();
    assert.equal(stored.trainingSync.status, 'uploaded');
    assert.match(stored.trainingSync.imageId, /^img-/);
});

test('failures are retried, then reported to the admin', async () => {
    const owner = await createUser({ role: 'manager' });
    const admin = await createUser({ role: 'admin' });
    await reviewedSnapshot(owner, 'corrected');
    env.ROBOFLOW_UPLOAD_PROJECT = 'flies';
    await settingsService.updateSettings({ trainingSync: true });

    const rf = fakeRoboflow({ fail: true });
    try {
        for (let i = 0; i < 5; i++) await trainingSync.syncPending();
        assert.deepEqual(await trainingSync.syncPending(), { uploaded: 0, failed: 0 }, 'gives up after 5 attempts');
    } finally {
        rf.restore();
    }
    const status = await json(await request('/api/admin/training-sync', { as: admin }));
    assert.deepEqual(status.body.sync.counts, { pending: 0, uploaded: 0, failed: 1 });
    assert.equal(status.body.sync.lastError, 'Invalid API key');

    // "Sync now" retries the failed ones
    const ok = fakeRoboflow();
    try {
        const run = await json(await request('/api/admin/training-sync/run', { method: 'POST', as: admin }));
        assert.equal(run.body.retried, 1);
        assert.equal(run.body.result.uploaded, 1);
    } finally {
        ok.restore();
    }
    assert.equal((await request('/api/admin/training-sync', { as: owner })).status, 403);
});
