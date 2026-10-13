const { DailyStat, MaintenanceEvent, Camera } = require('../models');
const { dayKeyOf, addDays, DAY_MS } = require('./dailyStats');

const { trapKindOf } = require('../constants/trap');

const DEFAULT_WINDOW_DAYS = 7;
// Fewer days than this after the treatment: too early to judge
const MIN_DAYS_AFTER = 2;


/**
 * Insects caught per day by one trap, from the daily rollup.
 * A sticky card only accumulates, so a day's catch is the rise of its peak over the
 * previous day; on a day the card was replaced it is unknown. Days without
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
        // The card was changed that day: its peak may still be the old card's count, so the
        // day's catch is unknown (the next day counts from the new card)
        if (cardDays.has(day)) {
            catches.set(day, null);
            continue;
        }
        const previous = peakByDay.get(addDays(day, -1));
        catches.set(day, previous === undefined ? null : Math.max(0, peak - previous));
    }
    return catches;
}

/**
 * A trap's daily figure, by trap kind (constants/trap.js):
 *  sticky - insects caught that day (dailyCatches)
 *  lure   - flies present on average per photo that day (rows need total and scans)
 * Returns Map(day -> value|null) for every day from fromKey to toKey.
 */
function dailyValues(rows, cardDays, fromKey, toKey, kind = 'sticky') {
    if (kind !== 'lure') return dailyCatches(rows, cardDays, fromKey, toKey);
    const byDay = new Map(rows.map(r => [r.day, r]));
    const values = new Map();
    for (let day = fromKey; day <= toKey; day = addDays(day, 1)) {
        const r = byDay.get(day);
        values.set(day, r && r.scans ? Math.round((r.total / r.scans) * 10) / 10 : null);
    }
    return values;
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

/** The days a treatment's effect looks at: the window before and after its day, up to today. */
function effectRange(treatment, windowDays, now) {
    const treatedDay = dayKeyOf(treatment.at);
    const todayKey = dayKeyOf(now);
    const lastAfter = addDays(treatedDay, windowDays);
    return {
        treatedDay,
        todayKey,
        // One extra day before the window, to compute the first day's rise
        fromKey: addDays(treatedDay, -(windowDays + 1)),
        toKey: lastAfter < todayKey ? lastAfter : todayKey
    };
}

/**
 * The daily rollup, card changes and trap kinds of some cameras over some days, in one go,
 * for one treatment or many (the summary per ingredient reads them once for all).
 */
async function loadEffectData(serials, fromKey, toKey) {
    const [rows, cardEvents, cameras] = await Promise.all([
        DailyStat.find({ deviceSerial: { $in: serials }, day: { $gte: fromKey, $lte: toKey } }).select('deviceSerial day peak total scans').lean(),
        MaintenanceEvent.find({
            deviceSerial: { $in: serials },
            type: 'card_replaced',
            // Padded a day each side: day keys are local time, the query is UTC
            at: { $gte: new Date(new Date(`${fromKey}T00:00:00Z`).getTime() - DAY_MS), $lte: new Date(new Date(`${toKey}T23:59:59Z`).getTime() + DAY_MS) }
        }).select('deviceSerial at').lean(),
        Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial trapKind').lean()
    ]);
    const rowsBySerial = new Map();
    for (const r of rows) {
        if (!rowsBySerial.has(r.deviceSerial)) rowsBySerial.set(r.deviceSerial, []);
        rowsBySerial.get(r.deviceSerial).push(r);
    }
    const cardDaysBySerial = new Map();
    for (const e of cardEvents) {
        if (!cardDaysBySerial.has(e.deviceSerial)) cardDaysBySerial.set(e.deviceSerial, new Set());
        cardDaysBySerial.get(e.deviceSerial).add(dayKeyOf(e.at));
    }
    return { rowsBySerial, cardDaysBySerial, kinds: new Map(cameras.map(c => [c.deviceSerial, trapKindOf(c)])) };
}

/** A treatment's effect from data already loaded (loadEffectData covering its range). */
function computeEffect(treatment, serials, data, { windowDays = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
    const { treatedDay, todayKey, fromKey, toKey } = effectRange(treatment, windowDays, now);
    const beforeKeys = [];
    for (let i = windowDays; i >= 1; i--) beforeKeys.push(addDays(treatedDay, -i));
    const afterKeys = [];
    for (let i = 1; i <= windowDays; i++) {
        const key = addDays(treatedDay, i);
        if (key <= todayKey) afterKeys.push(key);
    }

    const cameras = serials.map(serial => {
        // Rows outside the range only fill the padding day before it, which is not averaged
        const catches = dailyValues(data.rowsBySerial.get(serial) || [], data.cardDaysBySerial.get(serial) || new Set(), fromKey, toKey, data.kinds.get(serial));
        const before = average(beforeKeys.map(k => catches.get(k) ?? null));
        const after = average(afterKeys.map(k => catches.get(k) ?? null));
        return { deviceSerial: serial, before, after, changePct: percentChange(before, after) };
    });

    // Farm-level: sum of per-trap daily averages (cameras with data on both sides)
    const comparable = cameras.filter(c => c.before !== null && c.after !== null);
    const before = comparable.length ? Math.round(comparable.reduce((sum, c) => sum + c.before, 0) * 10) / 10 : null;
    const after = comparable.length ? Math.round(comparable.reduce((sum, c) => sum + c.after, 0) * 10) / 10 : null;
    const changePct = percentChange(before, after);

    let status;
    if (afterKeys.length < MIN_DAYS_AFTER) status = 'pending';
    else if (changePct === null) status = 'no_data';
    else if (changePct <= -30) status = 'effective';
    else if (changePct < 0) status = 'partial';
    else status = 'not_effective';

    return { windowDays, daysAfter: afterKeys.length, before, after, changePct, status, cameras };
}

/**
 * Catches per day in the window before the treatment day vs the window after it,
 * per camera and summed over cameras. `serials` limits it to cameras the viewer can see.
 */
async function effectOf(treatment, serials, { windowDays = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
    const { fromKey, toKey } = effectRange(treatment, windowDays, now);
    const data = await loadEffectData(serials, fromKey, toKey);
    return computeEffect(treatment, serials, data, { windowDays, now });
}

// Same name written differently ("Abamectin ", "abamectin") is one group
// Field sanitation and fruit bagging use no product: they have no ingredient to compare
const NO_INGREDIENT_TYPES = new Set(['sanitation', 'bagging']);
const groupKey = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * How well each active ingredient (or product, when none is written) worked across its uses:
 * the average change in flies per trap per day after it, and how many uses clearly worked.
 * Uses too recent to judge or without data count as uses but not in the average.
 * `treatments` are newest first; `visible` limits each one to the traps the viewer can see.
 */
async function effectivenessByIngredient(treatments, visible) {
    // Everything the treatments' windows need, read once
    const now = new Date();
    const usable = treatments.filter(t => !NO_INGREDIENT_TYPES.has(t.type) && t.cameraSerials.some(sr => visible.has(sr)));
    const allSerials = [...new Set(usable.flatMap(t => t.cameraSerials.filter(sr => visible.has(sr))))];
    let data = null;
    if (usable.length) {
        const ranges = usable.map(t => effectRange(t, DEFAULT_WINDOW_DAYS, now));
        data = await loadEffectData(allSerials, ranges.reduce((m, r) => (r.fromKey < m ? r.fromKey : m), ranges[0].fromKey), ranges.reduce((m, r) => (r.toKey > m ? r.toKey : m), ranges[0].toKey));
    }
    const groups = new Map();
    for (const t of treatments) {
        if (NO_INGREDIENT_TYPES.has(t.type)) continue;
        const name = (t.activeIngredient || t.product || '').trim();
        if (!name) continue;
        const key = groupKey(name);
        if (!groups.has(key)) {
            // Newest first: the latest spelling names the group
            groups.set(key, { name, products: new Set(), types: new Set(), uses: 0, measured: 0, effective: 0, changes: [], lastAt: t.at });
        }
        const group = groups.get(key);
        group.uses++;
        if (t.product && groupKey(t.product) !== key) group.products.add(t.product.trim());
        group.types.add(t.type);
        const serials = t.cameraSerials.filter(s => visible.has(s));
        if (!serials.length) continue;
        const effect = computeEffect(t, serials, data, { now });
        if (effect.changePct === null || effect.status === 'pending' || effect.status === 'no_data') continue;
        group.measured++;
        group.changes.push(effect.changePct);
        if (effect.status === 'effective') group.effective++;
    }
    return [...groups.values()]
        .map(g => ({
            name: g.name,
            products: [...g.products],
            types: [...g.types],
            uses: g.uses,
            measured: g.measured,
            effective: g.effective,
            avgChangePct: g.changes.length ? Math.round(g.changes.reduce((a, b) => a + b, 0) / g.changes.length) : null,
            lastAt: g.lastAt
        }))
        // Judged ones first, the strongest drop on top; then by how often they were used
        .sort((a, b) => (a.avgChangePct === null) - (b.avgChangePct === null)
            || (a.avgChangePct ?? 0) - (b.avgChangePct ?? 0)
            || b.uses - a.uses);
}

module.exports = {
    DEFAULT_WINDOW_DAYS,
    dailyCatches,
    dailyValues,
    effectOf,
    effectRange,
    loadEffectData,
    computeEffect,
    effectivenessByIngredient
};
