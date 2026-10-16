/**
 * Read-only export of FlyBot trap photos and their records for FlyBot Sentinel
 * (OpenCV AI Competition 2026: evaluation and replay).
 *
 *   node scripts/export_sentinel_dataset.js [--days 90] [--limit 3000] [--out <dir>] [--dry-run] [--no-images]
 *       [--exclude-camera <serial>[,<serial>...]]   (repeatable; default AC6527557; "none" keeps every camera)
 *
 * Writes, under --out (default ../flybot-sentinel/data/export):
 *   images/<deviceSerial>/<snapshotId>.jpg   the photos, read from S3 (--no-images: only the ones already on disk are used)
 *   boxes/<snapshotId>.json                  the production detection boxes of each exported photo
 *   cameras.json, daily_stats.json, maintenance_events.json, treatments.json, farms_plots.json, summary.json
 * and <out>/../manifest.csv (columns in flybot-sentinel/data/README.md, unchanged).
 *
 * Boxes: Snapshot.aiResults.insects[].bbox as production stores it, [xmin, ymin, xmax, ymax] in
 * pixels of the photo ("xyxy_pixels"): Roboflow returns pixels, and Vertex's 0-1000 boxes are
 * converted to pixels with the image size before they are saved (services/aiService.js). They are
 * not 0-10000. summary.json "boxes" counts boxes that reach outside their photo, as a check.
 *
 * Left out, and only counted in summary.json: photos of excluded cameras (--exclude-camera,
 * flybot-sentinel/data/excluded_cameras.csv), and the repeated "fly-disc" test pictures uploaded
 * through FlyBot: an image of exactly 640x640 pixels whose content hash occurs more than once.
 * Test pictures are found from the image files, after --limit is applied.
 *
 * Nothing is written to MongoDB or S3: the script only reads, and refuses any write command
 * (see guardReadOnly). Photos where the model found a person or another non-pest label
 * (constants/species.js NON_PEST_LABELS) are left out for privacy and only counted.
 * People's emails, names and account ids are not exported.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { NON_PEST_LABELS } = require('../src/constants/species');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OUT = path.resolve(__dirname, '../../../flybot-sentinel/data/export');
// Treatments counted as "in effect" for a photo: logged on its camera in the days before it
// (same window as services/treatmentService.js DEFAULT_WINDOW_DAYS)
const TREATMENT_WINDOW_DAYS = 7;
const DOWNLOAD_CONCURRENCY = 6;
const DOWNLOAD_ATTEMPTS = 3;
// AC6527557 "Gravity01" films a building, not a trap (flybot-sentinel/data/excluded_cameras.csv)
const DEFAULT_EXCLUDED_CAMERAS = ['AC6527557'];
// The repeated test pictures uploaded through FlyBot until 2026-10-06 are all 640x640
const TEST_PICTURE_SIZE = { width: 640, height: 640 };
const BOX_FORMAT = 'xyxy_pixels';

const MANIFEST_COLUMNS = [
    'snapshot_id', 'device_serial', 'provider', 'captured_at', 'image_path', 's3_key', 'farm_id', 'plot_id',
    'lat', 'lon', 'trap_kind', 'ai_count', 'ai_counts_json', 'review_status', 'human_count', 'quality_issues',
    'previous_snapshot_id', 'card_replaced_at', 'treatment_ids'
];

function parseArgs(argv) {
    const opts = { days: 90, limit: 3000, out: DEFAULT_OUT, dryRun: false, images: true, excludeCameras: [...DEFAULT_EXCLUDED_CAMERAS] };
    let excludeGiven = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${arg} needs a value`);
            return v;
        };
        if (arg === '--days') opts.days = Number(value());
        else if (arg === '--limit') opts.limit = Number(value());
        else if (arg === '--out') opts.out = path.resolve(value());
        else if (arg === '--dry-run') opts.dryRun = true;
        else if (arg === '--no-images') opts.images = false;
        else if (arg === '--exclude-camera') {
            // The first one replaces the default list; "none" keeps every camera
            if (!excludeGiven) opts.excludeCameras = [];
            excludeGiven = true;
            const list = value().split(',').map(v => v.trim()).filter(Boolean);
            if (!(list.length === 1 && list[0].toLowerCase() === 'none')) opts.excludeCameras.push(...list);
        }
        else throw new Error(`Unknown option ${arg}`);
    }
    if (!Number.isInteger(opts.days) || opts.days < 1) throw new Error('--days must be a positive integer');
    if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error('--limit must be a positive integer');
    if (opts.excludeCameras.some(s => !/^[A-Za-z0-9_-]{1,64}$/.test(s))) throw new Error('--exclude-camera takes camera serial numbers');
    opts.excludeCameras = [...new Set(opts.excludeCameras)];
    return opts;
}

const plain = (m) => (m instanceof Map ? Object.fromEntries(m) : (m || {}));
const idOf = (v) => (v ? String(v) : '');
const iso = (d) => (d ? new Date(d).toISOString() : '');
const isNonPest = (label) => NON_PEST_LABELS.includes(String(label).toLowerCase());

// Same rule as Snapshot.pestCountOf / notificationService.countPests
function pestCount(summary) {
    return Object.entries(plain(summary))
        .filter(([label]) => !isNonPest(label))
        .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
}

/** Non-pest labels (person, vehicle, animal) anywhere in a snapshot's detections or counts. */
function privacyLabels(snap) {
    const labels = new Set();
    for (const insect of snap.aiResults?.insects || []) {
        if (insect?.name && isNonPest(insect.name)) labels.add(String(insect.name).toLowerCase());
    }
    for (const summary of [snap.aiResults?.summary, snap.review?.originalSummary]) {
        for (const [label, value] of Object.entries(plain(summary))) {
            if (isNonPest(label) && Number(value) > 0) labels.add(String(label).toLowerCase());
        }
    }
    return [...labels];
}

/** Model output of a snapshot: the counts before a correction, else the current counts. */
function aiSummaryOf(snap) {
    if (snap.review?.status === 'corrected' && snap.review.originalSummary) return plain(snap.review.originalSummary);
    return plain(snap.aiResults?.summary);
}

const reviewed = (snap) => snap.review?.status === 'confirmed' || snap.review?.status === 'corrected';
const imageRelPath = (serial, id) => path.posix.join('images', serial, `${id}.jpg`);
const boxesRelPath = (id) => path.posix.join('boxes', `${id}.json`);

/** Production boxes of a snapshot as stored (pixels), highest confidence first. */
function boxesOf(snap) {
    return (snap?.aiResults?.insects || [])
        .filter(i => Array.isArray(i?.bbox) && i.bbox.length === 4 && i.bbox.every(v => Number.isFinite(Number(v))))
        .map(i => ({ label: i.name || null, confidence: Number.isFinite(i.confidence) ? i.confidence : null, bbox: i.bbox.map(Number) }))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

/** Boxes reaching past the photo's edges (2 px tolerance for rounding); null when its size is unknown. */
function outOfBounds(boxes, width, height) {
    if (!width || !height) return null;
    return boxes.filter(b => b.bbox[0] < -2 || b.bbox[1] < -2 || b.bbox[2] > width + 2 || b.bbox[3] > height + 2).length;
}

/**
 * The repeated test pictures among the rows: exactly 640x640 and the same content (sha256) as
 * another 640x640 picture. `images` maps snapshot_id -> { width, height, sha256 } for the rows
 * whose image could be read. Returns { ids: Set, report }.
 */
function findTestPictures(rows, images) {
    const byHash = new Map();
    for (const row of rows) {
        const img = images.get(row.snapshot_id);
        if (!img || img.width !== TEST_PICTURE_SIZE.width || img.height !== TEST_PICTURE_SIZE.height) continue;
        if (!byHash.has(img.sha256)) byHash.set(img.sha256, []);
        byHash.get(img.sha256).push(row);
    }
    const ids = new Set();
    const byCamera = {};
    const hashes = [];
    for (const [sha256, list] of byHash) {
        if (list.length < 2) continue;
        hashes.push({ sha256, count: list.length });
        for (const row of list) {
            ids.add(row.snapshot_id);
            byCamera[row.device_serial] = (byCamera[row.device_serial] || 0) + 1;
        }
    }
    hashes.sort((a, b) => b.count - a.count);
    return {
        ids,
        report: {
            rule: `exactly ${TEST_PICTURE_SIZE.width}x${TEST_PICTURE_SIZE.height} px and a content sha256 seen more than once`,
            dropped: ids.size,
            byCamera,
            distinctPictures: hashes.length,
            hashes,
            imagesChecked: rows.filter(r => images.has(r.snapshot_id)).length,
            imagesNotAvailable: rows.filter(r => !images.has(r.snapshot_id)).length
        }
    };
}

// Columns where a spreadsheet would run the text as a formula, or that need quoting
function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (/^[=+@\t\r]/.test(text) || /^-[^0-9]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const toCsv = (rows) => [MANIFEST_COLUMNS.join(','), ...rows.map(r => MANIFEST_COLUMNS.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';

/**
 * Read everything the export needs and build the manifest rows and sidecars (no file I/O).
 * `rows[i].image_path` is filled in later, once the photo is on disk.
 */
async function buildDataset({ days = 90, limit = 3000, now = new Date(), excludeCameras = DEFAULT_EXCLUDED_CAMERAS, readImages = null } = {}) {
    const excluded = new Set(excludeCameras);
    const { Snapshot, Camera, DailyStat, MaintenanceEvent, Treatment, Farm, Plot } = require('../src/models');
    const { dayKeyOf } = require('../src/services/dailyStats');
    const since = new Date(now.getTime() - days * DAY_MS);

    const counts = {
        snapshotsInWindow: 0, unprocessed: 0, processed: 0, excludedPrivacy: 0, excludedByLabel: {},
        eligible: 0, eligibleConfirmed: 0, eligibleCorrected: 0,
        excludedCameraSnapshots: 0, excludedTestPictures: 0
    };
    const excludedPerCamera = {};
    const perCameraAll = new Map();
    const byCamera = new Map(); // serial -> eligible processed snapshots, oldest first
    const cursor = Snapshot.find({ createdAt: { $gte: since, $lte: now } })
        .select('_id deviceSerial createdAt aiProcessed aiProvider s3Key aiResults.insects aiResults.summary review.status review.originalSummary quality.issues quality.checkedAt')
        .lean().cursor({ batchSize: 1000 });
    for await (const snap of cursor) {
        counts.snapshotsInWindow++;
        // Excluded cameras: counted, nothing else (not in cameras.json or any sidecar)
        if (excluded.has(snap.deviceSerial)) {
            counts.excludedCameraSnapshots++;
            excludedPerCamera[snap.deviceSerial] = (excludedPerCamera[snap.deviceSerial] || 0) + 1;
            continue;
        }
        const cam = perCameraAll.get(snap.deviceSerial) || { snapshots: 0, processed: 0, excludedPrivacy: 0 };
        perCameraAll.set(snap.deviceSerial, cam);
        cam.snapshots++;
        if (!snap.aiProcessed) { counts.unprocessed++; continue; }
        counts.processed++;
        cam.processed++;
        const labels = privacyLabels(snap);
        if (labels.length) {
            counts.excludedPrivacy++;
            cam.excludedPrivacy++;
            for (const l of labels) counts.excludedByLabel[l] = (counts.excludedByLabel[l] || 0) + 1;
            continue;
        }
        counts.eligible++;
        if (snap.review?.status === 'confirmed') counts.eligibleConfirmed++;
        if (snap.review?.status === 'corrected') counts.eligibleCorrected++;
        if (!byCamera.has(snap.deviceSerial)) byCamera.set(snap.deviceSerial, []);
        byCamera.get(snap.deviceSerial).push(snap);
    }
    for (const list of byCamera.values()) list.sort((a, b) => a.createdAt - b.createdAt || String(a._id).localeCompare(String(b._id)));

    // Previous processed (and shareable) photo of the same camera, also across the window start
    const previous = new Map();
    for (const [serial, list] of byCamera) {
        const before = await Snapshot.find({ deviceSerial: serial, aiProcessed: true, createdAt: { $lt: since } })
            .sort({ createdAt: -1 }).limit(20)
            .select('_id aiResults.insects.name aiResults.summary review.originalSummary').lean();
        let prev = before.find(s => privacyLabels(s).length === 0)?._id || null;
        for (const snap of list) {
            previous.set(String(snap._id), prev ? String(prev) : '');
            prev = snap._id;
        }
    }

    // Reviewed photos first, then the most recent
    const eligible = [...byCamera.values()].flat();
    eligible.sort((a, b) => (reviewed(b) - reviewed(a)) || (b.createdAt - a.createdAt));
    const selected = eligible.slice(0, limit);
    selected.sort((a, b) => a.deviceSerial.localeCompare(b.deviceSerial) || (a.createdAt - b.createdAt));

    const serials = [...perCameraAll.keys()].sort();
    const cameraDocs = await Camera.find({ deviceSerial: { $in: serials } }).lean();
    const cameraBySerial = new Map(cameraDocs.map(c => [c.deviceSerial, c]));
    const cameras = serials.map(serial => {
        const c = cameraBySerial.get(serial);
        if (!c) return { serial, name: null, provider: null, trapKind: null, lat: null, lon: null, farmId: null, plotId: null, alertThreshold: null, registered: false };
        return {
            serial,
            name: c.deviceName,
            provider: c.provider || 'ezviz',
            trapKind: c.trapKind || 'sticky',
            lat: c.latitude ?? null,
            lon: c.longitude ?? null,
            farmId: c.farmId ? String(c.farmId) : null,
            plotId: c.plotId ? String(c.plotId) : null,
            alertThreshold: c.alertThreshold ?? null,
            trapType: c.trapType || null,
            cropType: c.cropType || null,
            captureIntervalMinutes: c.captureIntervalMinutes ?? null,
            captureDaytimeOnly: !!c.captureDaytimeOnly,
            cardReplacedAt: c.cardReplacedAt ? iso(c.cardReplacedAt) : null,
            registered: true
        };
    });
    const camera = new Map(cameras.map(c => [c.serial, c]));

    // Card changes: every one on these cameras, so photos early in the window find theirs
    const cardEvents = await MaintenanceEvent.find({ deviceSerial: { $in: serials }, type: 'card_replaced', at: { $lte: now } })
        .sort({ at: 1 }).select('deviceSerial at').lean();
    const cardsBySerial = new Map();
    for (const e of cardEvents) {
        if (!cardsBySerial.has(e.deviceSerial)) cardsBySerial.set(e.deviceSerial, []);
        cardsBySerial.get(e.deviceSerial).push(e.at);
    }
    const lastCardBefore = (serial, at) => {
        const list = cardsBySerial.get(serial) || [];
        let found = null;
        for (const t of list) { if (t <= at) found = t; else break; }
        return found;
    };

    const treatmentSince = new Date(since.getTime() - TREATMENT_WINDOW_DAYS * DAY_MS);
    const treatmentDocs = await Treatment.find({ cameraSerials: { $in: serials }, at: { $gte: treatmentSince, $lte: now } }).sort({ at: 1 }).lean();

    const rows = selected.map(snap => {
        const cam = camera.get(snap.deviceSerial) || {};
        const ai = aiSummaryOf(snap);
        const at = new Date(snap.createdAt);
        const card = lastCardBefore(snap.deviceSerial, at);
        const treatments = treatmentDocs.filter(t => t.cameraSerials.includes(snap.deviceSerial)
            && t.at <= at && t.at >= new Date(at.getTime() - TREATMENT_WINDOW_DAYS * DAY_MS));
        return {
            snapshot_id: String(snap._id),
            device_serial: snap.deviceSerial,
            provider: cam.provider || '',
            captured_at: iso(at),
            image_path: '',
            s3_key: snap.s3Key || '',
            farm_id: cam.farmId || '',
            plot_id: cam.plotId || '',
            lat: cam.lat ?? '',
            lon: cam.lon ?? '',
            trap_kind: cam.trapKind || '',
            ai_count: pestCount(ai),
            ai_counts_json: JSON.stringify(ai),
            review_status: snap.review?.status || '',
            human_count: reviewed(snap) ? pestCount(snap.aiResults?.summary) : '',
            quality_issues: snap.quality?.checkedAt || snap.quality?.issues ? (snap.quality.issues || []).join(';') : '',
            previous_snapshot_id: previous.get(String(snap._id)) || '',
            card_replaced_at: card ? iso(card) : '',
            treatment_ids: treatments.map(t => String(t._id)).join(';')
        };
    });

    // The photos, read by the caller (disk or S3): their size and hash, to drop the test pictures
    const images = readImages ? await readImages(rows) : new Map();
    const testPictures = findTestPictures(rows, images);
    counts.excludedTestPictures = testPictures.ids.size;
    if (testPictures.ids.size) {
        const kept = rows.filter(r => !testPictures.ids.has(r.snapshot_id));
        // A previous photo that was a test picture: the camera's nearest earlier kept photo instead
        // (rows are in camera, then time order)
        const lastKept = new Map();
        for (const row of kept) {
            if (testPictures.ids.has(row.previous_snapshot_id)) row.previous_snapshot_id = lastKept.get(row.device_serial) || '';
            lastKept.set(row.device_serial, row.snapshot_id);
        }
        rows.splice(0, rows.length, ...kept);
    }

    const snapById = new Map(selected.map(s => [String(s._id), s]));
    const boxes = new Map();
    const boxStats = { format: BOX_FORMAT, rows: rows.length, rowsWithBoxes: 0, boxes: 0, rowsWithImageSize: 0, boxesOutOfBounds: 0, rowsWithBoxesOutOfBounds: 0, boxesByProvider: {} };
    for (const row of rows) {
        const snap = snapById.get(row.snapshot_id);
        const list = boxesOf(snap);
        const img = images.get(row.snapshot_id);
        const outside = outOfBounds(list, img?.width, img?.height);
        boxes.set(row.snapshot_id, {
            snapshotId: row.snapshot_id,
            deviceSerial: row.device_serial,
            capturedAt: row.captured_at,
            aiProvider: snap?.aiProvider || null,
            boxFormat: BOX_FORMAT,
            imageWidth: img?.width ?? null,
            imageHeight: img?.height ?? null,
            // Model output: a human correction changes the counts, not the boxes
            reviewStatus: row.review_status || null,
            boxesOutOfBounds: outside,
            boxes: list
        });
        if (list.length) boxStats.rowsWithBoxes++;
        boxStats.boxes += list.length;
        if (img) boxStats.rowsWithImageSize++;
        if (outside) {
            boxStats.boxesOutOfBounds += outside;
            boxStats.rowsWithBoxesOutOfBounds++;
        }
        const provider = snap?.aiProvider || 'unknown';
        boxStats.boxesByProvider[provider] = (boxStats.boxesByProvider[provider] || 0) + list.length;
    }

    const dailyStats = (await DailyStat.find({ deviceSerial: { $in: serials }, day: { $gte: dayKeyOf(since), $lte: dayKeyOf(now) } })
        .sort({ deviceSerial: 1, day: 1 }).lean())
        .map(d => ({ deviceSerial: d.deviceSerial, day: d.day, scans: d.scans, total: d.total, peak: d.peak, min: d.min, species: d.species || [] }));
    const maintenanceEvents = (await MaintenanceEvent.find({ deviceSerial: { $in: serials }, at: { $gte: since, $lte: now } }).sort({ at: 1 }).lean())
        .map(e => ({ id: String(e._id), deviceSerial: e.deviceSerial, type: e.type, at: iso(e.at), source: e.source || 'manual', note: e.note || '', createdAt: iso(e.createdAt) }));
    const treatments = treatmentDocs.map(t => ({
        id: String(t._id), cameraSerials: t.cameraSerials, type: t.type, at: iso(t.at), product: t.product || '',
        activeIngredient: t.activeIngredient || '', dose: t.dose || '', area: t.area || '',
        preHarvestDays: t.preHarvestDays ?? null, note: t.note || ''
    }));

    const farmIds = [...new Set(cameras.map(c => c.farmId).filter(Boolean))];
    const plotIds = [...new Set(cameras.map(c => c.plotId).filter(Boolean))];
    const farmDocs = await Farm.find({ _id: { $in: farmIds } }).select('name description orgId createdAt').lean();
    const plotDocs = await Plot.find({ $or: [{ farmId: { $in: farmIds } }, { _id: { $in: plotIds } }] }).lean();
    const farmsPlots = {
        farms: farmDocs.map(f => ({ id: String(f._id), name: f.name, description: f.description || '', orgId: idOf(f.orgId) || null })),
        plots: plotDocs.map(p => ({
            id: String(p._id), farmId: String(p.farmId), name: p.name, crop: p.crop || '', areaHa: p.areaHa ?? null,
            alertThreshold: p.alertThreshold ?? null,
            // [lat, lng] pairs as stored (empty when no boundary was drawn)
            boundary: p.boundary || []
        }))
    };

    const perCamera = {};
    for (const serial of serials) {
        const all = perCameraAll.get(serial);
        const mine = rows.filter(r => r.device_serial === serial);
        perCamera[serial] = {
            snapshotsInWindow: all.snapshots,
            processed: all.processed,
            excludedPrivacy: all.excludedPrivacy,
            exported: mine.length,
            reviewedConfirmed: mine.filter(r => r.review_status === 'confirmed').length,
            reviewedCorrected: mine.filter(r => r.review_status === 'corrected').length,
            firstCapturedAt: mine[0]?.captured_at || null,
            lastCapturedAt: mine[mine.length - 1]?.captured_at || null
        };
    }
    const exportedIds = new Set(rows.map(r => r.snapshot_id));
    const maintenanceByType = {};
    for (const e of maintenanceEvents) maintenanceByType[e.type] = (maintenanceByType[e.type] || 0) + 1;
    const capturedTimes = rows.map(r => r.captured_at).sort();

    const summary = {
        generatedAt: iso(now),
        window: { days, since: iso(since), until: iso(now) },
        limit,
        counts: {
            ...counts,
            snapshotsTotal: rows.length,
            reviewedConfirmed: rows.filter(r => r.review_status === 'confirmed').length,
            reviewedCorrected: rows.filter(r => r.review_status === 'corrected').length,
            withPreviousSnapshot: rows.filter(r => r.previous_snapshot_id).length,
            previousSnapshotAlsoExported: rows.filter(r => exportedIds.has(r.previous_snapshot_id)).length,
            withCardReplacedAt: rows.filter(r => r.card_replaced_at).length,
            withTreatment: rows.filter(r => r.treatment_ids).length,
            withQualityIssues: rows.filter(r => r.quality_issues).length,
            camerasSeen: serials.length,
            camerasRegistered: cameraDocs.length,
            dailyStatRows: dailyStats.length,
            maintenanceEvents: maintenanceEvents.length,
            maintenanceByType,
            cardReplacedEventsAllTime: cardEvents.length,
            treatments: treatments.length,
            farms: farmsPlots.farms.length,
            plots: farmsPlots.plots.length,
            plotsWithBoundary: farmsPlots.plots.filter(p => p.boundary.length >= 3).length
        },
        photosPerDay: {
            // All photos taken in the window (processed or not, people included), per day of the window
            allCameras: Math.round((counts.snapshotsInWindow / days) * 10) / 10,
            perCamera: Object.fromEntries(serials.map(s => [s, Math.round((perCameraAll.get(s).snapshots / days) * 10) / 10]))
        },
        dateRange: { first: capturedTimes[0] || null, last: capturedTimes[capturedTimes.length - 1] || null },
        perCamera,
        excludedCameras: { list: [...excluded].sort(), snapshotsInWindow: excludedPerCamera },
        testPictures: testPictures.report,
        boxes: boxStats,
        definitions: {
            ai_count: 'pest count (non-pest labels excluded) of the model output: review.originalSummary when corrected, else aiResults.summary',
            human_count: 'pest count of aiResults.summary after a human review (confirmed or corrected); empty when not reviewed',
            previous_snapshot_id: 'previous AI-processed, non-excluded photo of the same camera (may lie outside this export)',
            card_replaced_at: 'latest card_replaced maintenance event of the camera at or before captured_at',
            treatment_ids: `treatments logged on the camera in the ${TREATMENT_WINDOW_DAYS} days up to captured_at`,
            quality_issues: 'Snapshot.quality.issues joined by ";" (empty when none or not checked)',
            excludedPrivacy: `processed photos whose detections or counts contain a non-pest label (${NON_PEST_LABELS.join(', ')}); not exported`,
            excludedCameraSnapshots: 'photos in the window from the excluded cameras (--exclude-camera); not exported',
            excludedTestPictures: `repeated test pictures among the selected photos (${testPictures.report.rule}); not exported`,
            boxes: `boxes/<snapshot_id>.json: aiResults.insects as stored, bbox [xmin, ymin, xmax, ymax] in pixels of the photo (${BOX_FORMAT}); imageWidth/imageHeight read from the image file when it was available`
        }
    };

    return {
        rows,
        selected,
        boxes,
        sidecars: { cameras, dailyStats, maintenanceEvents, treatments, farmsPlots },
        summary
    };
}

/** Refuse every write to MongoDB and S3 for the rest of the process. */
function guardReadOnly() {
    const mongodb = require(require.resolve('mongodb', { paths: [path.dirname(require.resolve('mongoose'))] }));
    const refuse = (name) => function readOnlyGuard() { throw new Error(`Read-only export: ${name} is not allowed`); };
    for (const name of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
        'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite', 'createIndex', 'createIndexes',
        'dropIndex', 'dropIndexes', 'drop', 'rename']) {
        mongodb.Collection.prototype[name] = refuse(`collection.${name}`);
    }
    for (const name of ['createCollection', 'dropCollection', 'dropDatabase', 'renameCollection']) {
        mongodb.Db.prototype[name] = refuse(`db.${name}`);
    }
    const { s3Client } = require('../src/config/s3');
    const send = s3Client.send.bind(s3Client);
    s3Client.send = (command, ...rest) => {
        const name = command?.constructor?.name;
        if (name !== 'GetObjectCommand' && name !== 'HeadObjectCommand') return Promise.reject(new Error(`Read-only export: ${name} is not allowed`));
        return send(command, ...rest);
    };
}

async function downloadImages(rows, outDir, log = console.log) {
    const { readS3Buffer } = require('../src/services/s3Service');
    const stats = { downloaded: 0, alreadyPresent: 0, failed: 0, notJpeg: 0, bytes: 0, failures: [] };
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < rows.length) {
            const row = rows[next++];
            const rel = imageRelPath(row.device_serial, row.snapshot_id);
            const file = path.join(outDir, rel);
            try {
                const existing = fs.existsSync(file) ? fs.statSync(file).size : 0;
                if (existing > 0) {
                    stats.alreadyPresent++;
                    stats.bytes += existing;
                } else {
                    let buffer;
                    for (let attempt = 1; ; attempt++) {
                        try {
                            buffer = await readS3Buffer(row.s3_key);
                            break;
                        } catch (err) {
                            if (attempt >= DOWNLOAD_ATTEMPTS || err.name === 'NoSuchKey') throw err;
                            await new Promise(r => setTimeout(r, 1000 * attempt));
                        }
                    }
                    if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) stats.notJpeg++;
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(`${file}.part`, buffer);
                    fs.renameSync(`${file}.part`, file);
                    stats.downloaded++;
                    stats.bytes += buffer.length;
                }
                row.image_path = path.posix.join(path.basename(outDir), rel);
            } catch (err) {
                stats.failed++;
                if (stats.failures.length < 50) stats.failures.push({ snapshotId: row.snapshot_id, error: err.name || 'Error' });
            }
            if (++done % 200 === 0) log(`  images: ${done}/${rows.length}`);
        }
    };
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    return stats;
}

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

/**
 * The rows' photos already under outDir: sets image_path, and returns
 * snapshot_id -> { width, height, sha256, bytes } (size from the JPEG/PNG header).
 */
function readLocalImages(rows, outDir) {
    const { readImageSize } = require('../src/services/aiService');
    const images = new Map();
    for (const row of rows) {
        const rel = imageRelPath(row.device_serial, row.snapshot_id);
        const file = path.join(outDir, rel);
        if (!fs.existsSync(file)) continue;
        const buffer = fs.readFileSync(file);
        if (!buffer.length) continue;
        const size = readImageSize(buffer);
        images.set(row.snapshot_id, {
            width: size?.width ?? null,
            height: size?.height ?? null,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            bytes: buffer.length
        });
        row.image_path = path.posix.join(path.basename(outDir), rel);
    }
    return images;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const started = Date.now();
    const { MONGO_URI } = require('../src/config/env');
    guardReadOnly();
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await mongoose.connect(MONGO_URI, { autoIndex: false, autoCreate: false, readPreference: 'secondaryPreferred', serverSelectionTimeoutMS: 15000 });
    console.log(`Connected (read-only). Window: last ${opts.days} days, limit ${opts.limit}, excluded cameras: ${opts.excludeCameras.join(', ') || 'none'}.`);

    // Photos: the missing ones downloaded first (unless --no-images or --dry-run), then all read
    // from disk for the test-picture check and the image sizes
    let images = { downloaded: 0, alreadyPresent: 0, failed: 0, notJpeg: 0, bytes: 0, failures: [], skipped: true };
    const readImages = async (list) => {
        if (opts.images && !opts.dryRun) {
            fs.mkdirSync(opts.out, { recursive: true });
            console.log(`Downloading the missing photos of ${list.length} to ${opts.out}...`);
            images = { ...(await downloadImages(list, opts.out)), skipped: false };
        }
        const local = readLocalImages(list, opts.out);
        images.onDisk = local.size;
        images.notOnDisk = list.length - local.size;
        return local;
    };
    const { rows, boxes, sidecars, summary } = await buildDataset({ days: opts.days, limit: opts.limit, excludeCameras: opts.excludeCameras, readImages });
    const c = summary.counts;
    const counts = {
        snapshotsInWindow: c.snapshotsInWindow, processed: c.processed, unprocessed: c.unprocessed,
        excludedCameraSnapshots: c.excludedCameraSnapshots, excludedPrivacy: c.excludedPrivacy, excludedByLabel: c.excludedByLabel,
        eligible: c.eligible, eligibleConfirmed: c.eligibleConfirmed, eligibleCorrected: c.eligibleCorrected,
        excludedTestPictures: c.excludedTestPictures,
        selected: c.snapshotsTotal, selectedConfirmed: c.reviewedConfirmed, selectedCorrected: c.reviewedCorrected,
        camerasSeen: c.camerasSeen, camerasRegistered: c.camerasRegistered, dailyStatRows: c.dailyStatRows,
        maintenanceByType: c.maintenanceByType, cardReplacedEventsAllTime: c.cardReplacedEventsAllTime,
        treatments: c.treatments, farms: c.farms, plots: c.plots, plotsWithBoundary: c.plotsWithBoundary,
        photosPerDay: summary.photosPerDay.allCameras, dateRange: summary.dateRange,
        imagesOnDisk: images.onDisk, imagesNotOnDisk: images.notOnDisk,
        boxes: summary.boxes,
        testPictures: { ...summary.testPictures, hashes: summary.testPictures.hashes.length }
    };
    console.log(JSON.stringify(counts, null, 2));

    if (opts.dryRun) {
        console.log('Dry run: nothing downloaded or written.');
    } else {
        fs.mkdirSync(path.join(opts.out, 'boxes'), { recursive: true });
        for (const row of rows) writeJson(path.join(opts.out, boxesRelPath(row.snapshot_id)), boxes.get(row.snapshot_id));
        const manifestFile = path.join(path.dirname(opts.out), 'manifest.csv');
        fs.writeFileSync(manifestFile, toCsv(rows));
        writeJson(path.join(opts.out, 'cameras.json'), sidecars.cameras);
        writeJson(path.join(opts.out, 'daily_stats.json'), sidecars.dailyStats);
        writeJson(path.join(opts.out, 'maintenance_events.json'), sidecars.maintenanceEvents);
        writeJson(path.join(opts.out, 'treatments.json'), sidecars.treatments);
        writeJson(path.join(opts.out, 'farms_plots.json'), sidecars.farmsPlots);
        summary.images = images;
        summary.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
        writeJson(path.join(opts.out, 'summary.json'), summary);
        console.log(`Manifest: ${manifestFile} (${rows.length} rows); boxes: ${rows.length} files in ${path.join(opts.out, 'boxes')}`);
        console.log(`Images: ${images.downloaded} downloaded, ${images.alreadyPresent} already present, ${images.failed} failed; ${images.onDisk} on disk, ${images.notOnDisk} not on disk`);
    }
    console.log(`Done in ${Math.round((Date.now() - started) / 100) / 10} s.`);
    await mongoose.disconnect();
}

if (require.main === module) {
    main().catch(async (err) => {
        // Never print credentials a driver error might echo from the connection string
        console.error('Export failed:', String(err.message).replace(/\/\/[^@\s/]*@/g, '//***@'));
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
}

module.exports = {
    MANIFEST_COLUMNS,
    DEFAULT_EXCLUDED_CAMERAS,
    BOX_FORMAT,
    parseArgs,
    boxesOf,
    outOfBounds,
    findTestPictures,
    readLocalImages,
    pestCount,
    privacyLabels,
    aiSummaryOf,
    buildDataset,
    guardReadOnly,
    toCsv,
    csvCell
};
