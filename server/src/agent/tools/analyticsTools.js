const { Snapshot } = require('../../models');
const { viewableCameras } = require('../../utils/ownership');

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
    description: 'Retrieve real-time overview metrics of the FlyBot system: total insects, total snapshots, last 24h count, and top species.',
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

        const speciesAgg = await Snapshot.aggregate([
            { $match: baseMatch },
            { $project: { summaryArray: { $objectToArray: "$aiResults.summary" } } },
            { $unwind: "$summaryArray" },
            { $group: { _id: "$summaryArray.k", total: { $sum: "$summaryArray.v" } } },
            { $sort: { total: -1 } }
        ]);

        let totalInsects = 0;
        speciesAgg.forEach(s => totalInsects += s.total);

        return {
            totalSnapshots,
            last24hCount,
            totalInsects,
            topSpecies: speciesAgg.length > 0 ? speciesAgg[0]._id : 'Unknown',
            speciesDistribution: speciesAgg.map(s => ({ species: s._id, count: s.total }))
        };
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    analyticsDeclarations: [
        getInsectStatisticsDeclaration,
        getRecentSnapshotsDeclaration,
        getOverviewMetricsDeclaration
    ],
    analyticsExecutors: {
        get_insect_statistics: executeGetInsectStatistics,
        get_recent_snapshots: executeGetRecentSnapshots,
        get_overview_metrics: executeGetOverviewMetrics
    }
};
