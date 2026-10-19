const mongoose = require('mongoose');

/**
 * A firmware build for one camera model (services/firmwareService.js). FlyBot keeps the image itself
 * (S3 key) and serves it to the cameras through the device API, so only a camera with an open update
 * can download it. At most one build per model is the current release.
 */
const firmwareSchema = new mongoose.Schema({
    platform: { type: String, enum: ['camos'], default: 'camos' },
    // The model the camera reports (state / register body), e.g. AIC-FREENOVE-S3CAM
    model: { type: String, required: true, trim: true },
    version: { type: String, required: true, trim: true },
    s3Key: { type: String, required: true },
    fileName: { type: String, default: '' },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    source: {
        kind: { type: String, enum: ['upload', 'url', 'github'], default: 'upload' },
        url: { type: String, default: undefined },
        tag: { type: String, default: undefined }
    },
    // Release notes shown to camera owners, per language
    notes: {
        en: { type: String, default: '' },
        vi: { type: String, default: '' }
    },
    // Release channel (services/firmwareChannels.js): alpha (internal test cameras), beta, stable (everyone)
    channel: { type: String, enum: ['alpha', 'beta', 'stable'], default: 'stable' },
    // The current release of its model in its channel (one per model and channel)
    current: { type: Boolean, default: false },
    // A camera on battery installs only above this charge (or when charging / powered)
    minBatteryPct: { type: Number, default: 40, min: 0, max: 100 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    createdAt: { type: Date, default: Date.now }
});

firmwareSchema.index({ model: 1, version: 1 }, { unique: true });
firmwareSchema.index({ model: 1, channel: 1, current: 1 });

const Firmware = mongoose.model('Firmware', firmwareSchema);

module.exports = Firmware;
