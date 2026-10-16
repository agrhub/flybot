const mongoose = require('mongoose');

const NOTIFICATION_TYPES = ['pest_threshold', 'camera_offline', 'camera_online', 'ai_failure', 'camera_shared', 'dashboard_shared', 'card_due', 'card_change_detected', 'plot_threshold', 'farm_shared', 'pest_surge', 'weekly_report', 'image_quality', 'org_joined', 'harvest_ready', 'weather_risk', 'log_reminder', 'org_digest', 'review_requested', 'upgrade_requested', 'upgrade_decided'];
const RETENTION_DAYS = 90;

/**
 * In-app notification. Display text is not stored: the client renders
 * `notifications.types.<type>` from its i18n files using `params`.
 */
const notificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    deviceSerial: { type: String, default: '' },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: { expires: RETENTION_DAYS * 24 * 60 * 60 } }
});

// Listing a user's feed, and the cooldown lookup (same user + type + camera)
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1, deviceSerial: 1, createdAt: -1 });
// Unread badge count
notificationSchema.index({ userId: 1, read: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
