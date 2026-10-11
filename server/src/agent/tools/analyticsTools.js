const { Snapshot } = require('../../models');
const { viewableCameras } = require('../../utils/ownership');
const dailyStats = require('../../services/dailyStats');
const catchStats = require('../../services/catchStats');
const { latestProcessedByCamera } = require('../../services/snapshotQueries');
const { judgedCounts } = require('../../services/dashboardService');
const { countPests } = require('../../services/notificationService');
const { thresholdOf, riskLevel } = require('../../constants/risk');
const { trapKindOf } = require('../../constants/trap');

const HOUR_MS = 60 * 60 * 1000;
// Farm time (Asia/Ho_Chi_Minh): UTC+7 all year
const FARM_OFFSET_MS = 7 * HOUR_MS;
const round1 = (n) => Math.round(n * 10) / 10;
const plain = (summary) => (summary instanceof Map ? Object.fromEntries(summary) : (summary || {}));

async function cameraNames(serials) {
    const { Camera } = require('../../models');
    const cams = await Camera.find({ deviceSerial: { $in: [...new Set(serials)] } }).select('deviceSerial deviceName').lean();
    return new Map(cams.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
}

/**
 * Cameras this user may see, narrowed to one when `deviceSerial` names one.
 * Returns { serials } or { error }.
 */
async function serialsFor(user, deviceSerial) {
    const cams = await viewableCameras(user).select('deviceSerial').lean();
    const allowed = [...new Set(cams.map(c => c.deviceSerial))];
    if (deviceSerial && deviceSerial !== 'all') {
        if (!allowed.includes(deviceSerial)) return { error: `You do not have permission to access camera ${deviceSerial}.` };
        return { serials: [deviceSerial] };
    }
    return { serials: allowed };
}

const getInsectStatisticsDeclaration = {
    name: 'get_insect_statistics',
    description: 'Insects caught (new arrivals on the traps, pests only) per hour over the last 24 hours, per day over the last 30 days, or per month over the last 12 months, by species. For one camera or all cameras.',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number (or "all" for aggregate across all cameras)'
            },
            mode: {
                type: 'STRING',
                enum: ['hour', 'day', 'month'],
                description: 'Timeframe group: "hour" (past 24h), "day" (past 30 days), "month" (past 12 months)'
            }
        }
    }
};

async function executeGetInsectStatistics({ deviceSerial, mode = 'day', userId, user, addCard = () => {} }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const scope = await serialsFor(user, deviceSerial);
        if (scope.error) return scope;
        const { serials } = scope;
        if (!serials.length) return { mode, deviceSerial: deviceSerial || 'all', records: [] };
        const now = new Date();

        if (mode === 'hour') {
            // Rise between consecutive photos of a sticky card; flies present on average for lure traps
            const activity = await catchStats.activityByHour(serials, 2, now);
            const records = [];
            for (let i = 23; i >= 0; i--) {
                const local = new Date(now.getTime() - i * HOUR_MS + FARM_OFFSET_MS);
                const day = local.toISOString().slice(0, 10);
                const hour = local.getUTCHours();
                const d = activity.days.indexOf(day);
                const h = activity.hours.indexOf(hour);
                records.push({ day, hour: `${String(hour).padStart(2, '0')}:00`, caught: d >= 0 && h >= 0 ? round1(activity.cells[d][h]) : 0 });
            }
            addCard({ type: 'chart', mode: 'hour', deviceSerial: deviceSerial || 'all', labels: records.map(r => r.hour), series: [{ label: null, data: records.map(r => r.caught) }] });
            return {
                mode,
                deviceSerial: deviceSerial || 'all',
                unit: 'insects caught per hour, local time (all species)',
                records
            };
        }

        const data = await catchStats.catchesBySerial(serials, mode === 'month' ? 365 : 30, now);
        const records = catchStats.speciesCatchSeries(data, mode === 'month' ? 'month' : 'day')
            .map(p => ({ period: p._id, insects: p.insects.map(i => ({ label: i.label, caught: round1(i.value) })) }));
        // Chart card: the main species, stacked per period
        const totals = new Map();
        for (const r of records) for (const i of r.insects) totals.set(i.label, (totals.get(i.label) || 0) + i.caught);
        const species = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label]) => label);
        if (records.length) {
            addCard({
                type: 'chart',
                mode: mode === 'month' ? 'month' : 'day',
                deviceSerial: deviceSerial || 'all',
                labels: records.map(r => r.period),
                series: species.map(label => ({ label, data: records.map(r => r.insects.find(i => i.label === label)?.caught ?? 0) }))
            });
        }
        return {
            mode: mode === 'month' ? 'month' : 'day',
            deviceSerial: deviceSerial || 'all',
            unit: 'insects caught (new arrivals) per period, by species; periods without data are left out',
            records
        };
    } catch (err) {
        return { error: err.message };
    }
}

const getRecentSnapshotsDeclaration = {
    name: 'get_recent_snapshots',
    description: 'Retrieve the most recent trap photos with AI detection results (pest count on the trap, species, timestamp).',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number or "all"'
            },
            limit: {
                type: 'NUMBER',
                description: 'Number of snapshots to fetch (default: 6, at most 20)'
            }
        }
    }
};

async function executeGetRecentSnapshots({ deviceSerial, limit = 6, userId, user, addCard = () => {} }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const scope = await serialsFor(user, deviceSerial);
        if (scope.error) return scope;
        if (!scope.serials.length) return { totalReturned: 0, snapshots: [] };

        const snapshots = await Snapshot.find({ aiProcessed: true, deviceSerial: { $in: scope.serials } })
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(Number(limit) || 6, 20)))
            .select('deviceSerial createdAt pestCount aiResults.summary review.status s3Key')
            .lean();
        const names = await cameraNames(snapshots.map(s => s.deviceSerial));
        if (snapshots.length) {
            addCard({
                type: 'photos',
                items: snapshots.slice(0, 4).map(s => ({
                    id: String(s._id),
                    deviceSerial: s.deviceSerial,
                    name: names.get(s.deviceSerial) || s.deviceSerial,
                    at: s.createdAt,
                    count: s.pestCount ?? countPests(plain(s.aiResults?.summary)),
                    imageKey: s.s3Key
                }))
            });
        }

        return {
            totalReturned: snapshots.length,
            snapshots: snapshots.map(s => {
                const summary = plain(s.aiResults?.summary);
                return {
                    id: s._id,
                    deviceSerial: s.deviceSerial,
                    createdAt: s.createdAt,
                    // Pests on the trap in this photo (people, vehicles and animals excluded)
                    pestsOnTrap: s.pestCount ?? countPests(summary),
                    bySpecies: summary,
                    reviewed: s.review?.status || null
                };
            })
        };
    } catch (err) {
        return { error: err.message };
    }
}

const getOverviewMetricsDeclaration = {
    name: 'get_overview_metrics',
    description: 'Retrieve overview metrics of the FlyBot system: total snapshots, last 24h count, and insects and top species over the last 30 days.',
    parameters: {
        type: 'OBJECT',
        properties: {}
    }
};

async function executeGetOverviewMetrics({ userId, user }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const { serials: allowedSerials } = await serialsFor(user);
        if (!allowedSerials.length) {
            return { totalSnapshots: 0, last24hCount: 0, insectsCaughtLast30Days: 0, topSpecies: 'No data', speciesShare: [] };
        }
        const baseMatch = { aiProcessed: true, deviceSerial: { $in: allowedSerials } };

        const totalSnapshots = await Snapshot.countDocuments(baseMatch);
        const last24hCount = await Snapshot.countDocuments({ ...baseMatch, createdAt: { $gte: new Date(Date.now() - 24 * HOUR_MS) } });

        const rollup = await dailyStats.rows(allowedSerials, dailyStats.startKeyForDays(30));
        const speciesAgg = dailyStats.speciesTotals(rollup, 'total').map(sp => ({ _id: sp.name, total: sp.value }));
        const catches = await catchStats.overview(allowedSerials);

        return {
            totalSnapshots,
            last24hCount,
            // Insects that arrived on the traps (daily rise of sticky cards; flies present on average for lure traps)
            insectsCaughtLast30Days: catches.periods.month.total,
            insectsCaughtLast7Days: catches.last7,
            fliesPerTrapPerDayLast7Days: catches.ftd7,
            topSpecies: speciesAgg.length > 0 ? speciesAgg[0]._id : 'Unknown',
            speciesPeriod: 'last 30 days',
            // Share of each species among detections (relative only)
            speciesShare: speciesAgg.map(s => ({ species: s._id, sharePct: Math.round((s.total / (speciesAgg.reduce((a, b) => a + b.total, 0) || 1)) * 100) }))
        };
    } catch (err) {
        return { error: err.message };
    }
}

const getCatchSummaryDeclaration = {
    name: 'get_catch_summary',
    description: 'Per-trap pest pressure: the value judged against the alert threshold (latest photo on a sticky trap, today\'s average per photo on a lure trap), insects caught today and over 7 days, flies per trap per day (FTD) and the change vs the previous 7 days, plus the farm totals. Use it for "how bad is it", "which trap is worst", "is it rising".',
    parameters: { type: 'OBJECT', properties: {} }
};

async function executeGetCatchSummary({ userId, user }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const cams = await viewableCameras(user).select('deviceSerial deviceName status alertThreshold trapKind cardReplacedAt').lean();
        const unique = [...new Map(cams.map(c => [c.deviceSerial, c])).values()];
        if (!unique.length) return { traps: [], note: 'No cameras.' };
        const serials = unique.map(c => c.deviceSerial);
        const [catches, latest] = await Promise.all([catchStats.overview(serials), latestProcessedByCamera(serials)]);
        for (const row of latest.values()) row.count = countPests(plain(row.summary));
        // The same judgement as alerts, the overview and reports
        const judged = await judgedCounts(unique, latest);
        const traps = unique.map(cam => {
            const c = catches.perCamera[cam.deviceSerial] || {};
            const { value, basis } = judged.get(cam.deviceSerial) || { value: 0, basis: 'latest' };
            return {
                name: cam.deviceName || cam.deviceSerial,
                serial: cam.deviceSerial,
                trapKind: trapKindOf(cam),
                online: cam.status === 1,
                onTrapInLatestPhoto: latest.get(cam.deviceSerial)?.count || 0,
                judgedValue: value,
                judgedBy: basis === 'dailyAverage' ? 'today\'s average per photo' : 'latest photo',
                alertThreshold: thresholdOf(cam),
                risk: riskLevel(value, thresholdOf(cam)),
                caughtToday: c.today ?? null,
                caughtLast7Days: c.last7 ?? null,
                fliesPerTrapPerDay7: c.ftd7 ?? null,
                changeVsPrevious7DaysPct: c.changePct ?? null,
                cardAgeDays: trapKindOf(cam) === 'sticky' && cam.cardReplacedAt
                    ? Math.floor((Date.now() - new Date(cam.cardReplacedAt).getTime()) / 86400000)
                    : null
            };
        }).sort((a, b) => (b.fliesPerTrapPerDay7 ?? -1) - (a.fliesPerTrapPerDay7 ?? -1));
        return {
            farm: {
                caughtToday: catches.today,
                caughtYesterday: catches.yesterday,
                caughtLast7Days: catches.last7,
                caughtPrevious7Days: catches.prev7,
                fliesPerTrapPerDay7: catches.ftd7,
                changePct: catches.changePct
            },
            traps,
            notes: 'sticky = glue card, counts accumulate until the card is replaced; lure = no glue, a photo shows the flies present at that moment. risk compares judgedValue with alertThreshold: the latest photo on a sticky trap, today\'s average per photo on a lure trap.'
        };
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    analyticsDeclarations: [
        getCatchSummaryDeclaration,
        getInsectStatisticsDeclaration,
        getRecentSnapshotsDeclaration,
        getOverviewMetricsDeclaration
    ],
    analyticsExecutors: {
        get_catch_summary: executeGetCatchSummary,
        get_insect_statistics: executeGetInsectStatistics,
        get_recent_snapshots: executeGetRecentSnapshots,
        get_overview_metrics: executeGetOverviewMetrics
    }
};
