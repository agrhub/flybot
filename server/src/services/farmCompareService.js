const { Farm, Plot, Camera, Treatment } = require('../models');
const catchStats = require('./catchStats');

const { ftdOver: ftdOf, ftdChange: change } = catchStats;

/**
 * Farms side by side (and the plots inside each), for a cooperative that follows several
 * growers: flies per trap per day (FTD) over a period against the period before, its daily
 * series, the worst plot and how many treatments were logged. Only cameras the viewer can see
 * count, so a shared farm shows what the viewer has access to.
 */
const PERIODS = [7, 30, 90];
const DEFAULT_PERIOD = 30;

/**
 * @param farms   farms the viewer can see (lean documents)
 * @param visible Set of camera serials the viewer can see
 * @param days    period length (7, 30 or 90)
 */
async function compareFarms(farms, visible, days = DEFAULT_PERIOD, now = new Date()) {
    const period = PERIODS.includes(days) ? days : DEFAULT_PERIOD;
    const farmIds = farms.map(f => f._id);
    const [plots, farmCameras] = await Promise.all([
        Plot.find({ farmId: { $in: farmIds } }).select('farmId name').lean(),
        Camera.find({ farmId: { $in: farmIds } }).select('deviceSerial farmId plotId').lean()
    ]);
    const cameras = farmCameras.filter(c => visible.has(c.deviceSerial));
    const serials = cameras.map(c => c.deviceSerial);

    // This period and the one before, in one pass over the daily rollup
    const { dayKeys, cameras: catches } = serials.length
        ? await catchStats.catchesBySerial(serials, period * 2, now)
        : { dayKeys: [], cameras: new Map() };
    const current = dayKeys.slice(-period);
    const previous = dayKeys.slice(0, dayKeys.length - period);

    const from = new Date(now.getTime() - period * 24 * 60 * 60 * 1000);
    const treatments = serials.length
        ? await Treatment.find({ cameraSerials: { $in: serials }, at: { $gte: from, $lte: now } }).select('cameraSerials at').lean()
        : [];

    const result = farms.map(farm => {
        const own = cameras.filter(c => String(c.farmId) === String(farm._id));
        const ownSerials = own.map(c => c.deviceSerial);
        const cur = ftdOf(ownSerials, catches, current);
        const before = ftdOf(ownSerials, catches, previous);
        const plotRows = plots
            .filter(p => String(p.farmId) === String(farm._id))
            .map(plot => {
                const plotSerials = own.filter(c => String(c.plotId) === String(plot._id)).map(c => c.deviceSerial);
                const a = ftdOf(plotSerials, catches, current);
                const b = ftdOf(plotSerials, catches, previous);
                return { id: String(plot._id), name: plot.name, traps: plotSerials.length, ftd: a.ftd, changePct: change(a.ftd, b.ftd) };
            })
            .filter(p => p.traps > 0)
            .sort((x, y) => (y.ftd ?? -1) - (x.ftd ?? -1));
        const ownSet = new Set(ownSerials);
        const farmTreatments = treatments.filter(t => t.cameraSerials.some(s => ownSet.has(s)));
        return {
            id: String(farm._id),
            name: farm.name,
            traps: ownSerials.length,
            ftd: cur.ftd,
            catches: cur.total,
            previousFtd: before.ftd,
            changePct: change(cur.ftd, before.ftd),
            // FTD per day, for the chart
            series: current.map(day => ftdOf(ownSerials, catches, [day]).ftd),
            worstPlot: plotRows.find(p => p.ftd !== null) || null,
            plots: plotRows,
            treatments: farmTreatments.length,
            lastTreatmentAt: farmTreatments.length ? new Date(Math.max(...farmTreatments.map(t => new Date(t.at).getTime()))) : null
        };
    })
        // Farms with traps first, the most flies per trap on top
        .sort((x, y) => (y.traps > 0) - (x.traps > 0) || (y.ftd ?? -1) - (x.ftd ?? -1) || x.name.localeCompare(y.name));

    return { period, days: current, farms: result };
}

module.exports = {
    PERIODS,
    DEFAULT_PERIOD,
    compareFarms
};
