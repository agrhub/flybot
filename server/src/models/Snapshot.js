const mongoose = require('mongoose');

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
        raw_description: String
    },
    // Human review of the AI result. When counts are corrected, aiResults.summary holds the
    // corrected counts (so every statistic uses them) and originalSummary keeps the model output
    // for retraining.
    review: {
        status: { type: String, enum: ['confirmed', 'corrected'], default: undefined },
        originalSummary: { type: Map, of: Number, default: undefined },
        note: { type: String, default: undefined },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
        reviewedAt: { type: Date, default: undefined }
    }
});

// Statistics, history and "latest snapshot per camera" all filter by camera + processed flag
// and sort/range on time
snapshotSchema.index({ deviceSerial: 1, aiProcessed: 1, createdAt: -1 });
// Latest snapshot per camera regardless of AI state (camera health)
snapshotSchema.index({ deviceSerial: 1, createdAt: -1 });
// Review export: only reviewed snapshots have these fields
snapshotSchema.index({ 'review.status': 1, 'review.reviewedAt': -1 }, { sparse: true });
// Retention cleanup scans by age only
snapshotSchema.index({ createdAt: 1 });

const Snapshot = mongoose.model('Snapshot', snapshotSchema);

module.exports = Snapshot;
