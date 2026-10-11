const { Snapshot } = require('../../models');
const { viewableCameras } = require('../../utils/ownership');
const dailyStats = require('../../services/dailyStats');
const catchStats = require('../../services/catchStats');
const { latestProcessedByCamera } = require('../../services/snapshotQueries');
const { countPests } = require('../../services/notificationService');
const { thresholdOf, riskLevel } = require('../../constants/risk');
const { trapKindOf } = require('../../constants/trap');

const getInsectStatisticsDeclaration = {
    name: 'get_insect_statistics',
    description: 'Query insect pest statistics grouped by hour, day, or month. Supports filtering by a single camera or all cameras.',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number (or "all" for aggregate across all cameras)'
            },
            mode: {
                type: 'STRING',
                description: 'Timeframe group: "hour" (past 24h), "day" (past 30 days), "month" (past 12 months)'
            }
        }
    }
};

async function executeGetInsectStatistics({ deviceSerial, mode = 'day', userId, user }) {
    try {
        let startDate = new Date();
        let groupBy = {};

        if (mode === 'hour') {
            startDate.setHours(startDate.getHours() - 24);
            groupBy = { $dateToString: { format: "%H:00", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } };
        } else if (mode === 'month') {
            startDate.setFullYear(startDate.getFullYear() - 1);
            groupBy = { $dateToString: { format: "%m/%Y", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } };
        } else {
            startDate.setDate(startDate.getDate() - 30);
            groupBy = { $dateToString: { format: "%d/%m", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } };
        }

        if (!userId) return { error: 'Not authenticated.' };
        const userCams = await viewableCameras(user).select('deviceSerial');
        const allowedSerials = userCams.map(c => c.deviceSerial);

        const matchQuery = {
            createdAt: { $gte: startDate },
            aiProcessed: true
        };

        if (deviceSerial && deviceSerial !== 'all') {
            if (!allowedSerials.includes(deviceSerial)) {
                return { error: `You do not have permission to access camera ${deviceSerial}.` };
            }
            matchQuery.deviceSerial = deviceSerial;
        } else if (allowedSerials.length > 0) {
            matchQuery.deviceSerial = { $in: allowedSerials };
        } else if (userId) {
            return { mode, deviceSerial: 'all', periodsCount: 0, records: [] };
        }

        if (mode !== 'hour') {
            const serials = typeof matchQuery.deviceSerial === 'string' ? [matchQuery.deviceSerial] : matchQuery.deviceSerial.$in;
            const rollup = await dailyStats.rows(serials, dailyStats.dayKeyOf(startDate));
            const records = dailyStats.speciesSeries(rollup, mode === 'month' ? 'month' : 'day')
                .map(p => ({ _id: p._id, insects: p.insects }));
            return { mode, deviceSerial: deviceSerial || 'all', periodsCount: records.length, records };
        }

        const data = await Snapshot.aggregate([
            { $match: matchQuery },
            {
                $project: {
                    createdAt: 1,
                    summaryArray: { $objectToArray: "$aiResults.summary" }
                }
            },
            { $unwind: "$summaryArray" },
            {
                $group: {
                    _id: { time: groupBy, insect: "$summaryArray.k" },
                    count: { $sum: "$summaryArray.v" }
                }
            },
            {
                $group: {
                    _id: "$_id.time",
                    insects: { $push: { label: "$_id.insect", value: "$count" } }
                }
            },
            { $sort: { "_id": 1 } }
        ]);

        return {
            mode,
            deviceSerial: deviceSerial || 'all',
            periodsCount: data.length,
            records: data
        };
    } catch (err) {
        return { error: err.message };
    }
}

const getRecentSnapshotsDeclaration = {
    name: 'get_recent_snapshots',
    description: 'Retrieve the most recent trap snapshots with AI detection results (species, count, timestamp).',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number or "all"'
            },
            limit: {
                type: 'NUMBER',
                description: 'Number of snapshots to fetch (default: 6)'
            }
        }
    }
};

async function executeGetRecentSnapshots({ deviceSerial, limit = 6, userId, user }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const userCams = await viewableCameras(user).select('deviceSerial');
        const allowedSerials = userCams.map(c => c.deviceSerial);

        const query = { aiProcessed: true };
        if (deviceSerial && deviceSerial !== 'all') {
            if (!allowedSerials.includes(deviceSerial)) {
                return { error: `You do not have permission to access camera ${deviceSerial}.` };
            }
            query.deviceSerial = deviceSerial;
        } else if (allowedSerials.length > 0) {
            query.deviceSerial = { $in: allowedSerials };
        } else if (userId) {
            return { totalReturned: 0, snapshots: [] };
        }

        const snapshots = await Snapshot.find(query)
            .sort({ createdAt: -1 })
            .limit(Math.min(limit, 20));

        return {
            totalReturned: snapshots.length,
            snapshots: snapshots.map(s => ({
                id: s._id,
                deviceSerial: s.deviceSerial,
                createdAt: s.createdAt,
                summary: s.aiResults?.summary || {},
                totalDetected: Object.values(s.aiResults?.summary || {}).reduce((a, b) => a + b, 0)
            }))
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
        const userCams = await viewableCameras(user).select('deviceSerial');
        const allowedSerials = userCams.map(c => c.deviceSerial);

        const baseMatch = { aiProcessed: true };
        if (allowedSerials.length > 0) {
            baseMatch.deviceSerial = { $in: allowedSerials };
        } else if (userId) {
            return { totalSnapshots: 0, last24hCount: 0, totalInsects: 0, topSpecies: 'No data', speciesDistribution: [] };
        }

        const totalSnapshots = await Snapshot.countDocuments(baseMatch);
        const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const last24hCount = await Snapshot.countDocuments({
            ...baseMatch,
            createdAt: { $gte: last24h }
        });

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
    description: 'Per-trap pest pressure: count on the trap now vs its alert threshold, insects caught today and over 7 days, flies per trap per day (FTD) and the change vs the previous 7 days, plus the farm totals. Use it for "how bad is it", "which trap is worst", "is it rising".',
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
        const traps = unique.map(cam => {
            const snap = latest.get(cam.deviceSerial);
            const onTrap = snap ? countPests(snap.summary instanceof Map ? Object.fromEntries(snap.summary) : snap.summary) : 0;
            const c = catches.perCamera[cam.deviceSerial] || {};
            return {
                name: cam.deviceName || cam.deviceSerial,
                serial: cam.deviceSerial,
                trapKind: trapKindOf(cam),
                online: cam.status === 1,
                onTrapNow: onTrap,
                alertThreshold: thresholdOf(cam),
                risk: riskLevel(onTrap, thresholdOf(cam)),
                caughtToday: c.today ?? null,
                caughtLast7Days: c.last7 ?? null,
                fliesPerTrapPerDay7: c.ftd7 ?? null,
                changeVsPrevious7DaysPct: c.changePct ?? null,
                cardAgeDays: cam.cardReplacedAt ? Math.floor((Date.now() - new Date(cam.cardReplacedAt).getTime()) / 86400000) : null
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
            notes: 'sticky = glue card, counts accumulate until the card is replaced; lure = no glue, a photo shows the flies present at that moment (daily figure = average per photo). Alert thresholds compare the count in the latest photo.'
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
