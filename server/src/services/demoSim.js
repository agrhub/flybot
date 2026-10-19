const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { User, Organization, Farm, Plot, Camera, Snapshot, Treatment, MaintenanceEvent, SentinelProposal, DailyStat, ChatSession, Notification } = require('../models');
const world = require('./demoSimWorld');

/**
 * The simulated demo farm for visitors such as competition judges (scripts/demo_sim.js):
 *  - one organization (simulated: true) owned by a system account nobody can sign in to, with farms
 *    across Vietnam's fruit regions, plots, traps (simulated platform: no device) and a field log;
 *  - labeled synthetic trap photos (flybot-aws data/synth: SYNTH_ file names, EXIF/XMP label and a
 *    visible SIMULATED stamp) released at their times, each analyzed by the REAL vision pipeline
 *    (services/visionLambda.js), so counts, boxes, quality flags, traces and proposals come from it;
 *    the number of flies drawn on a photo is kept beside it (Snapshot.simulation.truth) to compare
 *    the detector on sticky and lure traps, never shown as a detection;
 *  - everything carries simulated: true and is labeled wherever it is shown; background jobs never
 *    use it (utils/ownership.js viewFilter); remove() deletes all of it and nothing else.
 *
 * The photo pool lives in the bucket (simulated/pool.json + simulated/pool/*.jpg, uploadPool), so the
 * server needs no local files: simulate() and the daily job (runDaily) read it from there.
 */
const SYSTEM_EMAIL = 'simulated-demo@flybot.invalid';
const ORG_NAME = 'FlyBot demo farm (simulated data)';
const SYSTEM_NAME = 'FlyBot simulation';
const POOL_PREFIX = 'simulated/pool/';
const POOL_INDEX = 'simulated/pool.json';
const NOTE = 'Simulated data';
const LURE_REFILL_DAYS = 21;

const s3 = () => require('./s3Service');
const log = (...args) => console.log('🧪', ...args);

// ---------- Photo pool ----------

/**
 * The pool index of one or more synthetic sets (manifest.json of flybot-aws eval/synth, schema
 * flybot-synth-manifest/1: the showcase sets demo-30d and demo-ahead, and the reusable "pool" set).
 * One row per photo with its key in the bucket, simulated/pool/<set>/<trap>/<file>, so
 * `aws s3 sync <set>/images s3://<bucket>/simulated/pool/<set>/` uploads the same layout; from
 * check.jsonl when present, what the vision handler counted (to pick photos by detected count).
 * Showcase traps are the traps of sets whose photos have times; the pool's photos have none.
 */
function buildPoolIndex(dirs, { readFile = require('fs').readFileSync, exists = require('fs').existsSync } = {}) {
    const path = require('path');
    const photos = [];
    const traps = new Map();
    let label = null;
    let credits = null;
    let detectedCount = 0;
    for (const dir of [].concat(dirs)) {
        const set = path.basename(path.resolve(dir));
        const manifest = JSON.parse(readFile(path.join(dir, 'manifest.json'), 'utf8'));
        if (manifest.schema !== 'flybot-synth-manifest/1' || manifest.synthetic !== true) throw new Error(`${dir}: not a synthetic manifest (flybot-synth-manifest/1, synthetic: true).`);
        label = label || manifest.label;
        credits = credits || manifest.credits;
        const detected = new Map();
        const checkFile = path.join(dir, 'check.jsonl');
        if (exists(checkFile)) {
            for (const line of readFile(checkFile, 'utf8').split('\n').filter(Boolean)) {
                const row = JSON.parse(line);
                if (row.photoId && Number.isFinite(row.det)) detected.set(row.photoId, row.det);
            }
        }
        detectedCount += detected.size;
        const rows = manifest.photos.filter(p => p.synthetic === true);
        const timed = new Set(rows.filter(p => p.capturedAt).map(p => p.trap));
        for (const t of manifest.traps || []) if (timed.has(t.id) && !traps.has(t.id)) traps.set(t.id, t);
        for (const p of rows) {
            photos.push({
                id: p.photoId,
                set,
                file: p.file,
                key: `${POOL_PREFIX}${set}/${String(p.file).replace(/^images\//, '')}`,
                trapKind: p.trapKind === 'sticky' ? 'sticky' : 'lure',
                truth: p.trueCount,
                // Flies a person could see (fewer than drawn when a hand or a leaf hides some)
                ...(Number.isFinite(p.visibleCount) ? { visible: p.visibleCount } : {}),
                ...(detected.has(p.photoId) ? { det: detected.get(p.photoId) } : {}),
                // A deliberately damaged photo (blur, glare, a hand, a moved camera...)
                ...(p.defect?.type ? { defect: p.defect.type } : {}),
                width: p.width,
                height: p.height,
                setTrap: p.capturedAt ? p.trap : null,
                capturedAt: p.capturedAt || null,
                localDate: p.capturedAt ? p.localDate || null : null,
                slot: p.capturedAt && Number.isInteger(p.slot) ? p.slot : null
            });
        }
    }
    const ids = new Set();
    for (const p of photos) {
        if (ids.has(p.id)) throw new Error(`The photo ${p.id} is in two sets.`);
        ids.add(p.id);
    }
    return { index: { schema: 'flybot-sim-pool/1', synthetic: true, label, credits, traps: [...traps.values()], photos }, detected: detectedCount };
}

/** Upload synthetic sets to the bucket as the pool (through the app's storage settings). */
async function uploadPool({ dirs, dryRun = true, readFile = require('fs').readFileSync }) {
    const path = require('path');
    const list = [].concat(dirs);
    const { index, detected } = buildPoolIndex(list, { readFile });
    const { photos } = index;
    if (dryRun) return { photos: photos.length, detected, traps: index.traps.length, uploaded: 0 };
    const dirOf = new Map(list.map(d => [path.basename(path.resolve(d)), d]));
    let uploaded = 0;
    for (const [i, p] of photos.entries()) {
        await s3().uploadSnapshot(p.key, readFile(path.join(dirOf.get(p.set), p.file)), 'image/jpeg');
        uploaded += 1;
        if (uploaded % 100 === 0 || i === photos.length - 1) log(`pool: ${uploaded}/${photos.length} photos uploaded`);
    }
    await s3().uploadSnapshot(POOL_INDEX, Buffer.from(JSON.stringify(index)), 'application/json');
    return { photos: photos.length, detected, traps: index.traps.length, uploaded };
}

let poolCache = null;
async function loadPool({ fresh = false } = {}) {
    if (poolCache && !fresh) return poolCache;
    const pool = JSON.parse((await s3().readS3Buffer(POOL_INDEX)).toString('utf8'));
    if (pool.schema !== 'flybot-sim-pool/1' || pool.synthetic !== true) throw new Error('The simulated photo pool is not valid.');
    poolCache = pool;
    return pool;
}

// Share of the pool picks that are deliberately damaged photos, so quality flags and the agent's
// recapture or review proposals show now and then
const DEFECT_SHARE = 0.06;

/**
 * The pool photo whose count is nearest the target (what the detector counted, if known, else the
 * flies visible on it). Now and then (DEFECT_SHARE) a damaged photo, when the pool has some.
 */
function pickPhoto(candidates, target, key) {
    if (!candidates.length) return null;
    const damaged = candidates.filter(p => p.defect);
    const clean = candidates.filter(p => !p.defect);
    const wantDefect = damaged.length && world.rand(`defect:${key}`) < DEFECT_SHARE;
    const from = wantDefect ? damaged : (clean.length ? clean : candidates);
    if (wantDefect) return from[Math.floor(world.rand(key) * from.length)];
    const value = (p) => (Number.isFinite(p.det) && p.trapKind === 'lure' ? p.det : (Number.isFinite(p.visible) ? p.visible : p.truth));
    const ranked = from.map(p => ({ p, d: Math.abs(value(p) - target) })).sort((a, b) => a.d - b.d);
    const best = ranked.filter(r => r.d <= ranked[0].d + 1).slice(0, 6);
    return best[Math.floor(world.rand(key) * best.length)].p;
}

// ---------- The world in the database ----------

async function systemUser({ dryRun }) {
    const existing = await User.findOne({ email: SYSTEM_EMAIL });
    if (existing || dryRun) return existing;
    return User.create({
        email: SYSTEM_EMAIL,
        // Nobody signs in to it: a random password nobody knows, an address that receives no mail
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        name: SYSTEM_NAME,
        role: 'user',
        emailVerified: false,
        language: 'vi',
        notificationPrefs: { email: false, telegram: false, weeklyReport: false, morningBrief: false, vietgapMonthly: false, orgDigest: false }
    });
}

async function findOrg() {
    return Organization.findOne({ simulated: true });
}

const farmDocName = (farm) => `${farm.name} (simulated)`;
const placeOf = (farm) => (farm.country && farm.country !== 'Vietnam' ? `${farm.province}, ${farm.country}` : farm.province);
const farmDescription = (farm) => `${farm.crop}, ${placeOf(farm)}. Main fruit fly: ${farm.pest || 'Bactrocera dorsalis'}. ${NOTE}.`;

/**
 * Create what is missing of the world (organization, farms, plots, cameras) and bring the names of
 * what exists up to date (English names, a farm's place and pest), by stable keys (Farm.simKey,
 * Plot.simKey, the camera serial); farms and plots of the first seed are found by their Vietnamese
 * names once. Returns the plan with what was created and renamed.
 */
async function ensureWorld({ dryRun = true } = {}) {
    const pool = await loadPool({ fresh: true });
    const farms = world.buildWorld(pool.traps || []);
    const traps = world.trapsOf(farms);
    const owner = await systemUser({ dryRun });
    let org = await findOrg();
    const plan = {
        farms: farms.length,
        plots: farms.reduce((n, f) => n + f.plots.length, 0),
        cameras: traps.length,
        created: { org: 0, farms: 0, plots: 0, cameras: 0 },
        renamed: { org: 0, farms: 0, plots: 0, cameras: 0 }
    };
    if (dryRun) {
        if (org) {
            const known = new Set((await Camera.find({ simulated: true }).select('deviceSerial').lean()).map(c => c.deviceSerial));
            plan.created.cameras = traps.filter(t => !known.has(t.serial)).length;
        }
        return { ...plan, farmsList: farms, traps };
    }
    if (!org) {
        org = await Organization.create({
            simulated: true,
            name: ORG_NAME,
            kind: 'organization',
            members: [{ userId: owner._id, email: SYSTEM_EMAIL, role: 'owner', addedBy: owner._id }],
            plan: { code: 'pro', note: 'Simulated demo farm (scripts/demo_sim.js)' }
        });
        plan.created.org = 1;
    } else if (org.name !== ORG_NAME) {
        await Organization.updateOne({ _id: org._id }, { $set: { name: ORG_NAME } });
        plan.renamed.org = 1;
    }
    if (owner.name !== SYSTEM_NAME) await User.updateOne({ _id: owner._id }, { $set: { name: SYSTEM_NAME } });
    const start = world.at(world.START_DAY, '06:00');
    for (const farm of farms) {
        const fields = { name: farmDocName(farm), description: farmDescription(farm), timezone: farm.tz || 'Asia/Ho_Chi_Minh', simKey: farm.key };
        let farmDoc = await Farm.findOne({ orgId: org._id, simulated: true, simKey: farm.key })
            || (farm.legacyName ? await Farm.findOne({ orgId: org._id, simulated: true, simKey: { $exists: false }, name: `${farm.legacyName} (mô phỏng)` }) : null);
        if (!farmDoc) {
            farmDoc = await Farm.create({ simulated: true, ownerId: owner._id, orgId: org._id, ...fields });
            plan.created.farms += 1;
        } else if (Object.entries(fields).some(([k, v]) => farmDoc[k] !== v)) {
            await Farm.updateOne({ _id: farmDoc._id }, { $set: fields });
            plan.renamed.farms += 1;
        }
        for (const plot of farm.plots) {
            const plotFields = { name: plot.name, crop: plot.crop, simKey: plot.key };
            let plotDoc = await Plot.findOne({ farmId: farmDoc._id, simKey: plot.key })
                || (plot.legacyName ? await Plot.findOne({ farmId: farmDoc._id, simKey: { $exists: false }, name: plot.legacyName }) : null);
            if (!plotDoc) {
                plotDoc = await Plot.create({ simulated: true, farmId: farmDoc._id, areaHa: 1, boundary: plot.boundary, ...plotFields });
                plan.created.plots += 1;
            } else if (Object.entries(plotFields).some(([k, v]) => plotDoc[k] !== v)) {
                await Plot.updateOne({ _id: plotDoc._id }, { $set: plotFields });
                plan.renamed.plots += 1;
            }
            for (const trap of plot.traps) {
                const cameraFields = { deviceName: trap.name, locationAddress: `${placeOf(farm)} (${NOTE.toLowerCase()})` };
                const existing = await Camera.findOne({ deviceSerial: trap.serial }).select('simulated deviceName locationAddress').lean();
                if (existing) {
                    if (existing.simulated && (existing.deviceName !== cameraFields.deviceName || existing.locationAddress !== cameraFields.locationAddress)) {
                        await Camera.updateOne({ deviceSerial: trap.serial, simulated: true }, { $set: cameraFields });
                        plan.renamed.cameras += 1;
                    }
                    continue;
                }
                await Camera.create({
                    simulated: true,
                    userId: owner._id,
                    orgId: org._id,
                    farmId: farmDoc._id,
                    plotId: plotDoc._id,
                    deviceSerial: trap.serial,
                    platform: 'simulated',
                    trapKind: trap.kind,
                    status: 1,
                    latitude: trap.lat,
                    longitude: trap.lng,
                    alertThreshold: trap.kind === 'sticky' ? 60 : 15,
                    captureIntervalMinutes: 120,
                    addedAt: start,
                    ...cameraFields
                });
                plan.created.cameras += 1;
            }
        }
    }
    require('./demoView').clearCache();
    return { ...plan, farmsList: farms, traps };
}

// ---------- Photos ----------

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * The photos due by `until` that are not stored yet: [{ trap, photoId, at, pool, truth }].
 * Showcase traps use their own set's photo of that day and slot while the set lasts.
 */
async function duePhotos({ traps, pool, until, from = world.START_DAY }) {
    const lure = pool.photos.filter(p => p.trapKind === 'lure');
    const sticky = pool.photos.filter(p => p.trapKind === 'sticky');
    const days = world.daysUntil(until).filter(d => d >= from);
    const logs = new Map();
    const due = [];
    for (const trap of traps) {
        const existing = new Set((await Snapshot.find({ deviceSerial: trap.serial, simulated: true }).select('simulation.photoId').lean()).map(s => s.simulation?.photoId));
        if (!logs.has(trap.farm.key)) logs.set(trap.farm.key, world.fieldLogOf(trap.farm, world.dayKeyOf(until)));
        const treatments = logs.get(trap.farm.key);
        const own = trap.setTrap ? pool.photos.filter(p => p.setTrap === trap.setTrap) : [];
        const slots = trap.farm.slots || world.NATIONAL_SLOTS;
        for (const day of days) {
            slots.forEach((hhmm, slot) => {
                const photoId = `sim:${trap.serial}:${day}:${slot}`;
                if (existing.has(photoId)) return;
                const exact = own.find(p => p.localDate === day && p.slot === slot);
                const when = exact?.capturedAt ? new Date(exact.capturedAt) : new Date(world.at(day, hhmm, trap.farm.offset).getTime() + Math.floor(world.rand(`jitter:${photoId}`) * 9) * 60000);
                if (when > until) return;
                let photo = exact;
                if (!photo) {
                    const target = trap.kind === 'sticky'
                        ? world.stickyTarget(trap, day, slot, treatments, slots.length)
                        : world.lureTarget(trap, day, slot, treatments);
                    photo = pickPhoto(trap.kind === 'sticky' ? sticky : lure, target, photoId);
                }
                if (photo) due.push({ trap, photoId, at: when, pool: photo, truth: photo.truth });
            });
        }
    }
    return due.sort((a, b) => a.at - b.at);
}

/** Store one photo (a copy of the pool picture under the camera's key) and analyze it. */
async function releasePhoto(item, { analyze = true } = {}) {
    const key = `snapshots/${item.trap.serial}/SYNTH_${item.trap.serial}_${stamp(item.at)}.jpg`;
    const buffer = await s3().readS3Buffer(item.pool.key);
    await s3().uploadSnapshot(key, buffer, 'image/jpeg');
    const snapshot = await Snapshot.create({
        simulated: true,
        simulation: {
            photoId: item.photoId,
            poolPhotoId: item.pool.id,
            truth: item.truth,
            ...(Number.isFinite(item.pool.visible) ? { visible: item.pool.visible } : {}),
            ...(item.pool.defect ? { defect: item.pool.defect } : {})
        },
        deviceSerial: item.trap.serial,
        imageUrl: `${env.S3_PUBLIC_URL || ''}/${key}`,
        s3Key: key,
        createdAt: item.at,
        trigger: 'schedule',
        aiProvider: 'opencv-lambda'
    });
    await Camera.updateOne({ deviceSerial: item.trap.serial }, { $set: { thumbnailUrl: snapshot.imageUrl, lastSync: item.at, lastCaptureAt: item.at } });
    if (!analyze) return { snapshot, ok: null };
    const result = await require('./visionLambda').analyzeSnapshot(snapshot._id, { buffer });
    return { snapshot, ok: result.ok, error: result.error?.message };
}

// ---------- Field log ----------

async function ensureFieldLog({ farms, owner, until, dryRun }) {
    const lastDay = world.dayKeyOf(until);
    let treatments = 0;
    let events = 0;
    let renamed = 0;
    for (const farm of farms) {
        const serials = farm.plots.flatMap(p => p.traps.map(t => t.serial));
        // Entries of the first seed: the same entries in English (by their client ids)
        if (!dryRun && owner) {
            for (const type of Object.keys(world.PRODUCTS)) {
                const res = await Treatment.updateMany(
                    { createdBy: owner._id, simulated: true, type, clientId: { $regex: `^sim:${farm.key}:` }, $or: [{ note: { $ne: NOTE } }, { product: { $ne: world.PRODUCTS[type].product } }] },
                    { $set: { ...world.PRODUCTS[type], area: farm.plots.map(p => p.name).join(', '), operator: 'Simulation', note: NOTE } }
                );
                renamed += res.modifiedCount || 0;
            }
        }
        for (const t of world.fieldLogOf(farm, lastDay)) {
            const at = world.at(t.day, t.hhmm, farm.offset);
            if (at > until) continue;
            const clientId = `sim:${farm.key}:${t.day}:${t.type}`;
            if (dryRun) { treatments += 1; continue; }
            if (await Treatment.exists({ createdBy: owner._id, clientId })) continue;
            await Treatment.create({
                simulated: true,
                cameraSerials: serials,
                type: t.type,
                at,
                ...world.PRODUCTS[t.type],
                area: farm.plots.map(p => p.name).join(', '),
                operator: 'Simulation',
                note: NOTE,
                clientId,
                createdBy: owner._id,
                createdByEmail: SYSTEM_EMAIL,
                createdAt: at,
                updatedAt: at
            });
            treatments += 1;
        }
        for (const plot of farm.plots) {
            for (const trap of plot.traps) {
                const dates = [];
                for (const day of world.daysUntil(until)) {
                    const index = world.dayIndex(day);
                    if (trap.kind === 'sticky' && index % world.CARD_DAYS === 0) dates.push([day, 'card_replaced', '06:15']);
                    if (trap.kind === 'lure' && index % LURE_REFILL_DAYS === 0) dates.push([day, 'lure_replaced', '06:20']);
                }
                for (const [day, type, hhmm] of dates) {
                    const at = world.at(day, hhmm, farm.offset);
                    if (at > until) continue;
                    const clientId = `sim:${trap.serial}:${day}:${type}`;
                    if (dryRun) { events += 1; continue; }
                    if (await MaintenanceEvent.exists({ userId: owner._id, clientId })) continue;
                    await MaintenanceEvent.create({ simulated: true, deviceSerial: trap.serial, type, at, note: NOTE, userId: owner._id, userEmail: SYSTEM_EMAIL, clientId, createdAt: at });
                    events += 1;
                    if (type === 'card_replaced') await Camera.updateOne({ deviceSerial: trap.serial, $or: [{ cardReplacedAt: null }, { cardReplacedAt: { $lt: at } }] }, { $set: { cardReplacedAt: at } });
                }
            }
        }
    }
    if (!dryRun && owner) {
        const res = await MaintenanceEvent.updateMany({ userId: owner._id, simulated: true, note: { $ne: NOTE } }, { $set: { note: NOTE } });
        renamed += res.modifiedCount || 0;
    }
    return { treatments, events, renamed };
}

/**
 * Decide the simulated proposals older than a day as a grower would have (about two in three
 * approved, one in five rejected, the rest left to expire), so the history has decisions. Nothing
 * runs on a camera: the simulated cameras have no device.
 */
async function decideOldProposals(now = new Date()) {
    const old = await SentinelProposal.find({ simulated: true, state: 'pending', createdAt: { $lt: new Date(now.getTime() - 24 * 3600 * 1000) } }).select('_id createdAt').lean();
    let decided = 0;
    for (const p of old) {
        const r = world.rand(`decide:${p._id}`);
        if (r >= 0.85) continue;
        const state = r < 0.65 ? 'confirmed' : 'rejected';
        await SentinelProposal.updateOne({ _id: p._id, state: 'pending' }, {
            $set: { state, decidedAt: new Date(new Date(p.createdAt).getTime() + (1 + Math.floor(r * 6)) * 3600 * 1000), decidedVia: 'simulation', result: state === 'confirmed' ? NOTE : '' }
        });
        decided += 1;
    }
    return decided;
}

// ---------- Runs ----------

async function inBatches(items, size, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += size) results.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    return results;
}

/**
 * Bring the simulated farm up to `until`: the world, the field log, every photo due (analyzed by the
 * vision pipeline, one camera at a time in time order, `concurrency` cameras in parallel), the
 * decisions on old proposals and the rollups' labels. Idempotent. dryRun only counts.
 */
async function simulate({ until = new Date(), from = world.START_DAY, dryRun = true, analyze = true, concurrency = 4 } = {}) {
    const ensured = await ensureWorld({ dryRun });
    const owner = await User.findOne({ email: SYSTEM_EMAIL });
    const pool = await loadPool();
    const due = await duePhotos({ traps: ensured.traps, pool, until, from });
    const fieldLog = await ensureFieldLog({ farms: ensured.farmsList, owner, until, dryRun: dryRun || !owner });
    const summary = {
        until: until.toISOString(),
        farms: ensured.farms,
        cameras: ensured.cameras,
        created: ensured.created,
        renamed: ensured.renamed,
        photosDue: due.length,
        byKind: { lure: due.filter(d => d.trap.kind === 'lure').length, sticky: due.filter(d => d.trap.kind === 'sticky').length },
        lambdaCalls: analyze ? due.length : 0,
        fieldLog
    };
    if (dryRun) return summary;
    const byCamera = new Map();
    for (const item of due) {
        if (!byCamera.has(item.trap.serial)) byCamera.set(item.trap.serial, []);
        byCamera.get(item.trap.serial).push(item);
    }
    let done = 0;
    let failed = 0;
    await inBatches([...byCamera.values()], concurrency, async (items) => {
        for (const item of items) {
            try {
                const r = await releasePhoto(item, { analyze });
                if (r.ok === false) failed += 1;
            } catch (err) {
                failed += 1;
                console.error(`⚠️ Simulated photo ${item.photoId} failed:`, err.message);
            }
            done += 1;
            if (done % 50 === 0) log(`photos: ${done}/${due.length}${failed ? ` (${failed} failed)` : ''}`);
        }
    });
    const serials = ensured.traps.map(t => t.serial);
    await DailyStat.updateMany({ deviceSerial: { $in: serials } }, { $set: { simulated: true } });
    const decided = await decideOldProposals(until);
    return { ...summary, released: done, failed, decided };
}

/** Delete every simulated document and photo (and only those). dryRun only counts. */
async function remove({ dryRun = true } = {}) {
    const org = await findOrg();
    const owner = await User.findOne({ email: SYSTEM_EMAIL });
    const cameras = await Camera.find({ simulated: true }).select('deviceSerial').lean();
    const serials = cameras.map(c => c.deviceSerial);
    const counts = {
        organization: org ? 1 : 0,
        farms: await Farm.countDocuments({ simulated: true }),
        plots: await Plot.countDocuments({ simulated: true }),
        cameras: serials.length,
        photos: await Snapshot.countDocuments({ simulated: true }),
        treatments: await Treatment.countDocuments({ simulated: true }),
        maintenance: await MaintenanceEvent.countDocuments({ simulated: true }),
        proposals: await SentinelProposal.countDocuments({ simulated: true }),
        dailyStats: serials.length ? await DailyStat.countDocuments({ deviceSerial: { $in: serials } }) : 0
    };
    if (dryRun) return counts;
    const keys = (await Snapshot.find({ simulated: true }).select('s3Key').lean()).map(s => s.s3Key).filter(k => /^snapshots\/SIM-/.test(k));
    for (let i = 0; i < keys.length; i += 500) await Promise.all(keys.slice(i, i + 500).map(k => s3().deleteS3Object(k).catch(() => {})));
    await Snapshot.deleteMany({ simulated: true });
    if (serials.length) await DailyStat.deleteMany({ deviceSerial: { $in: serials } });
    await Treatment.deleteMany({ simulated: true });
    await MaintenanceEvent.deleteMany({ simulated: true });
    await SentinelProposal.deleteMany({ simulated: true });
    await Camera.deleteMany({ simulated: true });
    await Plot.deleteMany({ simulated: true });
    await Farm.deleteMany({ simulated: true });
    if (org) await Organization.deleteOne({ _id: org._id, simulated: true });
    if (owner) {
        await ChatSession.deleteMany({ userId: owner._id });
        await Notification.deleteMany({ userId: owner._id });
        await User.deleteOne({ _id: owner._id, email: SYSTEM_EMAIL });
    }
    require('./demoView').clearCache();
    return { ...counts, photoFiles: keys.length };
}

/**
 * The daily simulation (cron, every 30 minutes): while Admin > System turns it on and until its end
 * date, release the photos and field-log entries due since the last run. Does nothing when the
 * simulated farm does not exist. Returns the summary or null.
 */
async function runDaily(now = new Date()) {
    const settings = await require('./settingsService').getSettings();
    if (!settings.demoSimEnabled) return null;
    const until = settings.demoSimUntil && new Date(settings.demoSimUntil) < now ? new Date(settings.demoSimUntil) : now;
    if (!(await findOrg())) return null;
    // Only the last two days: earlier ones were filled by the seed or earlier runs
    const from = world.addDays(world.dayKeyOf(until), -1);
    return simulate({ until, from, dryRun: false });
}

module.exports = {
    SYSTEM_EMAIL,
    ORG_NAME,
    POOL_INDEX,
    POOL_PREFIX,
    buildPoolIndex,
    uploadPool,
    loadPool,
    pickPhoto,
    ensureWorld,
    duePhotos,
    simulate,
    decideOldProposals,
    remove,
    runDaily
};
