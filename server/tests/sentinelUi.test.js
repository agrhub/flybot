const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Must be set before config/env loads (dbHelpers loads it); the real URL is set once the stub listens
const TOKEN = 'operator-token-'.padEnd(48, 'q');
process.env.SENTINEL_UI_URL = 'http://127.0.0.1:9/ui';
process.env.SENTINEL_UI_TOKEN = TOKEN;

const { models, startDb, stopDb, clearDb, request, createUser, json } = require('./dbHelpers');
const env = require('../src/config/env');

// ---------- Stub Sentinel UI API (+ the "S3" its presigned URLs point to) ----------
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7), Buffer.from([0xff, 0xd9])]);
const PRESIGNED_SIG = 'X-Amz-Signature=deadbeefcafe';
let calls;
let mode; // per test: override answers ('401', '500', '404')
let stub;
let stubBase;

function stubHandler(req, res) {
    const url = new URL(req.url, 'http://stub');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
        calls.push(call);
        const send = (status, body, headers = {}) => {
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify(body));
        };
        if (url.pathname.startsWith('/s3/')) {
            if (!url.search.includes(PRESIGNED_SIG)) return send(403, { error: 'unsigned' });
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length, ETag: '"abc123"' });
            return res.end(JPEG);
        }
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } });
        if (mode === '401') return send(401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } });
        if (mode === '500') return send(500, { error: { code: 'INTERNAL', message: 'DynamoDB exploded at arn:aws:...' } });
        const p = url.pathname;
        if (p === '/ui/summary') return send(200, { role: 'operator', photos: 3, hours: Number(url.searchParams.get('hours') || 24) });
        if (p === '/ui/traces') return send(200, { items: [{ event_id: '01JT1', camera: 'BE4089629' }], next: null });
        if (p.startsWith('/ui/traces/')) {
            const id = decodeURIComponent(p.slice('/ui/traces/'.length));
            return id === 'missing' ? send(404, { error: { code: 'NOT_FOUND', message: 'trace not found' } }) : send(200, { trace: { event_id: id }, media: {} });
        }
        if (p === '/ui/approvals') return send(200, { items: [], next: null });
        if (/^\/ui\/approvals\/[^/]+$/.test(p)) return send(200, { approval: { approval_id: p.split('/').pop(), status: 'pending' }, media: {} });
        if (p.startsWith('/ui/devices/')) return send(200, { device: { serial: p.split('/').pop() }, media: {} });
        const decide = p.match(/^\/ui\/approvals\/([^/]+)\/decide$/);
        if (decide && req.method === 'POST') {
            if (decide[1] === 'apr_done') return send(409, { error: { code: 'CONFLICT', message: 'approval is not pending' } });
            return send(202, { queued: true, approval_id: decide[1], decision: call.body.decision });
        }
        if (p === '/ui/devices') return send(200, { items: [{ serial: 'BE4089629' }] });
        if (p === '/ui/density') return send(200, { dates: ['2026-10-14'] });
        if (p === '/ui/bench') return send(200, { items: [] });
        if (p === '/ui/evidence') {
            if (url.searchParams.get('json') !== '1') return send(302, {}, { Location: `${stubBase}/s3/x.jpg?${PRESIGNED_SIG}` });
            const key = url.searchParams.get('key');
            if (key.includes('gone')) return send(404, { error: { code: 'NOT_FOUND', message: 'no such object' } });
            return send(200, { url: `${stubBase}/s3/${key.replace(/^s3:\/\/[^/]+\//, '')}?${PRESIGNED_SIG}`, expires_in: 600 });
        }
        return send(404, { error: { code: 'NOT_FOUND', message: 'route' } });
    });
}

before(async () => {
    stub = http.createServer(stubHandler);
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubBase = `http://127.0.0.1:${stub.address().port}`;
    await startDb();
});
after(async () => {
    stub?.closeAllConnections?.();
    await new Promise((resolve) => stub.close(resolve));
    await stopDb();
});
beforeEach(async () => {
    await clearDb();
    calls = [];
    mode = null;
    env.SENTINEL_UI_URL = `${stubBase}/ui`;
    env.SENTINEL_UI_TOKEN = TOKEN;
});

const viewer = (extra = {}) => createUser({ role: 'user', sentinelViewer: true, name: 'Judge One', ...extra });
const uiCalls = () => calls.filter(c => c.path.startsWith('/ui/'));

/** Every answer must be free of the Sentinel token (body and headers). */
async function noLeak(res) {
    const text = await res.clone().text();
    assert.ok(!text.includes(TOKEN), 'token in body');
    for (const [, value] of res.headers) assert.ok(!value.includes(TOKEN), 'token in a header');
    return res;
}
const get = async (path, as) => noLeak(await request(`/api/sentinel/ui${path}`, { as }));
const post = async (path, as, body) => noLeak(await request(`/api/sentinel/ui${path}`, { method: 'POST', as, body }));

// ---------- Configuration ----------

test('disabled: every route answers 503 SENTINEL_DISABLED and the profile hides the menu', async () => {
    env.SENTINEL_UI_URL = '';
    const admin = await createUser({ role: 'admin' });
    for (const [path, as] of [['/summary', undefined], ['/summary', admin], ['/evidence?key=frames/a.jpg', admin], ['/nope', admin]]) {
        const { status, body } = await json(await get(path, as));
        assert.equal(status, 503);
        assert.equal(body.code, 'SENTINEL_DISABLED');
    }
    const decide = await json(await post('/approvals/apr_1/decide', admin, { decision: 'approve' }));
    assert.equal(decide.status, 503);
    assert.equal(calls.length, 0);

    const me = await json(await request('/api/auth/me', { as: admin }));
    assert.equal(me.body.user.sentinelEnabled, false);
    assert.equal(me.body.user.sentinelCanDecide, false);
    const info = await json(await request('/api/system/info', { as: admin }));
    assert.deepEqual(info.body.info.sentinel, { enabled: false, canDecide: false });
});

test('a URL without a token counts as disabled', async () => {
    env.SENTINEL_UI_TOKEN = '';
    const admin = await createUser({ role: 'admin' });
    assert.equal((await get('/summary', admin)).status, 503);
});

test('env: SENTINEL_UI_URL is normalized to a base ending in /ui and must be https', () => {
    const key = require.resolve('../src/config/env');
    const loaded = require.cache[key];
    const load = (value) => {
        const saved = process.env.SENTINEL_UI_URL;
        process.env.SENTINEL_UI_URL = value;
        delete require.cache[key];
        const origWarn = console.warn;
        console.warn = () => {};
        try {
            return require('../src/config/env').SENTINEL_UI_URL;
        } finally {
            console.warn = origWarn;
            process.env.SENTINEL_UI_URL = saved;
            // Keep the instance the app already holds
            require.cache[key] = loaded;
        }
    };
    assert.equal(load('https://abc.execute-api.ap-southeast-2.amazonaws.com/ui/'), 'https://abc.execute-api.ap-southeast-2.amazonaws.com/ui');
    assert.equal(load('https://d146vb7dg01iax.cloudfront.net'), 'https://d146vb7dg01iax.cloudfront.net/ui');
    assert.equal(load('http://example.com/ui'), '');
    assert.equal(load('http://127.0.0.1:4000/ui'), 'http://127.0.0.1:4000/ui');
    assert.equal(load('https://x.test/ui?token=1'), '');
    assert.equal(load('not a url'), '');
    assert.equal(require('../src/config/env'), env);
});

// ---------- Who may use it ----------

test('sign-in required; a "user" account without sentinelViewer gets 403 and nothing reaches Sentinel', async () => {
    assert.equal((await get('/summary')).status, 401);
    const plain = await createUser({ role: 'user' });
    const { status, body } = await json(await get('/summary', plain));
    assert.equal(status, 403);
    assert.equal(body.code, 'FORBIDDEN');
    assert.equal((await get('/evidence?key=frames/a.jpg', plain)).status, 403);
    assert.equal(calls.length, 0);

    const me = await json(await request('/api/auth/me', { as: plain }));
    assert.equal(me.body.user.sentinelEnabled, false);
});

test('viewer (sentinelViewer): reads every allowed route with FlyBot\'s operator token', async () => {
    const judge = await viewer();
    const me = await json(await request('/api/auth/me', { as: judge }));
    assert.equal(me.body.user.sentinelEnabled, true);
    assert.equal(me.body.user.sentinelCanDecide, false);
    const info = await json(await request('/api/system/info', { as: judge }));
    assert.deepEqual(info.body.info.sentinel, { enabled: true, canDecide: false });

    const summary = await json(await get('/summary?hours=12', judge));
    assert.equal(summary.status, 200);
    assert.equal(summary.body.photos, 3);
    assert.equal(summary.body.hours, 12);
    // Sentinel answered "operator" (FlyBot's token); the person is read-only
    assert.equal(summary.body.role, 'judge');
    const manager = await createUser({ role: 'manager' });
    assert.equal((await json(await get('/summary', manager))).body.role, 'operator');
    for (const path of ['/traces', '/traces/01JT1', '/approvals?status=pending', '/approvals/apr_1', '/devices', '/devices/BE4089629', '/density?date=2026-10-14', '/bench?name=cool_c8g.json']) {
        const res = await get(path, judge);
        assert.equal(res.status, 200, path);
        assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.ok(uiCalls().length >= 9);
    for (const call of uiCalls()) assert.equal(call.auth, `Bearer ${TOKEN}`);
});

test('viewer cannot decide (403, Sentinel not called); manager decides with `by` set by FlyBot', async () => {
    const judge = await viewer();
    const denied = await json(await post('/approvals/apr_1/decide', judge, { decision: 'approve', by: 'Judge' }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'FORBIDDEN');
    assert.equal(uiCalls().length, 0);

    const manager = await createUser({ role: 'manager', name: 'Grace Grower', email: 'grace@example.test' });
    const ok = await json(await post('/approvals/apr_1/decide', manager, { decision: 'approve', by: 'Mallory the impostor' }));
    assert.equal(ok.status, 202);
    assert.equal(ok.body.queued, true);
    assert.equal(ok.body.by, 'Grace Grower <grace@example.test>');
    const [call] = uiCalls();
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/ui/approvals/apr_1/decide');
    assert.deepEqual(call.body, { decision: 'approve', by: 'Grace Grower <grace@example.test>' });
    assert.equal(call.auth, `Bearer ${TOKEN}`);

    // Audited in FlyBot (Admin → Audit log, category FlyBot Sentinel)
    let entry;
    for (let i = 0; i < 20 && !entry; i++) {
        entry = await models.AuditLog.findOne({ action: 'sentinel.approval_decided' });
        if (!entry) await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(entry);
    assert.equal(entry.actorEmail, 'grace@example.test');
    assert.equal(entry.targetId, 'apr_1');
});

test('decide: admin allowed; bad decision 400 before Sentinel; 409 passed on; long names fall back to the email', async () => {
    const admin = await createUser({ role: 'admin', name: 'A'.repeat(90), email: 'boss@example.test' });
    const badBody = await json(await post('/approvals/apr_1/decide', admin, { decision: 'maybe' }));
    assert.equal(badBody.status, 400);
    assert.equal(uiCalls().length, 0);

    const conflict = await json(await post('/approvals/apr_done/decide', admin, { decision: 'reject' }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'CONFLICT');

    const ok = await json(await post('/approvals/apr_2/decide', admin, { decision: 'reject' }));
    assert.equal(ok.status, 202);
    assert.equal(uiCalls().at(-1).body.by, 'boss@example.test');
});

// ---------- Allow-list ----------

test('allow-list: unknown paths and methods answer 404 without calling Sentinel', async () => {
    const admin = await createUser({ role: 'admin' });
    for (const path of ['/health', '/kill-switch', '/devices/BE4089629/state', '/approvals/apr_1/decide', '/traces/a/b']) {
        const res = await get(path, admin);
        assert.equal(res.status, 404, path);
    }
    for (const path of ['/summary', '/traces', '/approvals/apr_1', '/devices']) {
        assert.equal((await post(path, admin, {})).status, 404, `POST ${path}`);
    }
    assert.equal((await request('/api/sentinel/ui/approvals/apr_1/decide', { method: 'DELETE', as: admin })).status, 404);
    assert.equal(uiCalls().length, 0);
});

test('allow-list: only the route\'s own query parameters are forwarded, each validated', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await get('/traces?camera=BE4089629&limit=20&access_token=steal&json=1&loop=per_photo', admin);
    assert.equal(res.status, 200);
    assert.deepEqual(uiCalls()[0].query, { camera: 'BE4089629', limit: '20', loop: 'per_photo' });

    for (const path of ['/traces?camera=../x', '/traces?limit=1000', '/summary?hours=0', '/approvals?status=all', '/density?date=yesterday', '/bench?name=../secrets', '/traces?camera=a&camera=b']) {
        assert.equal((await get(path, admin)).status, 400, path);
    }
    assert.equal(uiCalls().length, 1);

    // Daily ids contain ":" and are sent encoded
    await get(`/traces/${encodeURIComponent('daily:farm1:2026-10-14')}`, admin);
    assert.equal(uiCalls().at(-1).path, '/ui/traces/daily%3Afarm1%3A2026-10-14');
});

// ---------- Upstream errors ----------

test('upstream errors become clean JSON (never 401, no upstream details)', async () => {
    const admin = await createUser({ role: 'admin' });
    mode = '401';
    let r = await json(await get('/summary', admin));
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'SENTINEL_AUTH');

    mode = '500';
    r = await json(await get('/summary', admin));
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'SENTINEL_UPSTREAM');
    assert.ok(!JSON.stringify(r.body).includes('arn:aws'));

    mode = null;
    r = await json(await get('/traces/missing', admin));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'NOT_FOUND');

    env.SENTINEL_UI_URL = 'http://127.0.0.1:9/ui'; // nothing listens there
    r = await json(await get('/summary', admin));
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'SENTINEL_UNREACHABLE');
});

// ---------- Evidence ----------

test('evidence: streams the image with cache headers; no token or presigned URL reaches the browser', async () => {
    const judge = await viewer();
    const res = await get('/evidence?key=s3://sentinel-685527430355-dev/frames/BE4089629/2026/10/15/01JT1.jpg', judge);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(res.headers.get('etag'), '"abc123"');
    assert.equal(res.headers.get('content-disposition'), 'inline');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, JPEG);
    for (const [, value] of res.headers) assert.ok(!value.includes('X-Amz') && !value.includes('/s3/'));

    const [lookup, fetchObj] = calls;
    assert.equal(lookup.path, '/ui/evidence');
    assert.equal(lookup.query.json, '1');
    assert.equal(lookup.auth, `Bearer ${TOKEN}`);
    assert.equal(fetchObj.path, '/s3/frames/BE4089629/2026/10/15/01JT1.jpg');
    // The presigned request carries no Sentinel token
    assert.equal(fetchObj.auth, undefined);
});

test('evidence: keys outside the allowed prefixes are refused; a missing object is 404', async () => {
    const admin = await createUser({ role: 'admin' });
    for (const key of ['', 'secrets/ui-token.txt', 'frames/../secrets/x', 's3://bucket/agent_state/x.json', 'https://evil.test/frames/x.jpg']) {
        assert.equal((await get(`/evidence?key=${encodeURIComponent(key)}`, admin)).status, 400, key);
    }
    assert.equal(calls.length, 0);
    const gone = await json(await get('/evidence?key=evidence/gone.jpg', admin));
    assert.equal(gone.status, 404);
});

// ---------- Admin switch ----------

test('admin turns sentinelViewer on and off (audited); other values refused', async () => {
    const admin = await createUser({ role: 'admin' });
    const judge = await createUser({ role: 'user' });
    const bad = await json(await request(`/api/admin/users/${judge._id}`, { method: 'PUT', as: admin, body: { sentinelViewer: 'yes' } }));
    assert.equal(bad.status, 400);

    const on = await json(await request(`/api/admin/users/${judge._id}`, { method: 'PUT', as: admin, body: { sentinelViewer: true } }));
    assert.equal(on.status, 200);
    assert.equal(on.body.user.sentinelViewer, true);
    assert.equal((await get('/summary', await models.User.findById(judge._id))).status, 200);

    await request(`/api/admin/users/${judge._id}`, { method: 'PUT', as: admin, body: { sentinelViewer: false } });
    assert.equal((await get('/summary', judge)).status, 403);
    let entries = [];
    for (let i = 0; i < 20 && entries.length < 2; i++) {
        entries = await models.AuditLog.find({ action: 'user.sentinel_access_changed' });
        if (entries.length < 2) await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(entries.length, 2);

    // A manager cannot change it (admin-only route)
    const manager = await createUser({ role: 'manager' });
    assert.equal((await request(`/api/admin/users/${judge._id}`, { method: 'PUT', as: manager, body: { sentinelViewer: true } })).status, 403);
});
