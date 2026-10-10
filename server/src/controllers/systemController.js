const { Camera, Snapshot } = require('../models');
const { S3_BUCKET, RETENTION_CYCLE, AI_PROVIDER, VERTEX_MODEL } = require('../config/env');
const { sendServerError } = require('../utils/http');

/**
 * GET /api/system/info: real storage and AI settings, plus this user's snapshot usage
 * (replaces the hard-coded values the Settings > Storage tab used to show).
 */
async function getSystemInfo(req, res) {
    try {
        const cameras = await Camera.find({ userId: req.user.id }).select('deviceSerial');
        const serials = [...new Set(cameras.map(c => c.deviceSerial))];

        const [usage] = serials.length
            ? await Snapshot.aggregate([
                { $match: { deviceSerial: { $in: serials } } },
                {
                    $group: {
                        _id: null,
                        snapshots: { $sum: 1 },
                        analyzed: { $sum: { $cond: ['$aiProcessed', 1, 0] } },
                        oldest: { $min: '$createdAt' },
                        newest: { $max: '$createdAt' }
                    }
                }
            ])
            : [];

        const provider = ['vertex', 'roboflow', 'both'].includes(AI_PROVIDER) ? AI_PROVIDER : 'vertex';
        res.json({
            success: true,
            info: {
                storage: {
                    bucket: S3_BUCKET,
                    retentionMonths: RETENTION_CYCLE
                },
                ai: {
                    provider,
                    // Only meaningful for Vertex; Roboflow runs a hosted workflow
                    model: provider === 'roboflow' ? null : VERTEX_MODEL
                },
                usage: {
                    cameras: serials.length,
                    snapshots: usage?.snapshots || 0,
                    analyzed: usage?.analyzed || 0,
                    oldestSnapshotAt: usage?.oldest || null,
                    newestSnapshotAt: usage?.newest || null
                }
            }
        });
    } catch (err) {
        sendServerError(res, err, { context: 'System info' });
    }
}

module.exports = {
    getSystemInfo
};
