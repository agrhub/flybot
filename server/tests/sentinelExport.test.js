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
    assert.deepEqual({ ...parseArgs([]), out: undefined }, { days: 90, limit: 3000, out: undefined, dryRun: false, images: true });
    const o = parseArgs(['--days', '30', '--limit', '10', '--dry-run', '--no-images']);
    assert.equal(o.days, 30);
    assert.equal(o.limit, 10);
    assert.equal(o.dryRun, true);
    assert.equal(o.images, false);
    assert.throws(() => parseArgs(['--days', '0']));
    assert.throws(() => parseArgs(['--bogus']));
});
