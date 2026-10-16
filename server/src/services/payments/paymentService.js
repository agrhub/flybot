const { EVENT_TYPES, INTERVALS, ProviderError, normalizedEvent } = require('./provider');
const { paymentsConfig, paymentsEnabled } = require('./config');

/**
 * Checkout and webhooks for workspace plans, provider-neutral:
 *
 *  startCheckout   records a pending Payment and asks the provider for a checkout link
 *  handleWebhook   verifies the signature, records the event once, and moves the plan through
 *                  the plan bridge: paid -> activate / extend, failed renewal -> grace period,
 *                  subscription ended -> no auto renew (the plan runs out at expiresAt)
 *
 * A workspace keeps its data on every path; falling back to FREE is the plan model's job once
 * planState() says 'expired'.
 *
 * Built with createPaymentService(deps) so tests pass an in-memory Payment model and a recording
 * plan bridge; the module's default instance uses the real ones.
 */
const DAY = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 50;

/** `date` + one month / year; the 31st becomes the month's last day (Jan 31 + 1 month = Feb 28/29). */
function addInterval(date, interval) {
    const d = new Date(date);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d;
}

/**
 * Where a paid plan stands: 'free' (never paid / no expiry), 'active', 'grace' (expired less than
 * graceDays ago, or past due until graceUntil) or 'expired' (fall back to FREE, keep the data).
 */
function planState({ expiresAt, graceUntil = null, now = new Date(), graceDays = paymentsConfig().graceDays }) {
    if (!expiresAt) return 'free';
    const t = new Date(now).getTime();
    const end = new Date(expiresAt).getTime();
    if (t < end) return 'active';
    const graceEnd = graceUntil ? new Date(graceUntil).getTime() : end + graceDays * DAY;
    return t < graceEnd ? 'grace' : 'expired';
}

const ymd = (date) => new Date(date).toISOString().slice(0, 10);
const receiptNumber = (payment, paidAt) => `FB-${new Date(paidAt).getUTCFullYear()}-${String(payment._id).slice(-8).toUpperCase()}`;

function createPaymentService(deps = {}) {
    const Payment = deps.Payment || require('../../models/Payment');
    const bridge = deps.bridge || require('./planBridge');
    const getProvider = deps.getProvider || require('./index').getProvider;
    const config = () => deps.config || paymentsConfig();
    const now = deps.now || (() => new Date());

    const notify = (workspaceId, type, params) => (bridge.notifyOwner ? bridge.notifyOwner(String(workspaceId), type, params) : null);

    function seen(payment, event) {
        return Boolean(event.eventId) && (payment.events || []).some((e) => e.id === event.eventId);
    }

    async function remember(payment, event, changes = {}) {
        Object.assign(payment, changes);
        if (event.eventId) payment.events = [...(payment.events || []), { id: event.eventId, type: event.type, at: now() }].slice(-MAX_EVENTS);
        await payment.save();
        return payment;
    }

    async function findPayment(provider, event) {
        if (event.orderCode) {
            const byOrder = await Payment.findOne({ provider, orderCode: event.orderCode });
            if (byOrder) return byOrder;
        }
        if (event.reference) {
            const byRef = await Payment.findOne({ provider, reference: event.reference });
            if (byRef) return byRef;
        }
        // The first invoice of a subscription belongs to the checkout's Payment; renewals do not
        if (event.paymentId && !event.renewal) {
            const byId = await Payment.findById(event.paymentId).catch(() => null);
            if (byId && byId.provider === provider) return byId;
        }
        if (event.checkoutRef) return Payment.findOne({ provider, checkoutRef: event.checkoutRef });
        return null;
    }

    /** A renewal charge (Stripe) gets its own Payment, copied from the subscription's first one. */
    async function renewalPayment(provider, event) {
        const first = event.subscriptionRef
            ? await Payment.findOne({ provider, subscriptionRef: event.subscriptionRef }, null, { sort: { createdAt: 1 } })
            : null;
        const workspaceId = event.workspaceId || first?.workspaceId;
        const planCode = event.planCode || first?.planCode;
        if (!workspaceId || !planCode) return null;
        return Payment.create({
            workspaceId,
            provider,
            source: 'renewal',
            planCode,
            interval: event.interval || first?.interval || 'month',
            addonCameras: event.addonCameras ?? first?.addonCameras ?? 0,
            amount: event.amount ?? 0,
            currency: event.currency || first?.currency,
            reference: event.reference,
            subscriptionRef: event.subscriptionRef,
            customerRef: event.customerRef || first?.customerRef || null
        });
    }

    async function onSucceeded(provider, event) {
        let payment = await findPayment(provider.name, event);
        if (!payment) payment = await renewalPayment(provider.name, event);
        if (!payment) return { result: 'unknown_payment' };
        if (seen(payment, event) || payment.status === 'paid') return { result: 'duplicate', paymentId: payment._id };

        const paidAt = event.paidAt || now();
        const refs = {
            reference: payment.reference || event.reference,
            subscriptionRef: event.subscriptionRef || payment.subscriptionRef,
            customerRef: event.customerRef || payment.customerRef,
            receiptUrl: event.receiptUrl || payment.receiptUrl,
            providerInvoiceNumber: event.invoiceNumber || payment.providerInvoiceNumber
        };
        // Less money (or another currency) than ordered: an admin decides, the plan stays as is
        const short = event.amount !== null && event.amount < payment.amount;
        const otherCurrency = event.currency && event.currency !== payment.currency;
        if (short || otherCurrency) {
            await remember(payment, event, { ...refs, status: 'review', paidAt, failureReason: `paid ${event.amount} ${event.currency}, expected ${payment.amount} ${payment.currency}` });
            return { result: 'review', paymentId: payment._id };
        }

        // Recurring providers say when the period ends; a one-off payment extends what is left
        let periodStart = event.periodStart;
        let periodEnd = event.periodEnd;
        if (!periodEnd) {
            const current = await bridge.paidThrough(String(payment.workspaceId), payment.planCode);
            periodStart = current && new Date(current) > paidAt ? new Date(current) : paidAt;
            periodEnd = addInterval(periodStart, payment.interval);
        }

        await remember(payment, event, {
            ...refs,
            status: 'paid',
            paidAt,
            periodStart,
            periodEnd,
            failureReason: null,
            receiptNumber: payment.receiptNumber || receiptNumber(payment, paidAt)
        });
        await bridge.applyPaidPeriod(String(payment.workspaceId), payment.planCode, payment.addonCameras || 0, periodEnd, {
            paymentId: String(payment._id),
            upgradeRequestId: payment.upgradeRequestId ? String(payment.upgradeRequestId) : null,
            provider: provider.name
        });
        await bridge.setRenewalState(String(payment.workspaceId), {
            autoRenew: provider.recurring,
            pastDue: false,
            graceUntil: null,
            subscriptionRef: refs.subscriptionRef || null,
            provider: provider.name
        });
        await notify(payment.workspaceId, 'payment_received', { plan: payment.planCode, date: ymd(periodEnd) });
        return { result: 'applied', paymentId: payment._id, until: periodEnd };
    }

    async function onFailed(provider, event) {
        let payment = await findPayment(provider.name, event);
        if (!payment && event.renewal) payment = await renewalPayment(provider.name, event);
        if (!payment) return { result: 'unknown_payment' };
        if (seen(payment, event)) return { result: 'duplicate', paymentId: payment._id };
        if (payment.status === 'paid') {
            await remember(payment, event);
            return { result: 'ignored', paymentId: payment._id };
        }
        await remember(payment, event, { status: 'failed', failureReason: event.failureReason });
        // A failed renewal keeps the plan for the grace period, then the workspace falls back to FREE;
        // a failed first checkout changes nothing (the workspace stays on what it had)
        const current = provider.recurring ? await bridge.paidThrough(String(payment.workspaceId)) : null;
        if (current) {
            const from = new Date(current) > now() ? new Date(current) : now();
            const graceUntil = new Date(from.getTime() + config().graceDays * DAY);
            await bridge.setRenewalState(String(payment.workspaceId), {
                autoRenew: true,
                pastDue: true,
                graceUntil,
                subscriptionRef: event.subscriptionRef || payment.subscriptionRef || null,
                provider: provider.name,
                nextRetryAt: event.nextRetryAt
            });
            await notify(payment.workspaceId, 'payment_failed', { plan: payment.planCode, date: ymd(graceUntil) });
            return { result: 'grace', paymentId: payment._id, graceUntil };
        }
        return { result: 'failed', paymentId: payment._id };
    }

    async function onCheckoutEvent(provider, event) {
        const payment = await findPayment(provider.name, event);
        if (!payment) return { result: 'unknown_payment' };
        if (seen(payment, event)) return { result: 'duplicate', paymentId: payment._id };
        const changes = {
            subscriptionRef: event.subscriptionRef || payment.subscriptionRef,
            customerRef: event.customerRef || payment.customerRef
        };
        if (event.type === EVENT_TYPES.CANCELED && payment.status === 'pending') {
            Object.assign(changes, { status: 'canceled', failureReason: event.failureReason });
        }
        await remember(payment, event, changes);
        return { result: event.type === EVENT_TYPES.CANCELED ? 'canceled' : 'linked', paymentId: payment._id };
    }

    async function onSubscriptionEnded(provider, event) {
        const payment = await Payment.findOne({ provider: provider.name, subscriptionRef: event.subscriptionRef }, null, { sort: { createdAt: -1 } });
        const workspaceId = event.workspaceId || payment?.workspaceId;
        if (!workspaceId) return { result: 'unknown_payment' };
        await bridge.setRenewalState(String(workspaceId), {
            autoRenew: false,
            subscriptionRef: event.subscriptionRef,
            provider: provider.name
        });
        return { result: 'ended', paymentId: payment?._id || null };
    }

    return {
        /**
         * Starts a checkout. `order`: { provider, workspaceId, userId, planCode, interval,
         * addonCameras, amount, addonAmount, currency, customerEmail, returnUrl, cancelUrl,
         * source, upgradeRequestId }. The amount is computed by the caller from the plan's
         * price (Plan collection), never taken from the browser.
         */
        async startCheckout(order) {
            if (!paymentsEnabled(config())) throw Object.assign(new Error('Automatic payments are not available'), { status: 403 });
            const provider = getProvider(order.provider);
            if (!provider || !provider.isConfigured()) throw Object.assign(new Error('Unknown payment provider'), { status: 400 });
            if (!INTERVALS.includes(order.interval)) throw Object.assign(new Error('interval must be month or year'), { status: 400 });
            const currency = String(order.currency || '').toUpperCase();
            if (!provider.currencies.includes(currency)) throw Object.assign(new Error(`${provider.name} does not take ${currency}`), { status: 400 });

            const payment = await Payment.create({
                workspaceId: order.workspaceId,
                userId: order.userId || null,
                provider: provider.name,
                source: order.source || 'pricing',
                upgradeRequestId: order.upgradeRequestId || null,
                planCode: order.planCode,
                interval: order.interval,
                addonCameras: order.addonCameras || 0,
                amount: order.amount,
                addonAmount: order.addonAmount || 0,
                currency
            });
            // The return page asks for this payment's status ({PAYMENT_ID} in the URLs)
            const withId = (url) => String(url || '').replace('{PAYMENT_ID}', String(payment._id));
            try {
                const checkout = await provider.createCheckout({
                    ...order,
                    currency,
                    paymentId: String(payment._id),
                    returnUrl: withId(order.returnUrl),
                    cancelUrl: withId(order.cancelUrl)
                });
                Object.assign(payment, {
                    checkoutRef: checkout.checkoutRef,
                    checkoutUrl: checkout.checkoutUrl,
                    checkoutExpiresAt: checkout.expiresAt || null,
                    orderCode: checkout.orderCode ?? null
                });
                await payment.save();
                return { paymentId: payment._id, provider: provider.name, checkoutUrl: checkout.checkoutUrl, qrCode: checkout.qrCode || null, expiresAt: checkout.expiresAt || null };
            } catch (err) {
                payment.status = 'failed';
                payment.failureReason = err instanceof ProviderError ? err.message : 'checkout failed';
                await payment.save();
                throw err;
            }
        },

        /**
         * Verifies and applies one webhook delivery. Throws WebhookSignatureError (400) on a bad
         * signature; otherwise returns { result, paymentId? } and the caller answers 200 so the
         * provider stops retrying ('unknown_payment' and 'ignored' included).
         */
        async handleWebhook(providerName, rawBody, headers = {}) {
            const provider = getProvider(providerName);
            if (!provider) return { result: 'unknown_provider' };
            const payload = provider.verifyWebhook(rawBody, headers);
            if (!paymentsEnabled(config())) return { result: 'disabled' };
            const event = provider.parseEvent(payload);
            switch (event.type) {
                case EVENT_TYPES.SUCCEEDED: return onSucceeded(provider, event);
                case EVENT_TYPES.FAILED: return onFailed(provider, event);
                case EVENT_TYPES.CHECKOUT_COMPLETED:
                case EVENT_TYPES.CANCELED: return onCheckoutEvent(provider, event);
                case EVENT_TYPES.SUBSCRIPTION_ENDED: return onSubscriptionEnded(provider, event);
                default: return { result: 'ignored' };
            }
        },

        /**
         * A pending payment whose webhook has not come (yet): asks the provider (PayOS payment
         * link status, a signed API answer) and applies it the same way. Returns { result }.
         */
        async reconcile(paymentId) {
            const payment = await Payment.findById(paymentId).catch(() => null);
            if (!payment || payment.status !== 'pending' || !payment.orderCode) return { result: 'unchanged' };
            const provider = getProvider(payment.provider);
            if (!provider?.getCheckout || !provider.isConfigured() || !paymentsEnabled(config())) return { result: 'unchanged' };
            const info = await provider.getCheckout(payment.orderCode);
            const base = { provider: provider.name, reference: String(payment.orderCode), orderCode: payment.orderCode, checkoutRef: payment.checkoutRef };
            if (info.status === 'PAID') {
                return onSucceeded(provider, normalizedEvent({
                    ...base,
                    eventId: `${provider.name}:${payment.orderCode}:status`,
                    type: EVENT_TYPES.SUCCEEDED,
                    amount: Number(info.amountPaid ?? info.amount),
                    currency: payment.currency,
                    paidAt: now()
                }));
            }
            if (['CANCELLED', 'EXPIRED'].includes(info.status)) {
                return onCheckoutEvent(provider, normalizedEvent({
                    ...base,
                    eventId: `${provider.name}:${payment.orderCode}:${info.status.toLowerCase()}`,
                    type: EVENT_TYPES.CANCELED,
                    failureReason: info.status.toLowerCase()
                }));
            }
            return { result: 'unchanged' };
        }
    };
}

let defaultService = null;
const service = () => (defaultService = defaultService || createPaymentService());

module.exports = {
    createPaymentService,
    addInterval,
    planState,
    startCheckout: (order) => service().startCheckout(order),
    handleWebhook: (provider, rawBody, headers) => service().handleWebhook(provider, rawBody, headers),
    reconcile: (paymentId) => service().reconcile(paymentId)
};
