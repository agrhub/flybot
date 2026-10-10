const { DailyStat, MaintenanceEvent } = require('../models');
const { dayKeyOf, DAY_MS } = require('./dailyStats');

const DEFAULT_WINDOW_DAYS = 7;
// Fewer days than this after the treatment: too early to judge
const MIN_DAYS_AFTER = 2;

const addDays = (key, n) => dayKeyOf(new Date(`${key}T12:00:00Z`).getTime() + n * DAY_MS);

/**
 * Insects caught per day by one trap, from the daily rollup.
 * A sticky card only accumulates, so a day's catch is the rise of its peak over the
 * previous day; on a day the card was replaced it is that day's peak. Days without
 * data (or right after a gap) are unknown (null), never zero.
 * Returns Map(day -> catch|null) for every day from fromKey to toKey.
 */
function dailyCatches(rows, cardDays, fromKey, toKey) {
    const peakByDay = new Map(rows.map(r => [r.day, r.peak]));
    const catches = new Map();
    for (let day = fromKey; day <= toKey; day = addDays(day, 1)) {
        const peak = peakByDay.get(day);
        if (peak === undefined) {
            catches.set(day, null);
            continue;
        }
        if (cardDays.has(day)) {
            catches.set(day, peak);
            continue;
        }
        const previous = peakByDay.get(addDays(day, -1));
        catches.set(day, previous === undefined ? null : Math.max(0, peak - previous));
    }
    return catches;
}

const average = (values) => {
    const known = values.filter(v => v !== null);
    return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
};

const percentChange = (before, after) => {
    if (before === null || after === null) return null;
    if (before === 0) return after === 0 ? 0 : null;
    return Math.round(((after - before) / before) * 100);
};

/**
 * Catches per day in the window before the treatment day vs the window after it,
 * per camera and summed over cameras. `serials` limits it to cameras the viewer can see.
 */
async function effectOf(treatment, serials, { windowDays = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
    const treatedDay = dayKeyOf(treatment.at);
    const todayKey = dayKeyOf(now);
    // One extra day before the window, to compute the first day's rise
    const fromKey = addDays(treatedDay, -(windowDays + 1));
    const lastAfter = addDays(treatedDay, windowDays);
    const toKey = lastAfter < todayKey ? lastAfter : todayKey;

    const [rows, cardEvents] = await Promise.all([
        DailyStat.find({ deviceSerial: { $in: serials }, day: { $gte: fromKey, $lte: toKey } }).select('deviceSerial day peak').lean(),
        MaintenanceEvent.find({
            deviceSerial: { $in: serials },
            type: 'card_replaced',
            // Padded a day each side: day keys are local time, the query is UTC
            at: { $gte: new Date(new Date(`${fromKey}T00:00:00Z`).getTime() - DAY_MS), $lte: new Date(new Date(`${toKey}T23:59:59Z`).getTime() + DAY_MS) }
        }).select('deviceSerial at').lean()
    ]);

    const beforeKeys = [];
    for (let i = windowDays; i >= 1; i--) beforeKeys.push(addDays(treatedDay, -i));
    const afterKeys = [];
    for (let i = 1; i <= windowDays; i++) {
        const key = addDays(treatedDay, i);
        if (key <= todayKey) afterKeys.push(key);
    }

    const cameras = serials.map(serial => {
        const cardDays = new Set(cardEvents.filter(e => e.deviceSerial === serial).map(e => dayKeyOf(e.at)));
        const catches = dailyCatches(rows.filter(r => r.deviceSerial === serial), cardDays, fromKey, toKey);
        const before = average(beforeKeys.map(k => catches.get(k) ?? null));
        const after = average(afterKeys.map(k => catches.get(k) ?? null));
        return { deviceSerial: serial, before, after, changePct: percentChange(before, after) };
    });

    // Farm-level: sum of per-trap daily averages (cameras with data on both sides)
    const comparable = cameras.filter(c => c.before !== null && c.after !== null);
    const before = comparable.length ? Math.round(comparable.reduce((s, c) => s + c.before, 0) * 10) / 10 : null;
    const after = comparable.length ? Math.round(comparable.reduce((s, c) => s + c.after, 0) * 10) / 10 : null;
    const changePct = percentChange(before, after);

    let status;
    if (afterKeys.length < MIN_DAYS_AFTER) status = 'pending';
    else if (changePct === null) status = 'no_data';
    else if (changePct <= -30) status = 'effective';
    else if (changePct < 0) status = 'partial';
    else status = 'not_effective';

    return { windowDays, daysAfter: afterKeys.length, before, after, changePct, status, cameras };
}

module.exports = {
    DEFAULT_WINDOW_DAYS,
    dailyCatches,
    effectOf
};
