const mongoose = require('mongoose');

/**
 * System-wide settings editable by admins (a single document, key "global").
 * Missing values fall back to the environment (see services/settingsService.js).
 */
const systemSettingSchema = new mongoose.Schema({
    key: { type: String, default: 'global', unique: true },
    allowRegistration: { type: Boolean, default: undefined },
    retentionMonths: { type: Number, min: 1, max: 60, default: undefined },
    defaultAlertThreshold: { type: Number, min: 1, max: 10000, default: undefined },
    // Upload reviewed photos to Roboflow for retraining (services/trainingSync.js)
    trainingSync: { type: Boolean, default: undefined },
    // Read-only demo cameras for visitors (services/demoView.js)
    demoViewEnabled: { type: Boolean, default: undefined },
    demoViewCameras: { type: [String], default: undefined },
    // Each shared camera and what visitors may do with it (services/demoView.js PERMISSIONS)
    demoViewShares: {
        type: [new mongoose.Schema({
            deviceSerial: { type: String, required: true },
            live: { type: Boolean, default: false },
            playback: { type: Boolean, default: false },
            location: { type: Boolean, default: false },
            device: { type: Boolean, default: false },
            realSerial: { type: Boolean, default: false }
        }, { _id: false })],
        default: undefined
    },
    demoViewSince: { type: Date, default: undefined },
    demoViewLive: { type: Boolean, default: undefined },
    demoViewSimulated: { type: Boolean, default: undefined },
    // guest | all | since (services/demoView.js)
    demoViewAudience: { type: String, default: undefined },
    guestAccessEnabled: { type: Boolean, default: undefined },
    // The simulated demo farm's daily simulation (services/demoSim.js)
    demoSimEnabled: { type: Boolean, default: undefined },
    demoSimUntil: { type: Date, default: undefined },
    // Serial registry (services/registryService.js): 'open' checks registered serials only, 'strict' refuses the rest
    registryMode: { type: String, enum: ['open', 'strict'], default: undefined },
    // Names of one-time data migrations already applied (services/migrations.js)
    migrations: { type: [String], default: undefined },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    updatedAt: { type: Date, default: Date.now }
});

const SystemSetting = mongoose.model('SystemSetting', systemSettingSchema);

module.exports = SystemSetting;
