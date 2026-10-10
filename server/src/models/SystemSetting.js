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
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    updatedAt: { type: Date, default: Date.now }
});

const SystemSetting = mongoose.model('SystemSetting', systemSettingSchema);

module.exports = SystemSetting;
