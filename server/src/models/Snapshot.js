const mongoose = require('mongoose');
const { NON_PEST_LABELS } = require('../constants/species');

// Pests in a summary (people, vehicles, animals do not count); same as notificationService.countPests
function pestCountOf(summary) {
    if (!summary) return 0;
    const entries = summary instanceof Map ? [...summary.entries()] : Object.entries(summary);
    return entries
        .filter(([label]) => !NON_PEST_LABELS.includes(String(label).toLowerCase()))
        .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
}

const snapshotSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true },
    imageUrl: { type: String, required: true },
    s3Key: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    aiProcessed: { type: Boolean, default: false },
    aiProvider: { type: String, default: 'vertex' },
    aiResults: {
        detected: { type: Boolean, default: false },
        insects: [{
            name: String,
            confidence: Number,
            // Bounding box coordinates [xmin, ymin, xmax, ymax] (0-10000 normalized or pixel)
            bbox: [Number]
        }],
        summary: { type: Map, of: Number }, // Statistics summary: { "caterpillar": 2, "fruit fly": 1 }
        raw_description: String,
        // FlyBot Sentinel's own analysis (POST /api/sentinel/analysis): counts, boxes, quality,
        // evidence. Kept beside the production result; it sets the summary only when
        // AI_PROVIDER=sentinel.
        sentinel: { type: mongoose.Schema.Types.Mixed, default: undefined }
    },
    // What took the photo, when it was not the schedule or a person: 'sentinel' = an extra
    // capture FlyBot Sentinel asked for (POST /api/sentinel/capture or an approved proposal);
    // 'schedule' | 'rpc' | 'boot' = what a CamOS camera said when it uploaded the photo
    trigger: { type: String, enum: ['sentinel', 'schedule', 'rpc', 'boot'], default: undefined },
    // What a CamOS camera sent with the photo (POST /api/device/snapshot `meta`): battery,
    // network, signal, location, firmware
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // The vision Lambda's answer (AI_PROVIDER=opencv-lambda, services/visionLambda.js,
    // flybot-aws docs/CONTRACTS.md section 1), stored as received: counts go to
    // aiResults.summary and boxes (in pixels) to aiResults.insects like every other provider
    lambda: {
        status: { type: String, enum: ['ok', 'failed'], default: undefined },
        error: { type: mongoose.Schema.Types.Mixed, default: undefined },
        attempts: { type: Number, default: undefined },
        analyzedAt: { type: Date, default: undefined },
        traceId: { type: String, default: undefined },
        model: { type: mongoose.Schema.Types.Mixed, default: undefined },
        counts: { type: mongoose.Schema.Types.Mixed, default: undefined },
        boxes: { type: mongoose.Schema.Types.Mixed, default: undefined }, // normalised, as sent
        quality: { type: mongoose.Schema.Types.Mixed, default: undefined },
        diff: { type: mongoose.Schema.Types.Mixed, default: undefined },
        density: { type: mongoose.Schema.Types.Mixed, default: undefined },
        proposals: { type: mongoose.Schema.Types.Mixed, default: undefined },
        trace: { type: mongoose.Schema.Types.Mixed, default: undefined },
        evidence: { type: mongoose.Schema.Types.Mixed, default: undefined },
        timings: { type: mongoose.Schema.Types.Mixed, default: undefined },
        width: { type: Number, default: undefined },
        height: { type: Number, default: undefined },
        // Deep-analysis questions asked through the chatbot (last few)
        deep: { type: [mongoose.Schema.Types.Mixed], default: undefined }
    },
    // Pest total of aiResults.summary, kept in step with it, so filters by count (alarm status)
    // need not add up the summary of every photo. Older photos get it in the background after start-up.
    pestCount: { type: Number, default: undefined },
    // Later attempts at the AI analysis after the one at capture failed (cron/captureJob.js)
    aiRetries: { type: Number, default: undefined },
    // Photo quality (services/imageQuality.js): measurements and the problems found
    quality: {
        brightness: { type: Number, default: undefined },
        contrast: { type: Number, default: undefined },
        sharpness: { type: Number, default: undefined },
        clipped: { type: Number, default: undefined },
        coverage: { type: Number, default: undefined },
        issues: { type: [String], default: undefined },
        checkedAt: { type: Date, default: undefined }
    },
    // Upload of the reviewed photo to the Roboflow training project (services/trainingSync.js)
    trainingSync: {
        status: { type: String, enum: ['pending', 'uploaded', 'failed'], default: undefined },
        imageId: { type: String, default: undefined },
        attempts: { type: Number, default: undefined },
        error: { type: String, default: undefined },
        uploadedAt: { type: Date, default: undefined }
    },
    // Human review of the AI result. When counts are corrected, aiResults.summary holds the
    // corrected counts (so every statistic uses them) and originalSummary keeps the model output
    // for retraining.
    review: {
        status: { type: String, enum: ['confirmed', 'corrected'], default: undefined },
        originalSummary: { type: Map, of: Number, default: undefined },
        note: { type: String, default: undefined },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
        reviewedAt: { type: Date, default: undefined },
        // FlyBot Sentinel asked a person to check this photo (POST /api/sentinel/review-request)
        requested: {
            type: new mongoose.Schema({
                at: { type: Date, required: true },
                reason: { type: String, default: '' },
                by: { type: String, default: 'sentinel' },
                // Links Sentinel sent with the request (its crops, the photo it looked at): https only
                evidence: { type: [String], default: undefined }
            }, { _id: false }),
            default: undefined
        }
    }
});

// Statistics, history and "latest snapshot per camera" all filter by camera + processed flag
// and sort/range on time
snapshotSchema.index({ deviceSerial: 1, aiProcessed: 1, createdAt: -1 });
// Latest snapshot per camera regardless of AI state (camera health)
snapshotSchema.index({ deviceSerial: 1, createdAt: -1 });
// Review export: only reviewed snapshots have these fields
snapshotSchema.index({ 'review.status': 1, 'review.reviewedAt': -1 }, { sparse: true });
// Training upload queue
snapshotSchema.index({ 'trainingSync.status': 1 }, { sparse: true });
// History filtered by alarm status: count range per camera
snapshotSchema.index({ deviceSerial: 1, pestCount: 1, createdAt: -1 });

snapshotSchema.pre('save', function keepPestCount() {
    if (this.isNew || this.isModified('aiResults')) {
        this.pestCount = this.aiProcessed || this.aiResults?.summary ? pestCountOf(this.aiResults?.summary) : undefined;
    }
});
// Retention cleanup scans by age only
snapshotSchema.index({ createdAt: 1 });
// Sentinel console: traces by id, and the latest traces
snapshotSchema.index({ 'lambda.traceId': 1 }, { sparse: true });

const Snapshot = mongoose.model('Snapshot', snapshotSchema);

module.exports = Snapshot;
module.exports.pestCountOf = pestCountOf;
