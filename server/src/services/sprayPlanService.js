const { Farm, Plot, Treatment } = require('../models');
const { viewableCameras } = require('../utils/ownership');
const catchStats = require('./catchStats');
const dailyStats = require('./dailyStats');
const degreeDayService = require('./degreeDayService');
const farmService = require('./farmService');
const { orgRolesOf } = require('./orgService');
const { latestProcessedByCamera } = require('./snapshotQueries');
const { judgedCounts } = require('./dashboardService');
const { countPests } = require('./notificationService');
const { thresholdOf } = require('../constants/risk');

/**
 * What to do next on each plot, from what FlyBot knows (simple, explainable rules, a suggestion
 * the grower decides on):
 *  1. treat_now   - traps at their alert threshold and no treatment in the past week, on the first
 *                   day without heavy rain;
 *     wait_check  - the same, but a treatment was logged less than a week ago: check its effect;
 *  2. bait_before_wave - a new fly generation is due within 10 days (degree-days): bait a few
 *                   days before it emerges;
 *  3. sanitation  - the next days favor fruit flies: collect fallen fruit, check the traps;
 *  4. monitor     - nothing to do but keep the traps working.
 * When the last two sprays used the same active ingredient, the next one should change it
 * (resistance management).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_DAYS = 7;
const WAVE_WINDOW_DAYS = 10;
const WAVE_LEAD_DAYS = 3;
// A day with this much rain washes a spray or bait off
const RAIN_MM = 10;
const HISTORY_DAYS = 120;
const ORDER = ['treat_now', 'wait_check', 'bait_before_wave', 'sanitation', 'monitor'];

const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** The first day from `fromKey` on that is not forecast to be very wet. */
function dryDay(fromKey, outlookDays) {
    const wet = new Set((outlookDays || []).filter(d => d.rain !== null && d.rain >= RAIN_MM).map(d => d.day));
    let day = fromKey;
    for (let i = 0; i < 7 && wet.has(day); i++) day = dailyStats.addDays(day, 1);
    return { day, moved: day !== fromKey };
}

/** One plot's suggestion. */
function suggest({ atThreshold, lastTreatment, sprays, wave, outlook, today, now }) {
    let action = 'monitor';
    let date = null;
    let waitUntil = null;
    if (atThreshold > 0) {
        const since = lastTreatment ? (now - new Date(lastTreatment.at)) / DAY_MS : Infinity;
        if (since < MIN_INTERVAL_DAYS) {
            action = 'wait_check';
            waitUntil = dailyStats.dayKeyOf(new Date(new Date(lastTreatment.at).getTime() + MIN_INTERVAL_DAYS * DAY_MS));
        } else {
            action = 'treat_now';
            date = today;
        }
    } else if (wave && wave.inDays <= WAVE_WINDOW_DAYS) {
        action = 'bait_before_wave';
        const lead = dailyStats.addDays(wave.date, -WAVE_LEAD_DAYS);
        date = lead > today ? lead : today;
    } else if (outlook && outlook.level !== 'low') {
        action = 'sanitation';
        date = today;
    }
    let rainMoved = false;
    if (date && (action === 'treat_now' || action === 'bait_before_wave')) {
        const dry = dryDay(date, outlook?.days);
        date = dry.day;
        rainMoved = dry.moved;
    }
    // The same active ingredient twice in a row: change it next time
    const [last, previous] = sprays;
    const repeated = last && previous && last.activeIngredient && fold(last.activeIngredient) === fold(previous.activeIngredient);
    const rotateFrom = repeated && (action === 'treat_now' || action === 'wait_check') ? last.activeIngredient : null;
    return { action, date, waitUntil, rainMoved, rotateFrom };
}

/** Suggestions for every plot (and farm without plots) the user sees, the most urgent first. */
async function planFor(user, now = new Date()) {
    const withRoles = user.orgRoles ? user : { _id: user._id, id: user.id, role: user.role, demoSerials: user.demoSerials, demoOrgId: user.demoOrgId, orgRoles: await orgRolesOf(user) };
    const [farms, cameras] = await Promise.all([
        Farm.find(farmService.farmViewFilter(withRoles)).select('name').lean(),
        viewableCameras(user).select('deviceSerial deviceName farmId plotId latitude longitude trapKind alertThreshold').lean()
    ]);
    const farmIds = new Set(farms.map(f => String(f._id)));
    const placed = cameras.filter(c => c.farmId && farmIds.has(String(c.farmId)));
    if (!placed.length) return { items: [] };
    const serials = placed.map(c => c.deviceSerial);
    const today = dailyStats.dayKeyOf(now);

    const [plots, latest, { dayKeys, cameras: catches }, treatments] = await Promise.all([
        Plot.find({ farmId: { $in: farms.map(f => f._id) } }).select('farmId name').lean(),
        latestProcessedByCamera(serials),
        catchStats.catchesBySerial(serials, 7, now),
        Treatment.find({ cameraSerials: { $in: serials }, at: { $gte: new Date(now.getTime() - HISTORY_DAYS * DAY_MS), $lte: now } })
            .sort({ at: -1 }).select('at type product activeIngredient cameraSerials').lean()
    ]);
    for (const row of latest.values()) row.count = countPests(row.summary instanceof Map ? Object.fromEntries(row.summary) : (row.summary || {}));
    const judged = await judgedCounts(placed, latest, now);

    // The fly generations and the weather, once per farm, all farms at once (the weather is cached)
    const models = new Map();
    await Promise.all(farms.map(async (farm) => {
        const own = placed.filter(c => String(c.farmId) === String(farm._id));
        if (!own.length) return;
        models.set(String(farm._id), await degreeDayService.forCameras(own, now).catch(() => null));
    }));

    const groups = new Map();
    for (const cam of placed) {
        const key = cam.plotId ? `plot:${cam.plotId}` : `farm:${cam.farmId}`;
        if (!groups.has(key)) groups.set(key, { farmId: String(cam.farmId), plotId: cam.plotId ? String(cam.plotId) : null, cameras: [] });
        groups.get(key).cameras.push(cam);
    }

    const items = [...groups.values()].map(group => {
        const farm = farms.find(f => String(f._id) === group.farmId);
        const plot = group.plotId ? plots.find(p => String(p._id) === group.plotId) : null;
        const own = group.cameras.map(c => c.deviceSerial);
        const theirs = treatments.filter(t => t.cameraSerials.some(s => own.includes(s)));
        const sprays = theirs.filter(t => t.type === 'spray');
        const atThreshold = group.cameras.filter(c => (judged.get(c.deviceSerial)?.value || 0) >= thresholdOf(c)).length;
        const model = models.get(group.farmId);
        const wave = model?.nextWave || null;
        const plan = suggest({ atThreshold, lastTreatment: theirs[0], sprays, wave, outlook: model?.outlook, today, now });
        return {
            farm: farm?.name || '',
            plot: plot?.name || null,
            traps: own.length,
            serials: own,
            atThreshold,
            ftd7: catchStats.ftdOver(own, catches, dayKeys).ftd,
            lastTreatment: theirs[0] ? { at: theirs[0].at, type: theirs[0].type, product: theirs[0].product || null } : null,
            wave: wave ? { date: wave.date, inDays: wave.inDays } : null,
            outlook: model?.outlook?.level || null,
            ...plan
        };
    }).sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action) || (b.atThreshold - a.atThreshold) || ((b.ftd7 ?? -1) - (a.ftd7 ?? -1)));
    return { today, items };
}

module.exports = {
    ORDER,
    suggest,
    planFor
};
