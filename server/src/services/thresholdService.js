const dailyStats = require('./dailyStats');
const { trapKindOf } = require('../constants/trap');

/**
 * Alert thresholds suggested from a trap's own last 30 days, on the figure its alert compares:
 * the highest count on the card each day for a sticky trap (the latest photo is compared),
 * the day's average per photo for a lure trap. The suggestion is the 90th percentile, so
 * about 3 of the last 30 days would have alerted: the busy days, not every day nor none.
 */
const DAYS = 30;
// Fewer days with data than this: too little to suggest anything
const MIN_DAYS = 7;
const PERCENTILE = 0.9;
const MIN_THRESHOLD = 5;
const DEFAULT_THRESHOLD = 15;

/** Nearest-rank percentile of some numbers (p from 0 to 1). */
function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** The daily figures an alert would have been judged on, for one trap. */
function dailyFigures(rows, kind) {
    return rows
        .map(r => (kind === 'lure' ? (r.scans ? r.total / r.scans : null) : r.peak))
        .filter(v => typeof v === 'number' && Number.isFinite(v));
}

/** Suggestion for one trap from its daily figures. */
function suggest(figures, current) {
    const threshold = current || DEFAULT_THRESHOLD;
    const alertDays = (th) => figures.filter(v => v >= th).length;
    if (figures.length < MIN_DAYS) return { days: figures.length, current: threshold, suggested: null, alertDaysCurrent: alertDays(threshold), alertDaysSuggested: null };
    const suggested = Math.max(MIN_THRESHOLD, Math.ceil(percentile(figures, PERCENTILE)));
    return {
        days: figures.length,
        current: threshold,
        suggested,
        typical: Math.round(percentile(figures, 0.5) * 10) / 10,
        alertDaysCurrent: alertDays(threshold),
        alertDaysSuggested: alertDays(suggested)
    };
}

/** Suggestions for some cameras ({ deviceSerial, alertThreshold, trapKind }). */
async function suggestThresholds(cameras, now = new Date()) {
    if (!cameras.length) return [];
    const today = dailyStats.dayKeyOf(now);
    const rows = await dailyStats.rows(cameras.map(c => c.deviceSerial), dailyStats.addDays(today, -(DAYS - 1)), today);
    return cameras.map(camera => {
        const kind = trapKindOf(camera);
        const own = rows.filter(r => r.deviceSerial === camera.deviceSerial);
        return { deviceSerial: camera.deviceSerial, basis: kind === 'lure' ? 'dailyAverage' : 'cardCount', ...suggest(dailyFigures(own, kind), camera.alertThreshold) };
    });
}

module.exports = {
    DAYS,
    percentile,
    suggest,
    suggestThresholds
};
