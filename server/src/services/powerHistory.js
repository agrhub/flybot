const { Snapshot, PowerReading } = require('../models');

/**
 * Battery history of a CamOS camera for the power charts (GET /api/cameras/:serial/power-history): the reading sent
 * with every photo (Snapshot.meta.battery) and the readings of its MQTT state, telemetry and events in between
 * (PowerReading, stored by platforms/camos.js), with the charging periods and the rate of change (mV/h, %/h).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_DAYS = 30;
// Documents read per source at most, and points answered at most (thinned evenly beyond)
const MAX_DOCS = 20000;
const MAX_POINTS = 1500;
// Two readings further apart than this give no rate (the camera was away)
const MAX_RATE_GAP_H = 14;
// A message time further off than this is a clock without NTP: FlyBot's time is used
const MAX_CLOCK_SKEW_MS = 7 * DAY_MS;

const finite = (v) => (Number.isFinite(v) ? v : undefined);
const round1 = (v) => Math.round(v * 10) / 10;

/** The days a request asks for: a whole number from 1 to 30 (1 by default). */
function daysOf(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_DAYS) : 1;
}

/** When a camera message was read: its `ts` (ms, UTC) when the clock looks right, else `now`. */
function readingTime(ts, now = new Date()) {
    const n = Number(ts);
    return Number.isFinite(n) && n > 0 && Math.abs(n - now.getTime()) < MAX_CLOCK_SKEW_MS ? new Date(n) : now;
}

/**
 * Keep one reading from a camera message (`battery` as platforms/camos.js batteryOf returns it). Never throws:
 * the message is handled whether the reading is kept or not.
 */
async function record(deviceSerial, battery, { at = new Date(), source = 'telemetry' } = {}) {
    if (!deviceSerial || !battery || !Number.isFinite(battery.mv)) return false;
    const fields = { mv: battery.mv, pct: finite(battery.pct), charging: battery.charging, charge: battery.charge, solarMv: finite(battery.solarMv), measuredMv: finite(battery.measuredMv), source };
    try {
        await PowerReading.updateOne({ deviceSerial, at }, { $setOnInsert: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) }, { upsert: true });
        return true;
    } catch (err) {
        if (err?.code !== 11000) console.warn(`⚠️ Power reading ${deviceSerial}: ${err.message}`);
        return false;
    }
}

const pointOf = (at, b, source) => {
    const p = { at: new Date(at), mv: b.mv, source };
    for (const k of ['pct', 'solarMv', 'measuredMv']) if (Number.isFinite(b[k])) p[k] = b[k];
    if (typeof b.charging === 'boolean') p.charging = b.charging;
    if (b.charge) p.charge = b.charge;
    return p;
};

/** At most `max` points, evenly over time; a point where charging starts or stops is always kept. */
function thin(points, max = MAX_POINTS) {
    if (points.length <= max) return points;
    const first = points[0].at.getTime();
    const width = (points.at(-1).at.getTime() - first) / max;
    const kept = [];
    let lastBucket = -1;
    let lastCharging;
    for (const p of points) {
        const bucket = Math.floor((p.at.getTime() - first) / width);
        const flip = p.charging !== undefined && lastCharging !== undefined && p.charging !== lastCharging;
        if (bucket !== lastBucket || flip) {
            kept.push(p);
            lastBucket = bucket;
        }
        if (p.charging !== undefined) lastCharging = p.charging;
    }
    return kept;
}

/**
 * The periods it charged: from the first charging reading to the first reading that is not (or the last charging
 * one at the end). `slow`: the charger said its input is too low to charge well (a small or shaded panel).
 */
function chargingSpans(points) {
    const spans = [];
    let open = null;
    for (const p of points) {
        if (p.charging === true) {
            if (!open) open = { from: p.at, to: p.at, slow: false };
            open.to = p.at;
            if (p.charge === 'slow') open.slow = true;
        } else if (p.charging === false && open) {
            open.to = p.at;
            spans.push(open);
            open = null;
        }
    }
    if (open) spans.push(open);
    return spans;
}

/** The bucket width of the rate: about 24 rates a day for a day, fewer for longer ranges. */
const rateBucketHours = (days) => (days <= 1 ? 1 : days <= 3 ? 2 : days <= 7 ? 3 : 6);

/**
 * The rate of change between consecutive time buckets (the mean of the readings in each, so a reading under the
 * camera's load and one at rest average out): negative while it drains, positive while it charges.
 */
function rates(points, days) {
    const width = rateBucketHours(days) * HOUR_MS;
    const buckets = [];
    for (const p of points) {
        const key = Math.floor(p.at.getTime() / width);
        let b = buckets.at(-1);
        if (!b || b.key !== key) buckets.push(b = { key, n: 0, t: 0, mv: 0, pctN: 0, pct: 0, charging: false });
        b.n++;
        b.t += p.at.getTime();
        b.mv += p.mv;
        if (Number.isFinite(p.pct)) {
            b.pctN++;
            b.pct += p.pct;
        }
        if (p.charging === true) b.charging = true;
    }
    const out = [];
    for (let i = 1; i < buckets.length; i++) {
        const a = buckets[i - 1];
        const b = buckets[i];
        const ta = a.t / a.n;
        const tb = b.t / b.n;
        const hours = (tb - ta) / HOUR_MS;
        if (hours <= 0 || hours > MAX_RATE_GAP_H) continue;
        const rate = {
            from: new Date(ta),
            to: new Date(tb),
            at: new Date((ta + tb) / 2),
            hours: round1(hours),
            mvPerHour: Math.round((b.mv / b.n - a.mv / a.n) / hours),
            charging: a.charging || b.charging
        };
        if (a.pctN && b.pctN) rate.pctPerHour = round1((b.pct / b.pctN - a.pct / a.pctN) / hours);
        out.push(rate);
    }
    return out;
}

/** Time-weighted mean of a rate field over the rates that match. */
function meanRate(list, key, match) {
    let hours = 0;
    let sum = 0;
    for (const r of list) {
        if (!match(r) || !Number.isFinite(r[key])) continue;
        hours += r.hours;
        sum += r[key] * r.hours;
    }
    return hours ? round1(sum / hours) : null;
}

/**
 * The battery history of one camera over the last `days` days: { from, to, days, battery: { points, charging,
 * rates, summary } }. Points are sorted by time; `source` says where each came from (photo, state, telemetry, event).
 */
async function history(deviceSerial, { days = 1, now = new Date() } = {}) {
    days = daysOf(days);
    const from = new Date(now.getTime() - days * DAY_MS);
    const [snaps, readings] = await Promise.all([
        Snapshot.find({ deviceSerial, createdAt: { $gte: from, $lte: now }, 'meta.battery.mv': { $exists: true } })
            .sort({ createdAt: 1 }).limit(MAX_DOCS).select('createdAt meta.battery').lean(),
        PowerReading.find({ deviceSerial, at: { $gte: from, $lte: now } }).sort({ at: 1 }).limit(MAX_DOCS).lean()
    ]);
    const all = [
        ...snaps.filter(s => Number.isFinite(s.meta?.battery?.mv)).map(s => pointOf(s.createdAt, s.meta.battery, 'photo')),
        ...readings.map(r => pointOf(r.at, r, r.source || 'telemetry'))
    ].sort((a, b) => a.at - b.at);

    const rateList = rates(all, days);
    const last = all.at(-1) || null;
    const solar = all.map(p => p.solarMv).filter(Number.isFinite);
    const drainPct = meanRate(rateList, 'pctPerHour', r => !r.charging);
    const summary = {
        readings: all.length,
        last: last ? { ...last } : null,
        firstMv: all[0]?.mv ?? null,
        // Mean rate while not charging (the camera's consumption) and while charging
        drainMvPerHour: meanRate(rateList, 'mvPerHour', r => !r.charging),
        drainPctPerHour: drainPct,
        chargeMvPerHour: meanRate(rateList, 'mvPerHour', r => r.charging),
        chargingHours: round1(chargingSpans(all).reduce((h, s) => h + (s.to - s.from) / HOUR_MS, 0)),
        solarMaxMv: solar.length ? Math.max(...solar) : null,
        // At the mean drain, hours until the cell is empty
        hoursLeft: drainPct !== null && drainPct < 0 && Number.isFinite(last?.pct) ? Math.round(last.pct / -drainPct) : null
    };
    return {
        days,
        from,
        to: now,
        battery: { points: thin(all), charging: chargingSpans(all), rates: rateList, summary }
    };
}

module.exports = {
    MAX_DAYS,
    daysOf,
    readingTime,
    record,
    thin,
    chargingSpans,
    rates,
    history
};
