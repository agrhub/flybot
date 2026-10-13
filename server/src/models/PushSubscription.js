const mongoose = require('mongoose');

/**
 * One browser / installed app that receives push notifications for a user.
 * A device belongs to one account at a time: subscribing again from the same
 * browser (same endpoint) moves it to the account that is signed in.
 */
const pushSubscriptionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
        p256dh: { type: String, required: true },
        auth: { type: String, required: true }
    },
    userAgent: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    lastSuccessAt: { type: Date, default: null }
});

const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

module.exports = PushSubscription;
