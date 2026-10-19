const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Must be set before config/env loads (dbHelpers loads it)
process.env.AI_PROVIDER = 'opencv-lambda';
process.env.VISION_LAMBDA_URL = 'http://127.0.0.1:9/invoke';
process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const env = require('../src/config/env');
const sentinelService = require('../src/services/sentinelService');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    env.AI_PROVIDER = 'opencv-lambda';
    env.SENTINEL_CONSOLE = false;
});

const get = (path, as) => request(`/api/sentinel/ui${path}`, { as });
const post = (path, as, body) => request(`/api/sentinel/ui${path}`, { method: 'POST', as, body });
const viewer = (extra = {}) => createUser({ role: 'user', sentinelViewer: true, name: 'Judge One', ...extra });

/** An orchard: a manager with two analyzed photos on CAM1 (one with a proposal), a judge who sees CAM1 only. */
async function orchard() {
    const owner = await createUser({ role: 'manager', name: 'Grace Grower', email: 'grace@example.test' });
    const judge = await viewer();
    const cam1 = await createCamera(owner, { deviceSerial: 'CAM1', deviceName: 'Lô A', trapKind: 'lure', status: 1, sharedWith: [{ userId: judge._id, email: judge.email }] });
    await createCamera(owner, { deviceSerial: 'CAM2', deviceName: 'Lô B', status: 0 });
    const lambda = (traceId, total, extra = {}) => ({
        status: 'ok', attempts: 1, analyzedAt: new Date(), traceId,
        model: { name: 'yolo26n', version: '2026-10-18', engine: 'opencv-5.0.0-dnn-new' },
        counts: { total, byClass: { fruit_fly: total } },
        quality: { ok: true, flags: [], blur: 0.1, exposure: 0.5 },
        trace: { planner: 'rule', steps: [{ tool: 'detect', ms: 410 }], ms: 1320 },
        evidence: { annotatedS3Key: null, crops: [] },
        boxes: [{ x: 0.5, y: 0.25, w: 0.1, h: 0.2, score: 0.91, cls: 'fruit_fly' }],
        width: 1600,
        height: 1200,
        timings: { totalMs: 1320, dnnMs: 410 },
        ...extra
    });
    const old = await models.Snapshot.create({ deviceSerial: 'CAM1', imageUrl: 'x', s3Key: 'snapshots/CAM1/a.jpg', createdAt: new Date(Date.now() - 3600 * 1000), aiProcessed: true, aiProvider: 'opencv-lambda', aiResults: { summary: { fruit_fly: 5 } }, lambda: lambda('tr_old', 5) });
    const latest = await models.Snapshot.create({
        deviceSerial: 'CAM1', imageUrl: 'x', s3Key: 'snapshots/CAM1/b.jpg', aiProcessed: true, aiProvider: 'opencv-lambda', aiResults: { summary: { fruit_fly: 14 } },
        meta: { battery: { pct: 72 }, rssi: -61 },
        lambda: lambda('tr_new', 14, { privacy: { person_suspected: true, regions: [{ x: 0.7, y: 0.1, w: 0.1, h: 0.15 }], method: 'yunet' }, diff: { newCount: 9, goneCount: 0, cardMoved: false }, quality: { ok: false, flags: ['dark'], blur: 0.3, exposure: 0.2 }, proposals: [{ id: 'p1', action: 'set_interval', params: { minutes: 15 }, reason: 'Count doubled', confidence: 0.8 }] })
    });
    const other = await models.Snapshot.create({ deviceSerial: 'CAM2', imageUrl: 'x', s3Key: 'snapshots/CAM2/c.jpg', aiProcessed: true, aiProvider: 'opencv-lambda', aiResults: { summary: { fruit_fly: 1 } }, lambda: lambda('tr_cam2', 1) });
    const [created] = await sentinelService.createLambdaProposals({ snapshot: latest, camera: cam1.toObject(), proposals: latest.lambda.proposals, traceId: 'tr_new' });
    return { owner, judge, cam1, old, latest, other, proposal: created.proposal };
}

// ---------- Configuration and access ----------

test('off unless AI_PROVIDER=opencv-lambda or SENTINEL_CONSOLE: 503 everywhere, menu hidden', async () => {
    env.AI_PROVIDER = 'roboflow';
    const admin = await createUser({ role: 'admin' });
    for (const [path, as] of [['/summary', undefined], ['/summary', admin], ['/evidence?key=snapshots/CAM1/a.jpg', admin], ['/nope', admin]]) {
        const { status, body } = await json(await get(path, as));
        assert.equal(status, 503, path);
        assert.equal(body.code, 'SENTINEL_DISABLED');
    }
    const me = await json(await request('/api/auth/me', { as: admin }));
    assert.equal(me.body.user.sentinelEnabled, false);
    assert.equal(me.body.user.sentinelCanDecide, false);
    env.SENTINEL_CONSOLE = true;
    assert.equal((await get('/summary', admin)).status, 200, 'SENTINEL_CONSOLE=true turns it on with any provider');
    const info = await json(await request('/api/system/info', { as: admin }));
    assert.deepEqual(info.body.info.sentinel, { enabled: true, canDecide: true });
});

test('sign-in required; a member who does not run the current workspace (and is no sentinelViewer) gets 403', async () => {
    assert.equal((await get('/summary')).status, 401);
    const plain = await createUser({ role: 'user' });
    const lead = await createUser({ role: 'user', email: 'lead@example.test' });
    const org = await models.Organization.create({ name: 'Co', kind: 'organization', members: [{ userId: lead._id, email: lead.email, role: 'owner' }, { userId: plain._id, email: plain.email, role: 'member' }] });
    const asMember = { 'X-Workspace-Id': String(org._id) };
    const { status, body } = await json(await request('/api/sentinel/ui/summary', { as: plain, headers: asMember }));
    assert.equal(status, 403);
    assert.equal(body.code, 'FORBIDDEN');
    assert.equal((await request('/api/sentinel/ui/evidence?key=snapshots/CAM1/a.jpg', { as: plain, headers: asMember })).status, 403);
    const me = await json(await request('/api/auth/me', { as: plain, headers: asMember }));
    assert.equal(me.body.user.sentinelEnabled, false);
    // In their own personal workspace they run things: their cameras' console
    assert.equal((await get('/summary', plain)).status, 200);
});

// ---------- Pages ----------

test('summary: the judge reads only the cameras shared with them; managers are operators', async () => {
    const { owner, judge } = await orchard();
    const me = await json(await request('/api/auth/me', { as: judge }));
    assert.equal(me.body.user.sentinelEnabled, true);
    assert.equal(me.body.user.sentinelCanDecide, false);

    const summary = await json(await get('/summary?hours=12', judge));
    assert.equal(summary.status, 200);
    assert.equal(summary.body.role, 'judge');
    assert.equal(summary.body.hours, 12);
    assert.equal(summary.body.photos, 2, 'CAM1 only');
    assert.deepEqual(summary.body.photos_by_source, { ezviz: 2 });
    assert.deepEqual(summary.body.decisions, { set_interval: 1, no_op: 1 });
    assert.equal(summary.body.proposals_pending, 1);
    assert.deepEqual(summary.body.devices, { online: 1, total: 1 });
    assert.equal(summary.body.planner_mode, 'rule');
    assert.deepEqual(summary.body.kill_switch, { global: false, cameras: [] });
    assert.ok(summary.body.last_photo_at);

    const mine = await json(await get('/summary', owner));
    assert.equal(mine.body.role, 'operator');
    assert.equal(mine.body.photos, 3);
    assert.deepEqual(mine.body.devices, { online: 1, total: 2 });
    assert.equal((await get('/summary?hours=0', owner)).status, 400);
});

test('traces: analyzed photos newest first, filter by camera, cursor paging, one trace in full', async () => {
    const { owner, judge, latest, old, proposal } = await orchard();
    const raw = await get('/traces', judge);
    assert.equal(raw.headers.get('cache-control'), 'no-store');
    const list = await json(raw);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map(t => t.event_id), ['tr_new', 'tr_old']);
    const [first] = list.body.items;
    assert.equal(first.camera, 'CAM1');
    assert.equal(first.camera_name, 'Lô A');
    assert.equal(first.trap_kind, 'lure');
    assert.equal(first.source, 'ezviz');
    assert.deepEqual(first.counts, { opencv: 14, npu: null, production: 14 });
    assert.deepEqual(first.quality, { ok: false, issues: ['dark'] });
    assert.equal(first.outcome, 'proposed: set_interval');
    assert.deepEqual(first.decisions[0], { rule: 'set_interval', action: 'set_interval', reasons: ['Count doubled', 'confidence 0.8'], params: { minutes: 15 } });
    assert.deepEqual(first.approval, { approval_id: String(proposal._id), kind: 'set_interval', status: 'pending' });
    assert.equal(first.planner.name, 'rule');
    assert.equal(first.snapshot_id, String(latest._id));
    assert.equal(list.body.next, null);

    // Paging and filters
    const page = await json(await get('/traces?limit=1', judge));
    assert.equal(page.body.items.length, 1);
    assert.ok(page.body.next);
    const rest = await json(await get(`/traces?limit=1&cursor=${encodeURIComponent(page.body.next)}`, judge));
    assert.deepEqual(rest.body.items.map(t => t.event_id), ['tr_old']);
    assert.equal((await json(await get('/traces?camera=CAM2', judge))).body.items.length, 0, 'not shared with the judge');
    assert.equal((await json(await get('/traces?camera=CAM2', owner))).body.items.length, 1);
    assert.equal((await json(await get(`/traces?since=${encodeURIComponent(new Date(Date.now() - 600 * 1000).toISOString())}`, owner))).body.items.length, 2);

    // One trace: Perception -> Decision -> Action
    const one = await json(await get('/traces/tr_new', judge));
    assert.equal(one.status, 200);
    const trace = one.body.trace;
    const obs = trace.opencv_outputs.CAM1;
    assert.equal(obs.counts.opencv, 14);
    assert.deepEqual(obs.quality, { ok: false, issues: ['dark'], scores: { blur: 0.3, exposure: 0.2 } });
    assert.deepEqual(obs.new_catch, { new_count: 9, disappeared_count: 0, persisted_count: 5, card_change_suspected: false, card_change_reasons: [] });
    assert.equal(obs.image, 'snapshots/CAM1/b.jpg');
    assert.equal(obs.previous_image, 'snapshots/CAM1/a.jpg');
    // The Lambda stores no picture: the console draws the boxes and blurs the faces on FlyBot's photos
    assert.deepEqual(obs.evidence, []);
    assert.deepEqual(trace.overlays['snapshots/CAM1/b.jpg'], {
        boxes: [{ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }],
        privacy: { regions: [{ x: 0.7, y: 0.1, w: 0.1, h: 0.15 }], blurAll: false },
        width: 1600, height: 1200
    });
    assert.deepEqual(trace.overlays['snapshots/CAM1/a.jpg'].privacy, { regions: [], blurAll: false }, 'the previous photo too');
    assert.equal(obs.analyzer, 'yolo26n / 2026-10-18 / opencv-5.0.0-dnn-new');
    assert.equal(obs.vision_ms, 410);
    assert.equal(obs.battery_percent, 72);
    assert.deepEqual(trace.tool_calls.map(c => [c.name, c.status, c.ms]), [['detect', 'ok', 410]]);
    assert.equal(trace.approval.approval_id, String(proposal._id));
    assert.equal(trace.approval.payload.reason, 'Count doubled');
    assert.equal(trace.reasoning_summary, 'Count doubled');
    // By snapshot id too; unknown or another person's camera = 404
    assert.equal((await get(`/traces/snap_${old._id}`, judge)).status, 200);
    assert.equal((await get('/traces/tr_cam2', judge)).status, 404);
    assert.equal((await get('/traces/tr_cam2', owner)).status, 200);
    assert.equal((await get('/traces/nope', owner)).status, 404);
});

test('approvals: listed by status; the viewer cannot decide; a manager\'s decision runs the card once', async () => {
    const { owner, judge, proposal } = await orchard();
    const pending = await json(await get('/approvals?status=pending', judge));
    assert.equal(pending.status, 200);
    assert.equal(pending.body.items.length, 1);
    const [a] = pending.body.items;
    assert.equal(a.approval_id, String(proposal._id));
    assert.equal(a.event_id, 'tr_new');
    assert.equal(a.kind, 'set_interval');
    assert.equal(a.status, 'pending');
    assert.deepEqual(a.cameras, ['CAM1']);
    assert.deepEqual(a.payload, { action: 'set_interval', params: { minutes: 15 }, reason: 'Count doubled' });
    assert.equal(a.flybot_proposal_id, String(proposal._id));
    assert.ok(a.expires_at);
    // The photo to decide on comes with it, with the boxes and the face regions the console draws
    assert.deepEqual(a.evidence, ['snapshots/CAM1/b.jpg']);
    assert.deepEqual(a.overlays['snapshots/CAM1/b.jpg'].boxes, [{ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }]);
    assert.deepEqual(a.overlays['snapshots/CAM1/b.jpg'].privacy.regions, [{ x: 0.7, y: 0.1, w: 0.1, h: 0.15 }]);
    const alone = (await json(await get(`/approvals/${proposal._id}`, judge))).body.approval;
    assert.deepEqual([alone.evidence, alone.overlays], [a.evidence, a.overlays]);
    assert.equal((await json(await get('/approvals?status=approved', judge))).body.items.length, 0);
    assert.equal((await json(await get(`/approvals/${proposal._id}`, judge))).body.approval.status, 'pending');

    const denied = await json(await post(`/approvals/${proposal._id}/decide`, judge, { decision: 'approve' }));
    assert.equal(denied.status, 403);
    assert.equal((await json(await post(`/approvals/${proposal._id}/decide`, owner, { decision: 'maybe' }))).status, 400);
    assert.equal((await models.Camera.findOne({ deviceSerial: 'CAM1' }).lean()).sentinelInterval?.minutes, undefined, 'nothing applied yet');

    const ok = await json(await post(`/approvals/${proposal._id}/decide`, owner, { decision: 'approve', by: 'Mallory the impostor' }));
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.equal(ok.body.queued, true);
    assert.equal(ok.body.state, 'done');
    assert.equal(ok.body.by, 'Grace Grower <grace@example.test>');
    assert.equal((await models.Camera.findOne({ deviceSerial: 'CAM1' }).lean()).sentinelInterval.minutes, 15, 'the card ran');
    assert.equal((await json(await get(`/approvals/${proposal._id}`, judge))).body.approval.status, 'approved');
    assert.equal((await json(await get('/approvals?status=pending', judge))).body.items.length, 0);
    assert.equal((await json(await get('/approvals?status=approved', judge))).body.items.length, 1);
    const again = await json(await post(`/approvals/${proposal._id}/decide`, owner, { decision: 'reject' }));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'CONFLICT');
    assert.equal((await json(await post('/approvals/64b000000000000000000009/decide', owner, { decision: 'reject' }))).status, 404);

    let entry;
    for (let i = 0; i < 20 && !entry; i++) {
        entry = await models.AuditLog.findOne({ action: 'sentinel.approval_decided' });
        if (!entry) await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(entry);
    assert.equal(entry.actorEmail, 'grace@example.test');
    assert.equal(entry.targetId, String(proposal._id));
    // A trace now shows the decided approval
    assert.equal((await json(await get('/traces/tr_new', judge))).body.trace.approval.status, 'approved');
});

test('devices: the cameras with their last photo, telemetry, shadow and capture budget', async () => {
    const { owner, judge } = await orchard();
    await models.Camera.updateOne({ deviceSerial: 'CAM2' }, { $set: { platform: 'camos', device: { fw: '0.1.0', net: '4g', rssi: -70, battery: { pct: 61 }, power: { mode: 'battery' }, sleeping: true, wakeAt: new Date(Date.now() + 1800 * 1000), lastSeenAt: new Date(), shadow: { reported: { version: 3, video: { image: { brightness: 10 } } }, desired: { version: 4, video: { image: { brightness: 20 } } } } }, sentinelCaptures: { day: '2026-10-16', count: 2 } } });
    const list = await json(await get('/devices', judge));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map(d => d.serial), ['CAM1']);
    const all = await json(await get('/devices', owner));
    assert.deepEqual(all.body.items.map(d => d.serial), ['CAM1', 'CAM2']);
    const cam2 = all.body.items[1];
    assert.equal(cam2.source, 'camos');
    assert.equal(cam2.online, false);
    assert.equal(cam2.sleeping, true);
    assert.equal(cam2.power_mode, 'battery');
    assert.equal(cam2.battery_percent, 61);
    assert.equal(cam2.rssi, -70);
    assert.equal(cam2.fw, '0.1.0');
    assert.equal(cam2.reported_version, 3);
    assert.equal(cam2.desired_version, 4);
    assert.deepEqual(cam2.agent_state.budgets, { captures_used: 2, captures_limit: env.SENTINEL_CAPTURE_BUDGET });
    const cam1 = all.body.items[0];
    assert.equal(cam1.online, true);
    assert.equal(cam1.last_photo.key, 'snapshots/CAM1/b.jpg');
    assert.equal(cam1.last_photo.count, 14);

    const one = await json(await get('/devices/CAM1', judge));
    assert.equal(one.status, 200);
    assert.equal(one.body.device.serial, 'CAM1');
    assert.deepEqual(one.body.device.telemetry_history.map(h => h.battery_percent), [72]);
    assert.equal((await get('/devices/CAM2', judge)).status, 404);
});

test('evidence: pictures stream from FlyBot\'s bucket for visible cameras only; keys are checked', async () => {
    const { judge } = await orchard();
    const res = await get('/evidence?key=snapshots/CAM1/b.jpg', judge);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(await res.text(), 'JPEGDATA');
    assert.equal((await get('/evidence?key=evidence/CAM1/a.annotated.jpg', judge)).status, 200);
    assert.equal((await get('/evidence?key=snapshots/CAM2/c.jpg', judge)).status, 404, 'not shared with the judge');
    for (const key of ['snapshots/CAM1/../CAM2/c.jpg', 'secrets/CAM1/x.jpg', 'snapshots/CAM1/x.exe', 's3://bucket/snapshots/CAM1/b.jpg', '']) {
        assert.equal((await get(`/evidence?key=${encodeURIComponent(key)}`, judge)).status, 400, key);
    }
});

test('allow-list: unknown paths, methods and query parameters', async () => {
    const admin = await createUser({ role: 'admin' });
    for (const path of ['/health', '/kill-switch', '/devices/CAM1/state', '/approvals/apr_1/decide', '/traces/a/b', '/density', '/bench']) {
        assert.equal((await get(path, admin)).status, 404, path);
    }
    for (const path of ['/summary', '/traces', '/approvals/64b000000000000000000009', '/devices']) {
        assert.equal((await post(path, admin, {})).status, 404, `POST ${path}`);
    }
    assert.equal((await request('/api/sentinel/ui/approvals/64b000000000000000000009/decide', { method: 'DELETE', as: admin })).status, 404);
    for (const path of ['/traces?camera=../x', '/traces?limit=1000', '/summary?hours=0', '/approvals?status=all', '/traces?camera=a&camera=b', '/traces?cursor=' + 'x'.repeat(70)]) {
        assert.equal((await get(path, admin)).status, 400, path);
    }
});
