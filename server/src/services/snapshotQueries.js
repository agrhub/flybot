const { Snapshot } = require('../models');

/**
 * "Latest snapshot of each camera" queries.
 *
 * Sorting on the index order (deviceSerial, aiProcessed, createdAt) with only $first in the
 * $group lets MongoDB use a DISTINCT_SCAN: one index seek per camera instead of reading
 * every snapshot in the retention window. Keep the $sort keys in index order.
 */

/**
 * Latest AI-processed snapshot per camera.
 * Returns Map(deviceSerial -> { snapshotId, createdAt, s3Key, imageUrl, summary, insects }).
 */
const latestProcessedPipeline = (serials) => [
    { $match: { deviceSerial: { $in: serials }, aiProcessed: true } },
    { $sort: { deviceSerial: 1, aiProcessed: 1, createdAt: -1 } },
    {
        $group: {
            _id: '$deviceSerial',
            snapshotId: { $first: '$_id' },
            createdAt: { $first: '$createdAt' },
            s3Key: { $first: '$s3Key' },
            imageUrl: { $first: '$imageUrl' },
            summary: { $first: '$aiResults.summary' },
            insects: { $first: '$aiResults.insects' }
        }
    }
];

async function latestProcessedByCamera(serials) {
    if (!serials.length) return new Map();
    const rows = await Snapshot.aggregate(latestProcessedPipeline(serials));
    return new Map(rows.map(r => [r._id, r]));
}

/**
 * Time of the latest snapshot per camera, processed or not (index: deviceSerial, createdAt).
 * Returns Map(deviceSerial -> Date).
 */
const latestTimePipeline = (serials) => [
    { $match: { deviceSerial: { $in: serials } } },
    { $sort: { deviceSerial: 1, createdAt: -1 } },
    { $group: { _id: '$deviceSerial', createdAt: { $first: '$createdAt' } } }
];

async function latestSnapshotTimeByCamera(serials) {
    if (!serials.length) return new Map();
    const rows = await Snapshot.aggregate(latestTimePipeline(serials));
    return new Map(rows.map(r => [r._id, r.createdAt]));
}

module.exports = {
    latestProcessedPipeline,
    latestTimePipeline,
    latestProcessedByCamera,
    latestSnapshotTimeByCamera
};
