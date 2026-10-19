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
    demoViewSince: { type: Date, default: undefined },
    demoViewLive: { type: Boolean, default: undefined },
    demoViewSimulated: { type: Boolean, default: undefined },
    // The simulated demo farm's daily simulation (services/demoSim.js)
    demoSimEnabled: { type: Boolean, default: undefined },
    demoSimUntil: { type: Date, default: undefined },
    // Names of one-time data migrations already applied (services/migrations.js)
    migrations: { type: [String], default: undefined },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    updatedAt: { type: Date, default: Date.now }
});

const SystemSetting = mongoose.model('SystemSetting', systemSettingSchema);

module.exports = SystemSetting;
