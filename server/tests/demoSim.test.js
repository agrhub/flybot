const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jpeg = require('jpeg-js');

// Must be set before config/env loads (dbHelpers loads it); the URL is set once the stub listens
process.env.AI_PROVIDER = 'opencv-lambda';
process.env.PHOTOS_BY_REFERENCE = 'true';
process.env.VISION_LAMBDA_URL = 'http://127.0.0.1:9/invoke';
process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const env = require('../src/config/env');
const s3Service = require('../src/services/s3Service');
const settingsService = require('../src/services/settingsService');
const visionLambda = require('../src/services/visionLambda');
const demoSim = require('../src/services/demoSim');
const world = require('../src/services/demoSimWorld');
const { viewableCameras } = require('../src/utils/ownership');
const { buildWeeklyReport } = require('../src/services/reportService');

// ---------- Stubs: the bucket in memory, a local vision Lambda ----------
const bucket = new Map();
s3Service.uploadSnapshot = async (key, buffer) => { bucket.set(key, Buffer.from(buffer)); return {}; };
s3Service.readS3Buffer = async (key) => {
    if (!bucket.has(key)) throw new Error(`NoSuchKey ${key}`);
    return bucket.get(key);
};
s3Service.deleteS3Object = async (key) => { bucket.delete(key); };

const lambdaCalls = [];
const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = JSON.parse(raw);
        lambdaCalls.push(body);
        // As the handler does (flybot-aws docs/CONTRACTS.md section 1)
        if (!['ezviz', 'camos', 'kinesis'].includes(body.camera.platform)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ v: 1, error: { code: 'bad_request', message: 'camera.platform must be one of (ezviz, camos, kinesis)' } }));
        }
        const sticky = body.camera.trapKind === 'sticky';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            v: 1,
            traceId: `tr_${lambdaCalls.length}`,
            model: { name: 'yolo26n', version: '2026-10-16', engine: 'opencv-5.0.0-dnn-new' },
            counts: { total: sticky ? 0 : 5, byClass: sticky ? {} : { fruit_fly: 5 } },
            boxes: [],
            quality: { ok: true, flags: [] },
            proposals: sticky ? [{ id: 'p1', action: 'review_request', params: {}, reason: 'Check the card', confidence: 0.5 }] : [],
            trace: { planner: 'rule', steps: [{ tool: 'detect', ms: 10 }], ms: 20 },
            timings: { totalMs: 20, dnnMs: 10 }
        }));
    });
});

// ---------- A small synthetic set (manifest flybot-synth-manifest/1) ----------
function tinyJpeg(seed) {
    const width = 32;
    const height = 24;
    const data = Buffer.alloc(width * height * 4, 0);
    for (let i = 0; i < width * height; i++) data[i * 4] = (i * seed) % 255;
    return jpeg.encode({ data, width, height }, 70).data;
}

let root;
let dir;
let poolDir;
function writeSet() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-synth-'));
    dir = path.join(root, 'demo-30d');
    poolDir = path.join(root, 'pool');
    fs.mkdirSync(dir);
    fs.mkdirSync(poolDir);
    const traps = [
        { id: 'demo-lure-a', name: 'Demo lure trap A', trapKind: 'lure', lat: 11.15, lon: 106.40 },
        { id: 'demo-lure-b', name: 'Demo lure trap B', trapKind: 'lure', lat: 11.1505, lon: 106.4005 },
        { id: 'demo-lure-c', name: 'Demo lure trap C', trapKind: 'lure', lat: 11.1497, lon: 106.4007 },
        { id: 'demo-sticky-d', name: 'Demo sticky card D', trapKind: 'sticky', lat: 11.1503, lon: 106.3998 }
    ];
    const photos = [];
    const checks = [];
    let n = 0;
    for (const trap of traps) {
        fs.mkdirSync(path.join(dir, 'images', trap.id), { recursive: true });
        for (const day of ['2026-09-19', '2026-09-20']) {
            ['06:30', '09:00'].forEach((hhmm, slot) => {
                n += 1;
                const at = new Date(`${day}T${hhmm}:00+07:00`);
                const ts = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
                const file = `images/${trap.id}/SYNTH_${trap.id}_${ts}.jpg`;
                fs.writeFileSync(path.join(dir, file), tinyJpeg(n));
                const photoId = `synth-${trap.id}-${ts}`;
                const trueCount = trap.trapKind === 'sticky' ? 10 + n : n % 9;
                photos.push({ photoId, synthetic: true, file, trap: trap.id, trapKind: trap.trapKind, capturedAt: at.toISOString(), localDate: day, slot, trueCount, width: 32, height: 24, boxes: [] });
                checks.push(JSON.stringify({ photoId, det: trap.trapKind === 'sticky' ? 0 : trueCount }));
            });
        }
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 'flybot-synth-manifest/1', synthetic: true, label: 'SIMULATED DATA (test)', credits: 'test', traps, photos }));
    fs.writeFileSync(path.join(dir, 'check.jsonl'), checks.join('\n'));

    // The reusable pool: no times, lure counts 0..19, sticky cards 20..200, a few damaged photos
    fs.mkdirSync(path.join(poolDir, 'images', 'pool'), { recursive: true });
    const poolPhotos = [];
    for (let i = 0; i < 30; i++) {
        const sticky = i >= 20;
        const photoId = `synth-pool-${sticky ? 'sticky' : 'lure'}-${String(i).padStart(4, '0')}`;
        const file = `images/pool/SYNTH_${photoId}.jpg`;
        fs.writeFileSync(path.join(poolDir, file), tinyJpeg(100 + i));
        const trueCount = sticky ? 20 + (i - 20) * 20 : i;
        const defect = i % 7 === 3 ? { type: 'occluded_hand', severity: 0.6, expected: { flag: 'occluded', actions: ['capture_now'], counted: false } } : null;
        poolPhotos.push({ photoId, synthetic: true, file, trap: sticky ? 'pool-sticky' : 'pool-lure', trapKind: sticky ? 'sticky' : 'lure', capturedAt: null, trueCount, visibleCount: defect ? Math.floor(trueCount / 2) : trueCount, defect, width: 32, height: 24, boxes: [] });
    }
    fs.writeFileSync(path.join(poolDir, 'manifest.json'), JSON.stringify({ schema: 'flybot-synth-manifest/1', synthetic: true, label: 'SIMULATED DATA (pool)', credits: 'test', traps: [{ id: 'pool-lure', trapKind: 'lure' }, { id: 'pool-sticky', trapKind: 'sticky' }], photos: poolPhotos }));
}

const UNTIL = new Date('2026-09-20T10:00:00+07:00');

before(async () => {
    await startDb();
    await clearDb();
    settingsService.clearCache();
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    env.VISION_LAMBDA_URL = `http://127.0.0.1:${stub.address().port}/invoke`;
    visionLambda.setRetryDelay(60000);
    writeSet();
});
after(async () => {
    stub.close();
    fs.rmSync(root, { recursive: true, force: true });
    await stopDb();
});

// ---------- The world (pure) ----------

test('the world: farms across five regions, sticky and lure traps, a showcase farm from the set', () => {
    const farms = world.buildWorld([{ id: 'a', trapKind: 'lure' }, { id: 'd', trapKind: 'sticky' }]);
    const traps = world.trapsOf(farms);
    assert.equal(farms.length, world.FARMS.length + 1);
    assert.deepEqual([...new Set(world.FARMS.map(f => f.region))].sort(), ['central', 'highlands', 'mekong', 'north', 'southeast']);
    assert.ok(traps.every(t => /^SIM-[A-Z]+-[0-9A-Z]+$/.test(t.serial) && t.name.startsWith('SIM · ')));
    assert.ok(traps.some(t => t.kind === 'sticky') && traps.some(t => t.kind === 'lure'));
    assert.equal(new Set(traps.map(t => t.serial)).size, traps.length, 'serials are unique');
    assert.deepEqual(farms[0].plots[0].traps.map(t => [t.serial, t.kind]), [['SIM-SHOW-A', 'lure'], ['SIM-SHOW-B', 'sticky']]);
    assert.ok(farms.every(f => f.plots.every(p => p.boundary.length === 4)));
});

test('the world: deterministic levels, treatments lower them, the north is quiet in October', () => {
    const farm = world.buildWorld().find(f => f.key === 'CAIBE');
    const trap = { ...farm.plots[0].traps[1], farm };
    const log = world.fieldLogOf(farm, '2026-11-10');
    assert.deepEqual(log, world.fieldLogOf(farm, '2026-11-10'), 'same plan every time');
    assert.ok(log.some(t => ['spray', 'bait'].includes(t.type)), 'the Mekong wave calls for action');
    const first = log.find(t => ['spray', 'bait'].includes(t.type));
    assert.ok(world.treatmentFactor(log, first.index + 1) < 0.6, 'a spray removes flies');
    assert.equal(world.lureTarget(trap, '2026-10-20', 0, log), world.lureTarget(trap, '2026-10-20', 0, log));
    const north = world.buildWorld().find(f => f.key === 'LUCNGAN');
    assert.ok(world.seasonal('north', '2026-10-20') < world.seasonal('mekong', '2026-10-20') / 3);
    assert.deepEqual(world.fieldLogOf(north, '2026-11-10').filter(t => t.type !== 'sanitation'), []);
    // A sticky card only grows during its week, then starts again
    const sticky = { ...farm.plots[0].traps[0], farm };
    assert.equal(sticky.kind, 'sticky');
    const day = world.addDays(world.START_DAY, 5);
    assert.ok(world.stickyTarget(sticky, day, 1, [], 2) >= world.stickyTarget(sticky, day, 0, [], 2));
    assert.ok(world.stickyTarget(sticky, world.addDays(world.START_DAY, 7), 0, [], 2) < world.stickyTarget(sticky, day, 1, [], 2));
});

test('photo choice: the count nearest the target, now and then a damaged photo, the same every time', () => {
    const pool = [
        ...Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, trapKind: 'lure', truth: i, det: i })),
        { id: 'blur', trapKind: 'lure', truth: 5, det: 0, defect: 'blur' },
        { id: 'hand', trapKind: 'lure', truth: 8, visible: 3, defect: 'occluded_hand' }
    ];
    const picks = Array.from({ length: 400 }, (_, i) => demoSim.pickPhoto(pool, 12, `k${i}`));
    const damaged = picks.filter(p => p.defect).length;
    assert.ok(damaged > 5 && damaged < 60, `about 6 % damaged (${damaged} / 400)`);
    assert.ok(picks.filter(p => !p.defect).every(p => Math.abs(p.det - 12) <= 1), 'clean picks match the target');
    assert.equal(demoSim.pickPhoto(pool, 12, 'same').id, demoSim.pickPhoto(pool, 12, 'same').id);
    assert.equal(demoSim.pickPhoto([], 3, 'x'), null);
});

// ---------- Seed ----------

test('pool, dry run, apply: everything labeled simulated, analyzed by the pipeline, idempotent', async () => {
    const dry = await demoSim.uploadPool({ dirs: [dir, poolDir], dryRun: true });
    // The pool set adds photos, not showcase traps
    assert.deepEqual(dry, { photos: 16 + 30, detected: 16, traps: 4, uploaded: 0 });
    assert.equal(bucket.size, 0, 'a dry run writes nothing');
    await demoSim.uploadPool({ dirs: [dir, poolDir], dryRun: false });
    assert.ok(bucket.has('simulated/pool/pool/pool/SYNTH_synth-pool-lure-0003.jpg'));
    assert.ok([...bucket.keys()].some(k => k.startsWith('simulated/pool/demo-30d/demo-lure-a/')));
    assert.ok(bucket.has(demoSim.POOL_INDEX));

    const plan = await demoSim.simulate({ until: UNTIL, dryRun: true });
    assert.equal(plan.cameras, world.FARMS.length * 4 + 4);
    // Showcase: 4 traps x 7 slots (19th: 5, 20th: 06:30 and 09:00; slots the set lacks come from
    // the pool); nationwide: 36 traps x 3 slots (19th: 2, 20th: 07:00)
    assert.equal(plan.photosDue, 4 * 7 + 36 * 3);
    assert.equal(await models.Camera.countDocuments(), 0, 'a dry run writes nothing');

    const real = await createUser({ role: 'manager', email: 'grower@example.test' });
    await createCamera(real, { deviceSerial: 'REAL1', deviceName: 'Real trap' });

    const result = await demoSim.simulate({ until: UNTIL, dryRun: false, concurrency: 8 });
    assert.equal(result.released, plan.photosDue);
    assert.equal(result.failed, 0);
    assert.equal(lambdaCalls.length, plan.photosDue, 'every photo went through the vision Lambda');

    const org = await models.Organization.findOne({ simulated: true }).lean();
    assert.equal(org.name, demoSim.ORG_NAME);
    const cameras = await models.Camera.find({ simulated: true }).lean();
    assert.equal(cameras.length, plan.cameras);
    assert.ok(cameras.every(c => c.platform === 'simulated' && String(c.orgId) === String(org._id) && c.farmId && c.plotId));
    assert.ok((await models.Farm.find({ simulated: true }).lean()).every(f => / \(mô phỏng\)$/.test(f.name)));
    const snaps = await models.Snapshot.find({ simulated: true }).lean();
    assert.equal(snaps.length, plan.photosDue);
    assert.ok(snaps.every(s => s.aiProcessed && s.lambda.status === 'ok' && Number.isFinite(s.simulation.truth) && /^snapshots\/SIM-[^/]+\/SYNTH_/.test(s.s3Key)));
    // The showcase photos keep their set's time; the stored count is the pipeline's, the truth beside it
    const show = snaps.find(s => s.deviceSerial === 'SIM-SHOW-D');
    assert.equal(show.pestCount, 0);
    assert.ok(show.simulation.truth > 10);
    // Proposals of simulated photos: simulated, dated with their photo, one per camera and day
    const proposals = await models.SentinelProposal.find({ simulated: true }).lean();
    assert.ok(proposals.length > 0);
    assert.ok(proposals.every(p => p.createdAt < UNTIL && p.createdAt >= new Date('2026-09-19T00:00:00+07:00')));
    assert.equal(await models.AuditLog.countDocuments({ action: 'sentinel.proposal_created' }), 0, 'no activity log entries');
    assert.ok(await models.Treatment.countDocuments({ simulated: true }) >= 0);
    assert.ok(await models.MaintenanceEvent.countDocuments({ simulated: true, type: 'card_replaced' }) >= 10, 'sticky cards start on the first day');
    assert.ok((await models.DailyStat.find({ deviceSerial: { $in: cameras.map(c => c.deviceSerial) } }).lean()).every(d => d.simulated === true));

    const again = await demoSim.simulate({ until: UNTIL, dryRun: false });
    assert.equal(again.released, 0, 'nothing twice');
    assert.deepEqual(again.created, { org: 0, farms: 0, plots: 0, cameras: 0 });
});

// ---------- Who sees it ----------

test('visitors see the simulated farm read-only when it is shown; background jobs never use it', async () => {
    const visitor = await createUser({ email: 'judge@example.test' });
    const cameras = async (as) => (await json(await request('/api/user/cameras', { as }))).body.cameras;
    assert.equal((await cameras(visitor)).length, 0, 'not shown yet');

    await settingsService.updateSettings({ demoViewEnabled: true, demoViewAudience: 'all', demoViewCameras: [], demoViewSimulated: true }, null);
    require('../src/services/demoView').clearCache();
    const seen = await cameras(visitor);
    assert.equal(seen.length, world.FARMS.length * 4 + 4);
    assert.ok(seen.every(c => c.simulated && c.access === 'demo' && !c.canManage && c.liveOpen === false && c.owner === null));
    const farms = (await json(await request('/api/farms', { as: visitor }))).body.farms;
    assert.ok(farms.length > 0 && farms.every(f => f.simulated && !f.canEdit));
    // The dashboard's density card filters by farm: each trap carries its farm's name and the label
    const overview = (await json(await request('/api/ai/overview', { as: visitor }))).body;
    const realtime = overview.overview.cameraRealtimeList;
    assert.ok(realtime.length > 0 && realtime.every(c => c.simulated && c.farmId && / \(mô phỏng\)$/.test(c.farmName)));
    const me = (await json(await request('/api/auth/me', { as: visitor }))).body.user;
    assert.equal(me.simulatedData, true);
    assert.equal(me.demoView.simulated, true);

    // Nothing to change, no live view, no deciding
    const serial = seen[0].deviceSerial;
    assert.equal((await request('/api/user/camera/capture', { method: 'POST', as: visitor, body: { deviceSerial: serial } })).status, 404);
    const live = await json(await request(`/api/cameras/${serial}/live`, { as: visitor }));
    assert.equal(live.status, 403);
    assert.equal(live.body.code, 'SIMULATED_CAMERA');
    const approvals = (await json(await request('/api/sentinel/ui/approvals', { as: visitor }))).body.items;
    assert.ok(approvals.length > 0 && approvals.every(a => a.can_decide === false));

    // An admin sees them in the app, labeled, but cannot capture or decide on them
    const admin = await createUser({ role: 'admin', email: 'admin@example.test' });
    const capture = await json(await request('/api/user/camera/capture', { method: 'POST', as: admin, body: { deviceSerial: serial } }));
    assert.equal(capture.status, 409);
    const pending = await models.SentinelProposal.findOne({ simulated: true, state: 'pending' }).lean();
    if (pending) {
        const decided = await json(await request(`/api/sentinel/ui/approvals/${pending._id}/decide`, { method: 'POST', as: admin, body: { decision: 'approve' } }));
        assert.equal(decided.status, 409);
    }

    // Background jobs read User documents: no simulated camera, for anyone
    const adminDoc = await models.User.findById(admin._id);
    assert.deepEqual((await viewableCameras(adminDoc).lean()).map(c => c.deviceSerial), ['REAL1']);
    const system = await models.User.findOne({ email: demoSim.SYSTEM_EMAIL });
    assert.equal(await buildWeeklyReport(system), null);
    assert.equal(system.emailVerified, false);
});

// ---------- Daily simulation ----------

test('the daily simulation runs only when turned on, until its end date, and adds each slot once', async () => {
    const later = new Date('2026-09-20T16:00:00+07:00');
    assert.equal(await demoSim.runDaily(later), null, 'off by default');
    await settingsService.updateSettings({ demoSimEnabled: true, demoSimUntil: '2026-11-10T23:59:59+07:00' }, null);
    const first = await demoSim.runDaily(later);
    // The 15:30 slot of the 36 nationwide traps, the 11:30 and 14:00 slots of the 4 showcase traps
    assert.equal(first.released, 36 + 4 * 2);
    assert.equal((await demoSim.runDaily(later)).released, 0);
    await settingsService.updateSettings({ demoSimUntil: '2026-09-20T12:00:00+07:00' }, null);
    assert.equal((await demoSim.runDaily(new Date('2026-09-21T16:00:00+07:00'))).released, 0, 'nothing after the end date');
});

// ---------- Removal ----------

test('remove: every simulated document and photo goes, real data stays', async () => {
    const counts = await demoSim.remove({ dryRun: true });
    assert.ok(counts.photos > 0 && counts.cameras > 0);
    await demoSim.remove({ dryRun: false });
    for (const model of ['Organization', 'Farm', 'Plot', 'Camera', 'Snapshot', 'Treatment', 'MaintenanceEvent', 'SentinelProposal']) {
        assert.equal(await models[model].countDocuments({ simulated: true }), 0, model);
    }
    assert.equal(await models.User.countDocuments({ email: demoSim.SYSTEM_EMAIL }), 0);
    assert.ok(await models.Camera.exists({ deviceSerial: 'REAL1' }));
    assert.ok([...bucket.keys()].every(k => !k.startsWith('snapshots/SIM-')), 'photo copies deleted');
});
