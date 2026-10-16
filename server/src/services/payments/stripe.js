const crypto = require('crypto');
const axios = require('axios');
const {
    EVENT_TYPES, WebhookSignatureError, ProviderError, normalizedEvent, parseJson, toBuffer
} = require('./provider');

/**
 * Stripe (international, card): recurring subscriptions through Checkout Sessions. Plain REST
 * (form-encoded), no SDK. Prices are sent inline (price_data), so no products or prices have to
 * be created in the Stripe dashboard; the plan price stays in FlyBot.
 *
 *  - checkout: POST /v1/checkout/sessions, mode=subscription, one line for the plan and one for
 *    the per-camera add-ons; FlyBot ids go into subscription metadata so every invoice of the
 *    subscription carries them
 *  - webhook: header Stripe-Signature "t=<unix>,v1=<hex>[,v1=...]", v1 = HMAC-SHA256(whsec,
 *    "<t>.<raw body>"), rejected outside the tolerance window (replays)
 *  - money: invoice.paid (first period and every renewal), invoice.payment_failed (Stripe retries
 *    on its own schedule), customer.subscription.deleted (no more renewals)
 */
const NAME = 'stripe';

/** { a: { b: [ { c: 1 } ] } } -> "a[b][0][c]=1" (Stripe's form encoding) */
function formEncode(value, prefix = '', out = new URLSearchParams()) {
    if (value === undefined || value === null) return out;
    if (Array.isArray(value)) {
        value.forEach((item, i) => formEncode(item, `${prefix}[${i}]`, out));
    } else if (typeof value === 'object' && !(value instanceof Date)) {
        for (const [key, item] of Object.entries(value)) formEncode(item, prefix ? `${prefix}[${key}]` : key, out);
    } else {
        out.append(prefix, String(value));
    }
    return out;
}

const isLiveKey = (key) => /^(sk|rk)_live_/.test(String(key || ''));

/** Parses a Stripe-Signature header into { timestamp, signatures }. */
function parseSignatureHeader(header) {
    const result = { timestamp: null, signatures: [] };
    for (const part of String(header || '').split(',')) {
        const [key, value] = part.split('=', 2).map((s) => s && s.trim());
        if (key === 't') result.timestamp = Number(value);
        else if (key === 'v1' && value) result.signatures.push(value);
    }
    return result;
}

/** A Stripe-Signature header for `rawBody` (tests, and the local webhook replayer). */
function signPayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
    const signature = crypto.createHmac('sha256', secret)
        .update(`${timestamp}.`, 'utf8').update(toBuffer(rawBody)).digest('hex');
    return `t=${timestamp},v1=${signature}`;
}

const fromUnix = (seconds) => (seconds ? new Date(Number(seconds) * 1000) : null);

/** FlyBot metadata on an invoice: newer API versions keep it under parent.subscription_details. */
function invoiceMetadata(invoice) {
    return invoice.parent?.subscription_details?.metadata
        || invoice.subscription_details?.metadata
        || invoice.lines?.data?.find((l) => l.metadata && l.metadata.workspaceId)?.metadata
        || {};
}

function invoiceSubscription(invoice) {
    const sub = invoice.parent?.subscription_details?.subscription || invoice.subscription;
    return typeof sub === 'object' && sub ? sub.id : (sub || null);
}

function fromMetadata(meta) {
    const addon = Number(meta.addonCameras);
    return {
        paymentId: meta.paymentId || null,
        workspaceId: meta.workspaceId || null,
        planCode: meta.planCode || null,
        interval: meta.interval || null,
        addonCameras: Number.isFinite(addon) ? addon : null
    };
}

function createStripeProvider(config) {
    const { secretKey, webhookSecret, baseUrl, toleranceSeconds, allowLive } = config;
    const keyAllowed = Boolean(secretKey) && (allowLive || !isLiveKey(secretKey));
    const http = axios.create({
        baseURL: baseUrl,
        timeout: 15000,
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    function assertConfigured() {
        if (!secretKey) throw new ProviderError(NAME, 'STRIPE_SECRET_KEY is required');
        if (!keyAllowed) throw new ProviderError(NAME, 'a live key is set but PAYMENTS_ALLOW_LIVE is not true');
    }

    async function call(method, url, params) {
        try {
            const res = await http.request({ method, url, data: params ? formEncode(params).toString() : undefined });
            return res.data;
        } catch (err) {
            throw new ProviderError(NAME, err.response?.data?.error?.message || err.message, err.response?.data);
        }
    }

    return {
        name: NAME,
        recurring: true,
        currencies: ['USD', 'VND'],

        isConfigured: () => keyAllowed && Boolean(webhookSecret),

        async createCheckout(order) {
            assertConfigured();
            const currency = String(order.currency || 'USD').toLowerCase();
            const addonCameras = Math.max(0, Number(order.addonCameras) || 0);
            const addonAmount = addonCameras ? Number(order.addonAmount) || 0 : 0;
            const baseAmount = order.amount - addonAmount * addonCameras;
            if (!Number.isInteger(order.amount) || baseAmount < 0 || !Number.isInteger(addonAmount)) {
                throw new ProviderError(NAME, 'amounts must be integers in the smallest currency unit');
            }
            const metadata = {
                paymentId: String(order.paymentId),
                workspaceId: String(order.workspaceId),
                planCode: order.planCode,
                interval: order.interval,
                addonCameras
            };
            const recurring = { interval: order.interval === 'year' ? 'year' : 'month' };
            const lineItems = [{
                quantity: 1,
                price_data: { currency, unit_amount: baseAmount, recurring, product_data: { name: `FlyBot ${order.planCode}` } }
            }];
            if (addonCameras && addonAmount) {
                lineItems.push({
                    quantity: addonCameras,
                    price_data: { currency, unit_amount: addonAmount, recurring, product_data: { name: 'FlyBot extra camera' } }
                });
            }
            const session = await call('post', '/v1/checkout/sessions', {
                mode: 'subscription',
                client_reference_id: String(order.workspaceId),
                customer_email: order.customerEmail || undefined,
                success_url: order.returnUrl,
                cancel_url: order.cancelUrl,
                line_items: lineItems,
                metadata,
                subscription_data: { metadata }
            });
            return {
                checkoutUrl: session.url,
                checkoutRef: session.id,
                qrCode: null,
                expiresAt: fromUnix(session.expires_at)
            };
        },

        /** Stops renewals; the plan stays paid until the current period ends. */
        async cancelAtPeriodEnd(subscriptionRef) {
            assertConfigured();
            const sub = await call('post', `/v1/subscriptions/${encodeURIComponent(subscriptionRef)}`, { cancel_at_period_end: true });
            return { status: sub.status, cancelAt: fromUnix(sub.cancel_at || sub.current_period_end) };
        },

        verifyWebhook(rawBody, headers = {}) {
            if (!webhookSecret) throw new WebhookSignatureError('Stripe webhook secret is not set');
            const header = headers['stripe-signature'] || headers['Stripe-Signature'];
            const { timestamp, signatures } = parseSignatureHeader(header);
            if (!timestamp || !signatures.length) throw new WebhookSignatureError('Stripe-Signature header missing or malformed');
            if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
                throw new WebhookSignatureError('Stripe webhook timestamp outside the tolerance window');
            }
            const expected = Buffer.from(crypto.createHmac('sha256', webhookSecret)
                .update(`${timestamp}.`, 'utf8').update(toBuffer(rawBody)).digest('hex'), 'utf8');
            const match = signatures.some((sig) => {
                const given = Buffer.from(sig, 'utf8');
                return given.length === expected.length && crypto.timingSafeEqual(given, expected);
            });
            if (!match) throw new WebhookSignatureError('Stripe webhook signature mismatch');
            return parseJson(rawBody);
        },

        parseEvent(payload) {
            const object = payload?.data?.object || {};
            const base = { provider: NAME, eventId: `${NAME}:${payload?.id}` };
            switch (payload?.type) {
                case 'checkout.session.completed':
                    if (object.mode !== 'subscription') break;
                    return normalizedEvent({
                        ...base,
                        ...fromMetadata(object.metadata || {}),
                        type: EVENT_TYPES.CHECKOUT_COMPLETED,
                        checkoutRef: object.id,
                        subscriptionRef: object.subscription || null,
                        customerRef: object.customer || null,
                        workspaceId: object.client_reference_id || object.metadata?.workspaceId || null
                    });
                case 'checkout.session.expired':
                    return normalizedEvent({
                        ...base,
                        ...fromMetadata(object.metadata || {}),
                        type: EVENT_TYPES.CANCELED,
                        checkoutRef: object.id,
                        failureReason: 'checkout expired'
                    });
                case 'invoice.paid':
                case 'invoice.payment_failed': {
                    const paid = payload.type === 'invoice.paid';
                    const period = object.lines?.data?.[0]?.period || {};
                    return normalizedEvent({
                        ...base,
                        ...fromMetadata(invoiceMetadata(object)),
                        type: paid ? EVENT_TYPES.SUCCEEDED : EVENT_TYPES.FAILED,
                        reference: object.id,
                        subscriptionRef: invoiceSubscription(object),
                        customerRef: object.customer || null,
                        amount: paid ? object.amount_paid : object.amount_due,
                        currency: String(object.currency || '').toUpperCase() || null,
                        paidAt: paid ? (fromUnix(object.status_transitions?.paid_at) || fromUnix(payload.created)) : null,
                        periodStart: fromUnix(period.start),
                        periodEnd: fromUnix(period.end),
                        renewal: object.billing_reason === 'subscription_cycle',
                        receiptUrl: object.hosted_invoice_url || null,
                        invoiceNumber: object.number || null,
                        attempt: object.attempt_count ?? null,
                        nextRetryAt: fromUnix(object.next_payment_attempt),
                        failureReason: paid ? null : (object.last_finalization_error?.message || 'card payment failed')
                    });
                }
                case 'customer.subscription.deleted':
                    return normalizedEvent({
                        ...base,
                        ...fromMetadata(object.metadata || {}),
                        type: EVENT_TYPES.SUBSCRIPTION_ENDED,
                        subscriptionRef: object.id,
                        customerRef: object.customer || null,
                        periodEnd: fromUnix(object.ended_at || object.current_period_end)
                    });
                default:
                    break;
            }
            return normalizedEvent({ ...base, type: EVENT_TYPES.IGNORED });
        }
    };
}

module.exports = {
    createStripeProvider,
    formEncode,
    parseSignatureHeader,
    signPayload,
    isLiveKey
};
