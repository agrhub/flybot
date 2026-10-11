const { MaintenanceEvent, Snapshot } = require('../models');
const dailyStats = require('./dailyStats');
const { dailyValues } = require('./treatmentService');
const { Camera } = require('../models');
const { trapKindOf } = require('../constants/trap');
const { countPests } = require('./notificationService');
const { TIMEZONE } = require('./captureSchedule');

/**
 * Catches: insects that arrived on a trap, as opposed to the count on the sticky card.
 *
 * A sticky card only accumulates, so the count in a photo keeps growing until the card is
 * replaced. "How many flies today" is the rise of the card's daily peak over the day before
 * (card-change days and days after a gap are unknown, never zero). The standard monitoring
 * figure is FTD: flies per trap per day, i.e. catches divided by trap-days with data.
 * Lure traps without glue count the flies present in a photo, so their daily figure is the
 * average per photo (treatmentService.dailyValues); it feeds the same per-trap-per-day figures.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const round1 = (n) => Math.round(n * 10) / 10;
const addDays = (key, n) => dailyStats.dayKeyOf(new Date(`${key}T12:00:00Z`).getTime() + n * DAY_MS);
const percentChange = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 100) : null);

/**
 * Daily catches of each camera, total and per species, for the last `days` days (today included).
 * @returns {{ dayKeys: string[], cameras: Map<serial, { total: Map<day, n|null>, species: Map<name, Map<day, n|null>> }> }}
 */
async function catchesBySerial(serials, days, now = new Date()) {
    const today = dailyStats.dayKeyOf(now);
    const fromKey = addDays(today, -(days - 1));
    // One day more, for the first day's rise
    const rows = await dailyStats.rows(serials, addDays(fromKey, -1), today);
    const cardEvents = await MaintenanceEvent.find({
        deviceSerial: { $in: serials }, type: 'card_replaced', at: { $gte: new Date(now.getTime() - (days + 2) * DAY_MS), $lte: now }
    }).select('deviceSerial at').lean();

    const kinds = new Map((await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial trapKind').lean()).map(c => [c.deviceSerial, trapKindOf(c)]));
    const dayKeys = [];
    for (let d = fromKey; d <= today; d = addDays(d, 1)) dayKeys.push(d);

    // Rows by camera once (a long range of many cameras has tens of thousands of rows)
    const rowsBySerial = new Map();
    for (const r of rows) {
        if (!rowsBySerial.has(r.deviceSerial)) rowsBySerial.set(r.deviceSerial, []);
        rowsBySerial.get(r.deviceSerial).push(r);
    }
    const cameras = new Map();
    for (const serial of serials) {
        const own = rowsBySerial.get(serial) || [];
        const cardDays = new Set(cardEvents.filter(e => e.deviceSerial === serial).map(e => dailyStats.dayKeyOf(e.at)));
        const kind = kinds.get(serial) || 'sticky';
        const total = dailyValues(own, cardDays, fromKey, today, kind);
        const names = new Set(own.flatMap(r => (r.species || []).map(sp => sp.name)));
        const species = new Map();
        for (const name of names) {
            const speciesRows = own.map(r => {
                const sp = (r.species || []).find(x => x.name === name);
                return { day: r.day, peak: sp?.peak || 0, total: sp?.total || 0, scans: r.scans };
            });
            species.set(name, dailyValues(speciesRows, cardDays, fromKey, today, kind));
        }
        cameras.set(serial, { total, species, kind });
    }
    return { dayKeys, cameras };
}

/** Sum and trap-days of catches over some days (unknown days do not count). */
function summarize(cameraEntries, dayKeys) {
    let total = 0;
    let trapDays = 0;
    let maxDay = null;
    const perDay = new Map();
    for (const { total: byDay } of cameraEntries) {
        for (const day of dayKeys) {
            const v = byDay.get(day);
            if (v === null || v === undefined) continue;
            total += v;
            trapDays++;
            perDay.set(day, (perDay.get(day) || 0) + v);
        }
    }
    for (const [day, value] of perDay) if (!maxDay || value > maxDay.value) maxDay = { day, value };
    const daysWithData = perDay.size;
    return {
        total,
        trapDays,
        ftd: trapDays ? round1(total / trapDays) : null,
        avgPerDay: daysWithData ? round1(total / daysWithData) : null,
        maxDay
    };
}

/**
 * Catch summary for the dashboard: today, yesterday, last and previous 7 days, 14-day series.
 */
async function overview(serials, now = new Date()) {
    const { dayKeys, cameras } = await catchesBySerial(serials, 30, now);
    const entries = [...cameras.values()];
    const today = dayKeys.at(-1);
    const last = (n, offset = 0) => dayKeys.slice(dayKeys.length - n - offset, dayKeys.length - offset);

    const todayS = summarize(entries, [today]);
    const yesterdayS = summarize(entries, last(1, 1));
    const week = summarize(entries, last(7));
    const prevWeek = summarize(entries, last(7, 7));
    const month = summarize(entries, dayKeys);

    const series14 = last(14).map(day => {
        const byCamera = {};
        let total = null;
        for (const [serial, { total: byDay }] of cameras) {
            const v = byDay.get(day);
            byCamera[serial] = v ?? null;
            if (v !== null && v !== undefined) total = (total || 0) + v;
        }
        return { day, total, byCamera };
    });

    const perCamera = {};
    for (const [serial, { total: byDay }] of cameras) {
        const one = [{ total: byDay }];
        const w = summarize(one, last(7));
        const pw = summarize(one, last(7, 7));
        perCamera[serial] = {
            today: byDay.get(today) ?? null,
            last7: w.total,
            ftd7: w.ftd,
            prev7: pw.total,
            changePct: w.trapDays && pw.trapDays ? percentChange(w.total, pw.total) : null
        };
    }

    return {
        today: todayS.trapDays ? todayS.total : null,
        yesterday: yesterdayS.trapDays ? yesterdayS.total : null,
        periods: { day: todayS, week, month },
        last7: week.total,
        prev7: prevWeek.total,
        ftd7: week.ftd,
        ftdPrev7: prevWeek.ftd,
        changePct: week.trapDays && prevWeek.trapDays ? percentChange(week.total, prevWeek.total) : null,
        series14,
        perCamera
    };
}

/**
 * Chart series of daily catches per species, summed over cameras, in the shape the Statistics
 * chart uses: [{ _id: label, dateKey, insects: [{ label, value }] }]. mode "month" sums by month.
 */
function speciesCatchSeries({ dayKeys, cameras }, mode = 'day') {
    const periodOf = (day) => (mode === 'month' ? day.slice(0, 7) : day);
    const labelOf = (key) => {
        const [y, m, d] = key.split('-');
        return mode === 'month' ? `${m}/${y}` : `${d}/${m}`;
    };
    const periods = new Map();
    for (const day of dayKeys) {
        const key = periodOf(day);
        if (!periods.has(key)) periods.set(key, new Map());
        const bySpecies = periods.get(key);
        for (const { species } of cameras.values()) {
            for (const [name, byDay] of species) {
                const v = byDay.get(day);
                if (v === null || v === undefined) continue;
                bySpecies.set(name, (bySpecies.get(name) || 0) + v);
            }
        }
    }
    return [...periods.entries()]
        .filter(([, bySpecies]) => bySpecies.size)
        .map(([key, bySpecies]) => ({
            _id: labelOf(key),
            dateKey: key,
            insects: [...bySpecies.entries()].map(([label, value]) => ({ label, value }))
        }));
}

/**
 * When insects arrive: catches by local hour of the day (rise between consecutive photos of the
 * same card), for the last `days` days. Returns { days: [dayKey], hours: [6..18], cells: [[n]] }.
 */
async function activityByHour(serials, days = 14, now = new Date()) {
    const since = new Date(now.getTime() - days * DAY_MS);
    // Bounded on both sides: a report range can end in the past
    const snaps = await Snapshot.find({ deviceSerial: { $in: serials }, aiProcessed: true, createdAt: { $gte: since, $lte: now } })
        .sort({ deviceSerial: 1, createdAt: 1 })
        .select('deviceSerial createdAt pestCount aiResults.summary')
        .lean();
    const cardEvents = await MaintenanceEvent.find({ deviceSerial: { $in: serials }, type: 'card_replaced', at: { $gte: since, $lte: now } })
        .select('deviceSerial at').lean();
    const hourOf = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' });

    const kinds = new Map((await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial trapKind').lean()).map(c => [c.deviceSerial, trapKindOf(c)]));
    const cells = new Map(); // "day|hour" -> catches
    const lureSums = new Map(); // "day|hour|serial" -> { sum, n }
    let previous = null;
    for (const snap of snaps) {
        // Stored with the photo; older photos: added up from the summary
        const count = snap.pestCount ?? countPests(snap.aiResults?.summary instanceof Map ? Object.fromEntries(snap.aiResults.summary) : snap.aiResults?.summary);
        if (kinds.get(snap.deviceSerial) === 'lure') {
            const key = `${dailyStats.dayKeyOf(snap.createdAt)}|${Number(hourOf.format(snap.createdAt))}|${snap.deviceSerial}`;
            const cell = lureSums.get(key) || { sum: 0, n: 0 };
            cell.sum += count;
            cell.n++;
            lureSums.set(key, cell);
            previous = null;
            continue;
        }
        if (previous && previous.deviceSerial === snap.deviceSerial) {
            const changed = cardEvents.some(e => e.deviceSerial === snap.deviceSerial && e.at > previous.createdAt && e.at <= snap.createdAt);
            const rise = count - previous.count;
            // A drop means a new card (or a miscount): nothing arrived that we can measure
            if (!changed && rise > 0) {
                const key = `${dailyStats.dayKeyOf(snap.createdAt)}|${Number(hourOf.format(snap.createdAt))}`;
                cells.set(key, (cells.get(key) || 0) + rise);
            }
        }
        previous = { deviceSerial: snap.deviceSerial, createdAt: snap.createdAt, count };
    }

    // Lure traps: flies present on average in that hour, added to the sticky traps' catches
    for (const [key, { sum, n }] of lureSums) {
        const cellKey = key.split('|').slice(0, 2).join('|');
        cells.set(cellKey, Math.round(((cells.get(cellKey) || 0) + sum / n) * 10) / 10);
    }

    const today = dailyStats.dayKeyOf(now);
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) dayList.push(addDays(today, -i));
    const inRange = new Set(dayList);
    const hoursSeen = [...cells.keys()].filter(k => inRange.has(k.split('|')[0])).map(k => Number(k.split('|')[1]));
    const minHour = Math.min(6, ...hoursSeen);
    const maxHour = Math.max(18, ...hoursSeen);
    const hours = [];
    for (let h = minHour; h <= maxHour; h++) hours.push(h);
    return {
        days: dayList,
        hours,
        cells: dayList.map(day => hours.map(h => cells.get(`${day}|${h}`) || 0)),
        byHour: hours.map(h => dayList.reduce((s, day) => s + (cells.get(`${day}|${h}`) || 0), 0))
    };
}

module.exports = {
    catchesBySerial,
    summarize,
    overview,
    speciesCatchSeries,
    activityByHour,
    percentChange
};
