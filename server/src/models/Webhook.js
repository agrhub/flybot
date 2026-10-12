const mongoose = require('mongoose');

/**
 * An HTTPS endpoint that receives this user's alerts as signed JSON POSTs
 * (services/webhookService.js).
 */
const WEBHOOK_EVENTS = [
    'pest_threshold',
    'pest_surge',
    'plot_threshold',
    'camera_offline',
    'camera_online',
    'ai_failure',
    'card_due',
    'card_change_detected',
    'image_quality',
    'harvest_ready'
];

const webhookSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    url: { type: String, required: true },
    // HMAC key for the X-FlyBot-Signature header, shown once when created
    secret: { type: String, required: true },
    events: { type: [{ type: String, enum: WEBHOOK_EVENTS }], default: [] },
    active: { type: Boolean, default: true },
    lastDeliveryAt: { type: Date, default: null },
    lastStatus: { type: Number, default: null },
    lastError: { type: String, default: null },
    // Consecutive failed deliveries; the webhook is switched off after too many
    failures: { type: Number, default: 0 }
}, { timestamps: true });

const Webhook = mongoose.model('Webhook', webhookSchema);

module.exports = Webhook;
module.exports.WEBHOOK_EVENTS = WEBHOOK_EVENTS;
