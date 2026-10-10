const mongoose = require('mongoose');

const snapshotSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true, index: true },
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
    }
});

const Snapshot = mongoose.model('Snapshot', snapshotSchema);

module.exports = Snapshot;
