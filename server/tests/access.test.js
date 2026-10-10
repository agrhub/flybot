const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ALICE, BOB, bearer, cookie, startApp } = require('./helpers');

const IMAGE = '/api/s3/snapshots/CAMA/CAMA_1700000000000.jpg';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('S3 images require authentication', async () => {
    const res = await app.request(IMAGE);
    assert.equal(res.status, 401);
});

test('S3 images are served to the camera owner via cookie or Bearer', async () => {
    const viaCookie = await app.request(IMAGE, { headers: cookie(ALICE) });
    assert.equal(viaCookie.status, 200);
    assert.equal(await viaCookie.text(), 'JPEGDATA');
    assert.match(viaCookie.headers.get('cache-control'), /^private/);

    const viaBearer = await app.request(IMAGE, { headers: bearer(ALICE) });
    assert.equal(viaBearer.status, 200);
});

test('S3 images of other users\' cameras return 404', async () => {
    const res = await app.request(IMAGE, { headers: cookie(BOB) });
    assert.equal(res.status, 404);
});

test('S3 keys outside snapshots/<serial>/ return 404', async () => {
    for (const path of ['/api/s3/other/secret.json', '/api/s3/snapshots/CAMA/../../x', '/api/s3/snapshots/CAMA']) {
        const res = await app.request(path, { headers: cookie(ALICE) });
        assert.equal(res.status, 404, path);
    }
});

for (const route of ['/api/records', '/api/live', '/api/live/disable', '/api/playback']) {
    test(`${route} rejects cameras the user does not own`, async () => {
        const res = await app.request(route, { method: 'POST', headers: bearer(BOB), body: { deviceSerial: 'CAMA' } });
        assert.equal(res.status, 403);
    });
}

test('AI diagnosis rejects cameras the user does not own', async () => {
    // A user with at least one camera, asking about someone else's
    const res = await app.request('/api/ai/diagnose', {
        method: 'POST',
        headers: bearer(ALICE),
        body: { deviceSerial: 'SOMEONE-ELSES' }
    });
    assert.equal(res.status, 403);
});

test('analyze-roboflow hides snapshots that do not exist or are invalid', async () => {
    const res = await app.request('/api/ai/analyze-roboflow/not-an-id', { method: 'POST', headers: bearer(BOB) });
    assert.equal(res.status, 404);
});

test('object-valued identifiers are rejected (NoSQL injection guard)', async () => {
    const res = await app.request('/api/records', {
        method: 'POST',
        headers: bearer(ALICE),
        body: { deviceSerial: { $ne: null } }
    });
    assert.equal(res.status, 400);
});

test('malformed JSON gets a clean 400 without internal details', async () => {
    const res = await fetch(app.base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email": '
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { success: false, message: 'Invalid JSON payload format' });
});

test('re-adding a camera you already have updates it and returns 200', async () => {
    const res = await app.request('/api/user/add-camera', {
        method: 'POST',
        headers: bearer(ALICE),
        body: { deviceSerial: 'CAMA', validateCode: 'NEWCODE', deviceName: 'Renamed' }
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
});
