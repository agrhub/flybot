/**
 * The contract every payment provider adapter (PayOS, Stripe, ...) implements. The rest of
 * FlyBot only talks to this shape and to the normalized events below, never to a provider's
 * own payloads.
 *
 *   createCheckout(order)        -> { checkoutUrl, checkoutRef, orderCode?, qrCode?, expiresAt? }
 *   verifyWebhook(rawBody, hdrs) -> the parsed payload; throws WebhookSignatureError when the
 *                                   signature is missing, wrong or too old
 *   parseEvent(payload)          -> a normalized event (EVENT_TYPES), or type 'ignored'
 *
 * `order` = { paymentId, workspaceId, planCode, interval ('month' | 'year'), addonCameras,
 *             amount, addonAmount, currency, description, customerEmail, returnUrl, cancelUrl }
 * Amounts are integers in the currency's smallest unit (VND: dong, USD: cents). `amount` is the
 * total; `addonAmount` is the per-camera add-on price (per period) included in that total.
 */
const EVENT_TYPES = Object.freeze({
    // Money arrived: activate or extend the plan
    SUCCEEDED: 'payment.succeeded',
    // A charge (usually a renewal) failed: start the grace period
    FAILED: 'payment.failed',
    // A checkout finished; for recurring providers money is confirmed by SUCCEEDED (the invoice)
    CHECKOUT_COMPLETED: 'checkout.completed',
    // The buyer left or the link expired: nothing was paid
    CANCELED: 'payment.canceled',
    // A recurring subscription stopped: the plan runs out at expiresAt
    SUBSCRIPTION_ENDED: 'subscription.ended',
    IGNORED: 'ignored'
});

const INTERVALS = Object.freeze(['month', 'year']);

class WebhookSignatureError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WebhookSignatureError';
        this.status = 400;
    }
}

class ProviderError extends Error {
    constructor(provider, message, details) {
        super(`${provider}: ${message}`);
        this.name = 'ProviderError';
        this.provider = provider;
        this.details = details;
        this.status = 502;
    }
}

/**
 * A normalized event. Fields a provider does not know stay null.
 *  reference      unique per charge at the provider (PayOS orderCode, Stripe invoice id)
 *  paymentId      FlyBot Payment id carried in the provider's metadata, when it supports it
 *  renewal        true for an automatic recurring charge (not the first checkout)
 */
function normalizedEvent(fields) {
    return {
        provider: null,
        eventId: null,
        type: EVENT_TYPES.IGNORED,
        reference: null,
        paymentId: null,
        orderCode: null,
        checkoutRef: null,
        subscriptionRef: null,
        customerRef: null,
        workspaceId: null,
        planCode: null,
        interval: null,
        addonCameras: null,
        amount: null,
        currency: null,
        paidAt: null,
        periodStart: null,
        periodEnd: null,
        renewal: false,
        receiptUrl: null,
        invoiceNumber: null,
        attempt: null,
        nextRetryAt: null,
        failureReason: null,
        ...fields
    };
}

const toBuffer = (raw) => (Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8'));

/** Parses a webhook body; a body that is not JSON fails like a bad signature. */
function parseJson(raw) {
    try {
        return JSON.parse(toBuffer(raw).toString('utf8'));
    } catch {
        throw new WebhookSignatureError('Webhook body is not JSON');
    }
}

module.exports = {
    EVENT_TYPES,
    INTERVALS,
    WebhookSignatureError,
    ProviderError,
    normalizedEvent,
    toBuffer,
    parseJson
};
