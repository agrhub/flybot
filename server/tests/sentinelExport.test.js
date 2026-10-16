const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const { MANIFEST_COLUMNS, buildDataset, toCsv, pestCount, privacyLabels, parseArgs } = require('../scripts/export_sentinel_dataset');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const NOW = new Date('2026-10-10T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

async function fixtures() {
    const owner = await createUser({ email: 'owner@example.test' });
    const farm = await models.Farm.create({ ownerId: owner._id, name: 'Mango farm', sharedWith: [{ email: 'friend@example.test' }] });
    const plot = await models.Plot.create({ farmId: farm._id, name: 'Plot A', boundary: [[10.1, 106.1], [10.2, 106.1], [10.2, 106.2]] });
    await createCamera(owner, { deviceSerial: 'C1', deviceName: 'Trap 1', latitude: 10.15, longitude: 106.15, farmId: farm._id, plotId: plot._id, alertThreshold: 20 });
    await createCamera(owner, { deviceSerial: 'C2', deviceName: 'Trap 2', trapKind: 'lure' });

    const snap = (deviceSerial, createdAt, rest = {}) => ({ deviceSerial, createdAt, imageUrl: 'u', s3Key: `${deviceSerial}/${createdAt.getTime()}.jpg`, aiProcessed: true, ...rest });
    const [s0, s1, s2, s3, s4, s5, c2a] = await models.Snapshot.create([
        snap('C1', daysAgo(40), { aiResults: { summary: { fruit_fly: 1 } } }),
        snap('C1', daysAgo(5), { aiResults: { summary: { fruit_fly: 10 } }, quality: { issues: [], checkedAt: daysAgo(5) } }),
        snap('C1', daysAgo(4), {
            aiResults: { summary: { fruit_fly: 12 }, insects: [{ name: 'fruit_fly', confidence: 0.9, bbox: [1, 2, 3, 4] }] },
            quality: { issues: ['blurry', 'low_contrast'], checkedAt: daysAgo(4) },
            review: { status: 'corrected', originalSummary: { fruit_fly: 9 }, reviewedBy: owner._id, reviewedAt: daysAgo(3) }
        }),
        // A person walked past the trap: never exported
        snap('C1', daysAgo(3), { aiResults: { summary: { fruit_fly: 3, person: 1 }, insects: [{ name: 'person', confidence: 0.8, bbox: [0, 0, 5, 5] }] } }),
        snap('C1', daysAgo(2), { aiResults: { summary: { fruit_fly: 15 } } }),
        snap('C1', daysAgo(1), { aiProcessed: false }),
        snap('C2', daysAgo(1), { aiResults: { summary: { fruit_fly: 4 } }, review: { status: 'confirmed', originalSummary: { fruit_fly: 4 }, reviewedAt: daysAgo(1) } })
    ]);
    await models.MaintenanceEvent.create([
        { deviceSerial: 'C1', type: 'card_replaced', at: daysAgo(60), userEmail: 'owner@example.test' },
        { deviceSerial: 'C1', type: 'card_replaced', at: daysAgo(4.5), source: 'detected' },
        { deviceSerial: 'C1', type: 'lens_cleaned', at: daysAgo(1), userEmail: 'owner@example.test' }
    ]);
    const treatment = await models.Treatment.create({ cameraSerials: ['C1'], type: 'spray', at: daysAgo(3.5), product: 'Radiant 60SC', operator: 'Ms Lan', createdByEmail: 'owner@example.test' });
    await models.DailyStat.create({ deviceSerial: 'C1', day: '2026-10-06', scans: 2, total: 12, peak: 12, min: 10 });
    return { s0, s1, s2, s3, s4, s5, c2a, treatment, farm, plot };
}

test('manifest columns match flybot-sentinel/data/README.md', () => {
    assert.equal(MANIFEST_COLUMNS.join(', '),
        'snapshot_id, device_serial, provider, captured_at, image_path, s3_key, farm_id, plot_id, lat, lon, trap_kind, ai_count, ai_counts_json, review_status, human_count, quality_issues, previous_snapshot_id, card_replaced_at, treatment_ids');
    assert.equal(toCsv([]).trim(), MANIFEST_COLUMNS.join(','));
});

test('pest counts and privacy labels follow NON_PEST_LABELS', () => {
    assert.equal(pestCount({ fruit_fly: 3, person: 2, Dog: 1 }), 3);
    assert.equal(pestCount(new Map([['fruit_fly', 2]])), 2);
    assert.deepEqual(privacyLabels({ aiResults: { insects: [{ name: 'Person' }, { name: 'fruit_fly' }] } }), ['person']);
    assert.deepEqual(privacyLabels({ aiResults: { summary: { fruit_fly: 2, person: 0 } } }), []);
    assert.deepEqual(privacyLabels({ aiResults: { summary: { người: 1 } } }), ['người']);
});

test('rows: counts before and after review, previous photo, card change, treatment; people excluded', async () => {
    const f = await fixtures();
    const { rows, summary, sidecars } = await buildDataset({ days: 30, limit: 100, now: NOW });
    const byId = Object.fromEntries(rows.map(r => [r.snapshot_id, r]));

    assert.deepEqual(rows.map(r => r.snapshot_id), [f.s1, f.s2, f.s4, f.c2a].map(s => String(s._id)));
    assert.equal(byId[String(f.s3._id)], undefined, 'photo with a person is not exported');
    assert.equal(summary.counts.excludedPrivacy, 1);
    assert.deepEqual(summary.counts.excludedByLabel, { person: 1 });
    assert.equal(summary.counts.snapshotsInWindow, 6);
    assert.equal(summary.counts.unprocessed, 1);

    const s1 = byId[String(f.s1._id)];
    assert.equal(s1.ai_count, 10);
    assert.equal(s1.human_count, '');
    assert.equal(s1.review_status, '');
    assert.equal(s1.previous_snapshot_id, String(f.s0._id), 'previous photo found before the window');
    assert.equal(s1.card_replaced_at, daysAgo(60).toISOString());
    assert.equal(s1.quality_issues, '');
    assert.equal(s1.provider, 'ezviz');
    assert.equal(s1.trap_kind, 'sticky');
    assert.equal(s1.farm_id, String(f.farm._id));
    assert.equal(s1.plot_id, String(f.plot._id));
    assert.equal(s1.lat, 10.15);
    assert.equal(s1.image_path, '');

    const s2 = byId[String(f.s2._id)];
    assert.equal(s2.review_status, 'corrected');
    assert.equal(s2.ai_count, 9, 'model count kept in originalSummary');
    assert.equal(s2.human_count, 12);
    assert.deepEqual(JSON.parse(s2.ai_counts_json), { fruit_fly: 9 });
    assert.equal(s2.quality_issues, 'blurry;low_contrast');
    assert.equal(s2.card_replaced_at, daysAgo(4.5).toISOString());
    assert.equal(s2.treatment_ids, '');

    const s4 = byId[String(f.s4._id)];
    assert.equal(s4.previous_snapshot_id, String(f.s2._id), 'the excluded photo is skipped');
    assert.equal(s4.treatment_ids, String(f.treatment._id));

    const c2a = byId[String(f.c2a._id)];
    assert.equal(c2a.review_status, 'confirmed');
    assert.equal(c2a.ai_count, 4);
    assert.equal(c2a.human_count, 4);
    assert.equal(c2a.trap_kind, 'lure');
    assert.equal(c2a.previous_snapshot_id, '');
    assert.equal(c2a.card_replaced_at, '');

    assert.equal(summary.counts.reviewedCorrected, 1);
    assert.equal(summary.counts.reviewedConfirmed, 1);
    assert.deepEqual(summary.counts.maintenanceByType, { card_replaced: 1, lens_cleaned: 1 });
    assert.equal(summary.counts.cardReplacedEventsAllTime, 2);
    assert.equal(summary.counts.plotsWithBoundary, 1);
    assert.equal(summary.perCamera.C1.exported, 3);
    assert.equal(sidecars.cameras.find(c => c.serial === 'C1').alertThreshold, 20);
    assert.equal(sidecars.dailyStats.length, 1);
    assert.equal(sidecars.farmsPlots.plots[0].boundary.length, 3);

    // No emails or people's names in what is exported
    const exported = JSON.stringify({ rows, sidecars });
    assert.doesNotMatch(exported, /@example\.test/);
    assert.doesNotMatch(exported, /Ms Lan/);

    const csv = toCsv(rows).trim().split('\n');
    assert.equal(csv.length, 5);
    assert.ok(csv[2].includes('"{""fruit_fly"":9}"'));
});

test('limit keeps reviewed photos first, then the most recent', async () => {
    const f = await fixtures();
    const { rows } = await buildDataset({ days: 30, limit: 3, now: NOW });
    assert.deepEqual(rows.map(r => r.snapshot_id).sort(), [f.s2, f.s4, f.c2a].map(s => String(s._id)).sort());
});

test('options', () => {
    assert.deepEqual({ ...parseArgs([]), out: undefined }, { days: 90, limit: 3000, out: undefined, dryRun: false, images: true, excludeCameras: ['AC6527557'] });
    assert.deepEqual(parseArgs(['--exclude-camera', 'none']).excludeCameras, []);
    assert.deepEqual(parseArgs(['--exclude-camera', 'X1,X2', '--exclude-camera', 'X3', '--exclude-camera', 'X1']).excludeCameras, ['X1', 'X2', 'X3']);
    assert.throws(() => parseArgs(['--exclude-camera', 'bad serial']));
    const o = parseArgs(['--days', '30', '--limit', '10', '--dry-run', '--no-images']);
    assert.equal(o.days, 30);
    assert.equal(o.limit, 10);
    assert.equal(o.dryRun, true);
    assert.equal(o.images, false);
    assert.throws(() => parseArgs(['--days', '0']));
    assert.throws(() => parseArgs(['--bogus']));
});

test('excluded cameras (default AC6527557) are left out and only counted', async () => {
    const f = await fixtures();
    const owner = await models.User.findOne({ email: 'owner@example.test' });
    await createCamera(owner, { deviceSerial: 'AC6527557', deviceName: 'Gravity01' });
    await models.Snapshot.create({ deviceSerial: 'AC6527557', createdAt: daysAgo(2), imageUrl: 'u', s3Key: 'k', aiProcessed: true, aiResults: { summary: { fruit_fly: 4 } } });

    const { rows, summary, sidecars } = await buildDataset({ days: 30, limit: 100, now: NOW });
    assert.ok(!rows.some(r => r.device_serial === 'AC6527557'));
    assert.equal(rows.length, 4);
    assert.equal(summary.counts.excludedCameraSnapshots, 1);
    assert.deepEqual(summary.excludedCameras, { list: ['AC6527557'], snapshotsInWindow: { AC6527557: 1 } });
    assert.ok(!sidecars.cameras.some(c => c.serial === 'AC6527557'));
    assert.equal(summary.perCamera.AC6527557, undefined);
    assert.equal(rows.find(r => r.snapshot_id === String(f.s1._id)).ai_count, 10);

    const all = await buildDataset({ days: 30, limit: 100, now: NOW, excludeCameras: [] });
    assert.equal(all.rows.filter(r => r.device_serial === 'AC6527557').length, 1);
});

test('boxes as stored (pixels) and the repeated 640x640 test pictures dropped', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'T1' });
    const box = (bbox, confidence) => ({ name: 'fruit_fly', confidence, bbox });
    const make = (hoursAgo, insects = []) => ({
        deviceSerial: 'T1', createdAt: new Date(NOW.getTime() - hoursAgo * 3600 * 1000), imageUrl: 'u', s3Key: `k${hoursAgo}`,
        aiProcessed: true, aiProvider: 'roboflow', aiResults: { summary: { fruit_fly: insects.length }, insects }
    });
    const [s0, s1, s2, s3, s4] = await models.Snapshot.create([
        make(50, [box([10, 10, 20, 20], 0.7)]),
        make(40, [box([1, 1, 5, 5], 0.9)]),
        make(30, [box([1, 1, 5, 5], 0.9)]),
        make(20),
        make(10, [box([100, 100, 120, 130], 0.6), box([1260, 700, 1300, 730], 0.95)])
    ]);
    const id = (s) => String(s._id);
    const sizes = {
        [id(s0)]: { width: 768, height: 432, sha256: 'a' },
        [id(s1)]: { width: 640, height: 640, sha256: 'disc' },
        [id(s2)]: { width: 640, height: 640, sha256: 'disc' },
        // 640x640 but seen once: a real photo, kept
        [id(s3)]: { width: 640, height: 640, sha256: 'unique' },
        [id(s4)]: { width: 1280, height: 720, sha256: 'b' }
    };
    let seen = null;
    const readImages = async (rows) => {
        seen = rows.map(r => r.snapshot_id);
        return new Map(Object.entries(sizes));
    };
    const { rows, boxes, summary } = await buildDataset({ days: 30, limit: 100, now: NOW, readImages });
    assert.equal(seen.length, 5, 'every selected photo is checked');
    assert.deepEqual(rows.map(r => r.snapshot_id), [id(s0), id(s3), id(s4)]);
    assert.equal(rows[1].previous_snapshot_id, id(s0), 'a dropped previous photo is replaced by the one before it');
    assert.equal(rows[2].previous_snapshot_id, id(s3));
    assert.equal(summary.counts.excludedTestPictures, 2);
    assert.equal(summary.counts.snapshotsTotal, 3);
    assert.equal(summary.perCamera.T1.exported, 3);
    assert.deepEqual({ dropped: summary.testPictures.dropped, distinct: summary.testPictures.distinctPictures, checked: summary.testPictures.imagesChecked },
        { dropped: 2, distinct: 1, checked: 5 });
    assert.deepEqual(summary.testPictures.byCamera, { T1: 2 });

    const b4 = boxes.get(id(s4));
    assert.equal(b4.boxFormat, 'xyxy_pixels');
    assert.equal(b4.imageWidth, 1280);
    assert.equal(b4.aiProvider, 'roboflow');
    assert.deepEqual(b4.boxes.map(b => b.confidence), [0.95, 0.6], 'highest confidence first');
    assert.deepEqual(b4.boxes[1].bbox, [100, 100, 120, 130]);
    assert.equal(b4.boxesOutOfBounds, 1, 'x 1300 > 1280 + 2');
    assert.deepEqual(boxes.get(id(s3)).boxes, []);
    assert.equal(boxes.has(id(s1)), false);
    assert.deepEqual({ rows: summary.boxes.rows, withBoxes: summary.boxes.rowsWithBoxes, boxes: summary.boxes.boxes, out: summary.boxes.boxesOutOfBounds },
        { rows: 3, withBoxes: 2, boxes: 3, out: 1 });
});

test('readLocalImages: path, size and hash of the photos already on disk', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const jpeg = require('jpeg-js');
    const { readLocalImages, outOfBounds } = require('../scripts/export_sentinel_dataset');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-export-'));
    try {
        const out = path.join(dir, 'export');
        fs.mkdirSync(path.join(out, 'images', 'T1'), { recursive: true });
        const img = jpeg.encode({ data: Buffer.alloc(640 * 640 * 4, 128), width: 640, height: 640 }, 50).data;
        fs.writeFileSync(path.join(out, 'images', 'T1', 'a.jpg'), img);
        const rows = [{ snapshot_id: 'a', device_serial: 'T1', image_path: '' }, { snapshot_id: 'b', device_serial: 'T1', image_path: '' }];
        const images = readLocalImages(rows, out);
        assert.equal(images.size, 1);
        assert.deepEqual({ w: images.get('a').width, h: images.get('a').height }, { w: 640, h: 640 });
        assert.match(images.get('a').sha256, /^[0-9a-f]{64}$/);
        assert.equal(rows[0].image_path, 'export/images/T1/a.jpg');
        assert.equal(rows[1].image_path, '');
        assert.equal(outOfBounds([{ bbox: [0, 0, 10, 10] }], null, null), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
