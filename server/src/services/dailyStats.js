const { Snapshot, DailyStat } = require('../models');
const { pestCountExpr, normalizeSpeciesExpr, NON_PEST_LABELS, FRUIT_FLY } = require('../constants/species');
const { TIMEZONE } = require('./captureSchedule');

/**
 * Daily per-camera rollup of AI results (models/DailyStat.js).
 *
 * Kept exact by recomputing a whole camera-day from its snapshots whenever one of them
 * changes (new AI result, human review). A day has at most ~100 scans, so that is cheap,
 * and it can never drift from the raw data.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE });
// "YYYY-MM-DD" in the farm's time zone
const dayKeyOf = (date) => dayFormat.format(new Date(date));
// Day key `days - 1` days before today, so "last N days" includes today
const startKeyForDays = (days) => dayKeyOf(new Date(Date.now() - (Math.max(1, days) - 1) * DAY_MS));

// Day keys are calendar dates: shifting one is plain date arithmetic. Long ranges step through
// the same days for every camera and species, so the results are kept (a few thousand entries).
const shifted = new Map();
function addDays(key, n) {
    const cacheKey = `${key}|${n}`;
    let result = shifted.get(cacheKey);
    if (result === undefined) {
        result = new Date(new Date(`${key}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
        if (shifted.size >= 20000) shifted.clear();
        shifted.set(cacheKey, result);
    }
    return result;
}

/**
 * Rollup documents for one camera from its processed snapshots in [from, to).
 */
async function computeDays(deviceSerial, from, to) {
    const match = { deviceSerial, aiProcessed: true, createdAt: { $gte: from, $lt: to } };
    const dayExpr = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TIMEZONE } };
    const [totals, species] = await Promise.all([
        Snapshot.aggregate([
            { $match: match },
            { $project: { day: dayExpr, count: pestCountExpr() } },
            { $group: { _id: '$day', scans: { $sum: 1 }, total: { $sum: '$count' }, peak: { $max: '$count' }, min: { $min: '$count' } } }
        ]),
        Snapshot.aggregate([
            { $match: match },
            { $project: { day: dayExpr, entries: { $objectToArray: { $ifNull: ['$aiResults.summary', {}] } } } },
            { $unwind: '$entries' },
            { $match: { 'entries.k': { $nin: NON_PEST_LABELS } } },
            { $group: { _id: { day: '$day', name: normalizeSpeciesExpr('$entries.k') }, peak: { $max: { $ifNull: ['$entries.v', 0] } }, total: { $sum: { $ifNull: ['$entries.v', 0] } } } }
        ])
    ]);

    const speciesByDay = new Map();
    for (const row of species) {
        if (NON_PEST_LABELS.includes(String(row._id.name).toLowerCase())) continue;
        if (!speciesByDay.has(row._id.day)) speciesByDay.set(row._id.day, []);
        speciesByDay.get(row._id.day).push({ name: row._id.name, peak: row.peak, total: row.total });
    }
    return totals.map(t => ({
        deviceSerial,
        day: t._id,
        scans: t.scans,
        total: t.total,
        peak: t.peak || 0,
        min: t.min || 0,
        species: (speciesByDay.get(t._id) || []).sort((a, b) => b.total - a.total)
    }));
}

/**
 * Recompute one camera's days between two dates (inclusive by local day) and replace them.
 */
async function rebuildRange(deviceSerial, fromDate, toDate) {
    // Pad by a day each side: day boundaries are local, the query is in UTC
    const from = new Date(new Date(fromDate).getTime() - DAY_MS);
    const to = new Date(new Date(toDate).getTime() + DAY_MS);
    const docs = await computeDays(deviceSerial, from, to);
    const fromKey = dayKeyOf(fromDate);
    const toKey = dayKeyOf(toDate);
    const inRange = docs.filter(d => d.day >= fromKey && d.day <= toKey);

    if (inRange.length) {
        await DailyStat.bulkWrite(inRange.map(doc => ({
            updateOne: {
                filter: { deviceSerial, day: doc.day },
                update: { $set: { ...doc, updatedAt: new Date() } },
                upsert: true
            }
        })), { ordered: false });
    }
    // Days that no longer have processed scans
    await DailyStat.deleteMany({ deviceSerial, day: { $gte: fromKey, $lte: toKey, $nin: inRange.map(d => d.day) } });
    return inRange.length;
}

// One refresh at a time per camera: two run side by side could each read the day before the
// other's photo was saved, and the one written last would leave the day short
const refreshQueues = new Map();

/**
 * After a snapshot's AI result changed. Never throws (statistics must not break captures).
 */
function refreshForSnapshot(snapshot) {
    if (!snapshot?.deviceSerial || !snapshot.createdAt) return Promise.resolve();
    const serial = snapshot.deviceSerial;
    const run = (refreshQueues.get(serial) || Promise.resolve())
        .then(() => rebuildRange(serial, snapshot.createdAt, snapshot.createdAt))
        .catch((err) => {
            console.error(`⚠️ Daily stats refresh failed (${serial}):`, err.message);
        });
    refreshQueues.set(serial, run);
    // Forget the camera once its queue is empty
    run.then(() => {
        if (refreshQueues.get(serial) === run) refreshQueues.delete(serial);
    });
    return run;
}

/**
 * Build the rollup for every camera's whole history (first start, or a manual rebuild).
 */
async function rebuildAll({ log = console.log } = {}) {
    const serials = await Snapshot.distinct('deviceSerial', { aiProcessed: true });
    const oldest = await Snapshot.findOne({ aiProcessed: true }).sort({ createdAt: 1 }).select('createdAt').lean();
    if (!oldest) return { cameras: 0, days: 0 };
    let days = 0;
    for (const serial of serials) {
        days += await rebuildRange(serial, oldest.createdAt, new Date());
    }
    log(`📊 Daily statistics rebuilt: ${serials.length} camera(s), ${days} day(s).`);
    return { cameras: serials.length, days };
}

/**
 * Start-up: build the rollup in the background when it has never been built.
 */
async function backfillIfEmpty() {
    try {
        const [hasStats, hasSnapshots] = await Promise.all([
            DailyStat.exists({}),
            Snapshot.exists({ aiProcessed: true })
        ]);
        if (hasStats || !hasSnapshots) return;
        console.log('📊 Building daily statistics from existing snapshots (runs in the background)...');
        await rebuildAll();
    } catch (err) {
        console.error('❌ Daily statistics backfill failed:', err.message);
    }
}

// ---------- Readers ----------

/**
 * Rollup rows for these cameras from `fromKey` (and up to `toKey`) as plain objects.
 */
function rows(serials, fromKey, toKey = null) {
    if (!serials.length) return Promise.resolve([]);
    const day = { $gte: fromKey };
    if (toKey) day.$lte = toKey;
    return DailyStat.find({ deviceSerial: { $in: serials }, day }).lean();
}

/**
 * Analyzed photos of these cameras over their whole history, from the rollup (one row per
 * camera and day) rather than counting every photo.
 */
async function scanCount(serials) {
    if (!serials.length) return 0;
    const [row] = await DailyStat.aggregate([
        { $match: { deviceSerial: { $in: serials } } },
        { $group: { _id: null, scans: { $sum: '$scans' } } }
    ]);
    return row?.scans || 0;
}

/**
 * Species totals (sum of counts over scans) across rows, largest first.
 */
function speciesTotals(list, field = 'total') {
    const totals = new Map();
    for (const row of list) {
        for (const sp of row.species || []) totals.set(sp.name, (totals.get(sp.name) || 0) + (sp[field] || 0));
    }
    return [...totals.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

/**
 * Chart series for Statistics: per period, each species' trap peaks summed over cameras.
 * mode "day" -> per day, "month" -> per month (a camera's highest day in the month).
 * Same shape as the raw aggregation it replaces: [{ _id: label, dateKey, insects: [{label, value}] }].
 */
function speciesSeries(list, mode) {
    const periodOf = (day) => (mode === 'month' ? day.slice(0, 7) : day);
    const labelOf = (key) => {
        const [y, m, d] = key.split('-');
        return mode === 'month' ? `${m}/${y}` : `${d}/${m}`;
    };
    // period -> species -> camera -> peak
    const peaks = new Map();
    for (const row of list) {
        const period = periodOf(row.day);
        if (!peaks.has(period)) peaks.set(period, new Map());
        const bySpecies = peaks.get(period);
        // A day with scans but no detections still shows up (as fruit fly 0)
        const species = row.species?.length ? row.species : [{ name: FRUIT_FLY, peak: 0 }];
        for (const sp of species) {
            if (!bySpecies.has(sp.name)) bySpecies.set(sp.name, new Map());
            const byCamera = bySpecies.get(sp.name);
            byCamera.set(row.deviceSerial, Math.max(byCamera.get(row.deviceSerial) || 0, sp.peak || 0));
        }
    }
    return [...peaks.keys()].sort().map(period => ({
        _id: labelOf(period),
        dateKey: period,
        insects: [...peaks.get(period).entries()].map(([label, byCamera]) => ({
            label,
            value: [...byCamera.values()].reduce((sum, v) => sum + v, 0)
        }))
    }));
}

module.exports = {
    DAY_MS,
    dayKeyOf,
    addDays,
    startKeyForDays,
    computeDays,
    rebuildRange,
    refreshForSnapshot,
    rebuildAll,
    backfillIfEmpty,
    rows,
    scanCount,
    speciesTotals,
    speciesSeries
};
