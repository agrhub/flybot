const mongoose = require('mongoose');

/**
 * One charge for a workspace plan: a checkout (PayOS link or Stripe session) or an automatic
 * Stripe renewal. Paid rows are the workspace's receipts and the source of the admin revenue
 * page; nothing is deleted when a plan lapses.
 *
 * Amounts are integers in the currency's smallest unit (VND: dong, USD: cents).
 */
const PAYMENT_STATUSES = [
    'pending',
    'paid',
    'failed',
    // Checkout expired or the buyer canceled
    'canceled',
    // Paid amount or currency differs from the order: kept for an admin, plan not changed
    'review'
];
const PAYMENT_PROVIDERS = ['payos', 'stripe'];
const PAYMENT_SOURCES = ['pricing', 'upgrade_request', 'renewal'];

const paymentEventSchema = new mongoose.Schema({
    // Provider event id; a webhook delivered twice is applied once
    id: { type: String, required: true },
    type: { type: String, required: true },
    at: { type: Date, default: Date.now }
}, { _id: false });

const paymentSchema = new mongoose.Schema({
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    // Who started the checkout (null for automatic renewals)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'pending', index: true },
    source: { type: String, enum: PAYMENT_SOURCES, default: 'pricing' },
    upgradeRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
    planCode: { type: String, enum: ['pro', 'enterprise'], required: true, lowercase: true, trim: true },
    interval: { type: String, enum: ['month', 'year'], required: true },
    addonCameras: { type: Number, default: 0, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    // Per-camera add-on price included in amount
    addonAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    // PayOS order code (a number the buyer's bank transfer is matched by)
    orderCode: { type: Number, default: null },
    // PayOS paymentLinkId / Stripe checkout session id
    checkoutRef: { type: String, default: null },
    checkoutUrl: { type: String, default: null },
    checkoutExpiresAt: { type: Date, default: null },
    // Provider charge id: PayOS order code, Stripe invoice id
    reference: { type: String, default: null },
    subscriptionRef: { type: String, default: null, index: true },
    customerRef: { type: String, default: null },
    paidAt: { type: Date, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    // FlyBot receipt number, set when paid (FB-<year>-<order>)
    receiptNumber: { type: String, default: null },
    // Provider's own invoice page / number (Stripe)
    receiptUrl: { type: String, default: null },
    providerInvoiceNumber: { type: String, default: null },
    failureReason: { type: String, default: null },
    events: { type: [paymentEventSchema], default: [] }
}, { timestamps: true });

paymentSchema.index({ provider: 1, orderCode: 1 }, { unique: true, partialFilterExpression: { orderCode: { $type: 'number' } } });
paymentSchema.index({ provider: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } });
paymentSchema.index({ provider: 1, checkoutRef: 1 });
paymentSchema.index({ workspaceId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, paidAt: -1 });

const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

module.exports = Payment;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.PAYMENT_PROVIDERS = PAYMENT_PROVIDERS;
module.exports.PAYMENT_SOURCES = PAYMENT_SOURCES;
