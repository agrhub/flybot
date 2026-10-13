const { MaintenanceEvent } = require('../models');
const dailyStats = require('./dailyStats');
const { dailyValues } = require('./treatmentService');
const { trapKindOf } = require('../constants/trap');
const weatherService = require('./weatherService');
const weatherRisk = require('./weatherRiskService');

/**
 * Degree-day model for the next wave of adult fruit flies (Bactrocera dorsalis).
 *
 * Insects develop by accumulated heat, not by calendar days. Starting from the last big
 * catch (adults laying eggs), the next generation emerges once the days above BASE_TEMP
 * add up to GENERATION_DD. Values are approximate figures from published lab studies
 * (lower threshold about 12 °C, egg to adult about 300-400 degree-days), so the result is
 * a planning hint, not an exact date.
 */
const BASE_TEMP = 12;
// Development stops climbing above this temperature (horizontal cutoff)
const UPPER_TEMP = 35;
const GENERATION_DD = 350;
// A catch day has to be at least this big to count as a wave of adults
const MIN_WAVE = 5;
// How far back a catch peak is looked for
const ANCHOR_DAYS = 30;
// Days of past degree-days returned for the chart
const CHART_PAST_DAYS = 14;
// A wave "now" stays shown for a couple of days after its expected date
const WAVE_GRACE_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (key, n) => new Date(new Date(`${key}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / DAY_MS);
const round1 = (n) => Math.round(n * 10) / 10;

/** Degree-days of one day, simple average method with an upper cutoff. */
function dayDegrees(min, max) {
    const mean = (Math.min(min, UPPER_TEMP) + Math.min(max, UPPER_TEMP)) / 2;
    return Math.max(0, mean - BASE_TEMP);
}

/**
 * @param {Array<{day, min, max, forecast}>} temps  daily temperatures, oldest first
 * @param {Map<string, number|null>} catchesByDay  insects caught per day (all selected traps)
 * @param {string} today  'YYYY-MM-DD'
 */
function computeDegreeDays({ temps, catchesByDay, today }) {
    if (!temps?.length) return null;
    const ddByDay = new Map(temps.map(t => [t.day, dayDegrees(t.min, t.max)]));
    const lastDay = temps[temps.length - 1].day;

    const upcoming = temps.filter(t => t.day >= today).slice(0, 7).map(t => ddByDay.get(t.day));
    const avgDailyDd = upcoming.length ? upcoming.reduce((a, b) => a + b, 0) / upcoming.length : 0;
    // Average of the forecast, for dates past the end of the forecast
    const futureDd = temps.filter(t => t.day > today).map(t => ddByDay.get(t.day));
    const extrapolateDd = futureDd.length ? futureDd.reduce((a, b) => a + b, 0) / futureDd.length : avgDailyDd;

    // The biggest catch day of the last month (latest one on a tie)
    let anchor = null;
    const earliest = addDays(today, -ANCHOR_DAYS);
    for (const [day, value] of catchesByDay) {
        if (day < earliest || day > today || !value || value < MIN_WAVE) continue;
        if (!anchor || value >= anchor.catches) anchor = { day, catches: value };
    }

    let nextWave = null;
    let accumulated = null;
    if (anchor) {
        // Generation k emerges when degree-days since the anchor reach k × GENERATION_DD.
        // Report the first one from a couple of days ago on.
        let total = 0;
        let generation = 1;
        accumulated = 0;
        for (let day = addDays(anchor.day, 1); ; day = addDays(day, 1)) {
            const known = ddByDay.get(day);
            const estimated = known === undefined;
            // Days before the weather data starts have no known temperature: use today's pace
            total += estimated ? extrapolateDd : known;
            if (day <= today) accumulated = total;
            while (total >= generation * GENERATION_DD) {
                if (day >= addDays(today, -WAVE_GRACE_DAYS)) {
                    nextWave = { date: day, inDays: daysBetween(today, day), generation, estimated: estimated && day > lastDay };
                    break;
                }
                generation++;
            }
            if (nextWave || generation > 6 || daysBetween(today, day) > 120) break;
        }
        accumulated = round1(accumulated - (Math.floor(accumulated / GENERATION_DD) * GENERATION_DD));
    }

    const days = temps
        .filter(t => t.day >= addDays(today, -(CHART_PAST_DAYS - 1)))
        .map(t => ({ day: t.day, dd: round1(ddByDay.get(t.day)), min: t.min, max: t.max, forecast: t.day > today }));
    // The next days' weather against the conditions fruit flies thrive in
    const outlook = weatherRisk.outlook(temps, nextWave, today);

    return {
        model: { species: 'bactrocera_dorsalis', baseTemp: BASE_TEMP, upperTemp: UPPER_TEMP, generationDd: GENERATION_DD },
        todayDd: ddByDay.has(today) ? round1(ddByDay.get(today)) : null,
        avgDailyDd: round1(avgDailyDd),
        // How many days one generation takes at the coming week's temperatures
        generationDays: avgDailyDd > 0 ? Math.round(GENERATION_DD / avgDailyDd) : null,
        anchor,
        // Degree-days gathered by the current generation so far, and its share of the total
        accumulated,
        progressPct: accumulated === null ? null : Math.min(100, Math.round((accumulated / GENERATION_DD) * 100)),
        nextWave,
        days,
        outlook
    };
}

/**
 * The model for a set of cameras, using the first one with GPS for the weather.
 * Returns null when there is no location or no weather.
 */
async function forCameras(cameras, now = new Date()) {
    const located = cameras.find(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
    if (!located) return null;
    const temps = await weatherService.getDailyTemperatures(located.latitude, located.longitude);
    if (!temps) return null;

    const today = dailyStats.dayKeyOf(now);
    const fromKey = addDays(today, -(ANCHOR_DAYS + 1));
    const serials = cameras.map(c => c.deviceSerial);
    const [rows, cardEvents] = await Promise.all([
        dailyStats.rows(serials, fromKey),
        MaintenanceEvent.find({ deviceSerial: { $in: serials }, type: 'card_replaced', at: { $gte: new Date(now.getTime() - (ANCHOR_DAYS + 2) * DAY_MS) } }).select('deviceSerial at').lean()
    ]);

    const catchesByDay = new Map();
    for (const serial of serials) {
        const cardDays = new Set(cardEvents.filter(e => e.deviceSerial === serial).map(e => dailyStats.dayKeyOf(e.at)));
        const camera = cameras.find(c => c.deviceSerial === serial);
        const catches = dailyValues(rows.filter(r => r.deviceSerial === serial), cardDays, fromKey, today, trapKindOf(camera));
        for (const [day, value] of catches) {
            if (value === null) continue;
            catchesByDay.set(day, (catchesByDay.get(day) || 0) + value);
        }
    }
    return computeDegreeDays({ temps, catchesByDay, today });
}

module.exports = {
    BASE_TEMP,
    GENERATION_DD,
    dayDegrees,
    computeDegreeDays,
    forCameras
};
