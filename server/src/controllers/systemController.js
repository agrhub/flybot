const { Camera, Snapshot } = require('../models');
const { S3_BUCKET, VERTEX_MODEL, CLAUDE_VISION_MODEL, TELEGRAM_BOT_USERNAME } = require('../config/env');
const { providerChain } = require('../services/aiService');
const { getSettings } = require('../services/settingsService');
const telegramService = require('../services/telegramService');
const { sendServerError } = require('../utils/http');
const { viewableCameras } = require('../utils/ownership');
const { createTtlCache } = require('../utils/ttlCache');
const sentinelUi = require('../services/sentinelUiService');

/**
 * GET /api/system/info: real storage and AI settings, plus this user's snapshot usage
 * (replaces the hard-coded values the Settings > Storage tab used to show).
 */
// Counting every snapshot is slow on a big history and the numbers change slowly
const usageCache = createTtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 1000 });
const modelCache = createTtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 1 });

/** The OpenCV Lambda's detector as its latest answer named it ("yolo26n 2026-10-16 · opencv-5.0.0-dnn-new"), or null */
async function visionModelName() {
    const cached = modelCache.get('model');
    if (cached !== undefined) return cached;
    const snap = await Snapshot.findOne({ 'lambda.model.name': { $exists: true } }).sort({ createdAt: -1 }).select('lambda.model').lean();
    const m = snap?.lambda?.model;
    const name = m ? [[m.name, m.version].filter(Boolean).join(' '), m.engine].filter(Boolean).join(' · ') : null;
    if (name) modelCache.set('model', name); // nothing analyzed yet: ask again next time
    return name;
}

async function getSystemInfo(req, res) {
    try {
        const cameras = await viewableCameras(req.user).select('deviceSerial');
        const serials = [...new Set(cameras.map(c => c.deviceSerial))].sort();

        const [usage] = serials.length
            ? await usageCache.wrap(serials.join(','), () => Snapshot.aggregate([
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
            ]))
            : [];

        // The first model counts the photos; the others take over when it fails
        const [provider, ...fallbacks] = providerChain();
        res.json({
            success: true,
            info: {
                storage: {
                    bucket: S3_BUCKET,
                    retentionMonths: (await getSettings()).retentionMonths
                },
                ai: {
                    provider,
                    fallbacks,
                    // The detector for the OpenCV Lambda (from its latest answer), the Gemini or Claude model; Roboflow runs a hosted workflow
                    model: provider === 'opencv-lambda' ? await visionModelName() : provider === 'claude' ? CLAUDE_VISION_MODEL : provider === 'roboflow' || provider === 'sentinel' ? null : VERTEX_MODEL
                },
                // Lets the client show or hide the Telegram option
                telegram: {
                    enabled: telegramService.isEnabled(),
                    botUsername: telegramService.isEnabled() ? TELEGRAM_BOT_USERNAME : null
                },
                // Sentinel console for this person (same values as /api/auth/me)
                sentinel: (({ sentinelEnabled, sentinelCanDecide }) => ({ enabled: sentinelEnabled, canDecide: sentinelCanDecide }))(sentinelUi.accessFor(req.user)),
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
