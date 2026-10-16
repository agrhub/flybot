const mongoose = require('mongoose');
const env = require('../config/env');
const { Organization, Payment, UpgradeRequest } = require('../models');
const planService = require('./planService');
const paymentService = require('./payments/paymentService');
const { availableProviders, getProvider } = require('./payments');
const { paymentsEnabled } = require('./payments/config');
const { ProviderError } = require('./payments/provider');
const bridge = require('./payments/planBridge');
const { TIMEZONE } = require('./captureSchedule');

/**
 * Paying for a workspace plan online (API.md "Payments"): checkout from the pricing page or from
 * an upgrade request approved for online payment, the owner's receipts, stopping automatic
 * renewal, the admin's revenue page, and the daily job (renewal reminders, stale checkouts).
 * The money side (providers, webhooks, plan changes) is services/payments.
 */
const DAY = 24 * 60 * 60 * 1000;
const PAID_PLANS = ['pro', 'enterprise'];
const RANK = { free: 0, pro: 1, enterprise: 2 };
const fail = (status, code, message) => ({ status, body: { success: false, code, message } });
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const idOf = (user) => String(user?.id ?? user?._id ?? '');
const ymd = (date) => new Date(date).toISOString().slice(0, 10);

/** A receipt as the owner (and the admin) sees it. */
function view(p, { admin = false } = {}) {
    const ws = p.workspaceId && typeof p.workspaceId === 'object' && p.workspaceId._id ? p.workspaceId : null;
    const open = p.status === 'pending' && p.checkoutUrl && (!p.checkoutExpiresAt || new Date(p.checkoutExpiresAt) > new Date());
    return {
        id: String(p._id),
        receiptNumber: p.receiptNumber || null,
        status: p.status,
        provider: p.provider,
        source: p.source,
        planCode: p.planCode,
        interval: p.interval,
        addonCameras: p.addonCameras || 0,
        amount: p.amount,
        addonAmount: p.addonAmount || 0,
        currency: p.currency,
        paidAt: p.paidAt || null,
        periodStart: p.periodStart || null,
        periodEnd: p.periodEnd || null,
        receiptUrl: p.receiptUrl || null,
        providerInvoiceNumber: p.providerInvoiceNumber || null,
        checkoutUrl: open ? p.checkoutUrl : null,
        workspace: ws ? { id: String(ws._id), name: ws.name } : { id: String(p.workspaceId) },
        failureReason: admin ? (p.failureReason || null) : undefined,
        reference: admin ? (p.reference || null) : undefined,
        createdAt: p.createdAt
    };
}

const ownerOf = (ws, user) => (ws?.members || []).some(m => m.role === 'owner' && String(m.userId) === idOf(user));

/** GET /api/billing: what the current workspace can pay with, and how its plan renews. */
async function summary(user) {
    const ws = user?.workspace;
    const doc = ws ? await Organization.findById(ws.id).select('plan billing members').lean() : null;
    const providers = availableProviders();
    return {
        enabled: paymentsEnabled() && providers.length > 0,
        providers,
        currencies: [...new Set(providers.flatMap(p => p.currencies))],
        graceDays: env.PAYMENTS_GRACE_DAYS,
        isOwner: !!doc && ownerOf(doc, user),
        plan: doc ? { code: doc.plan?.code || 'free', addonCameras: doc.plan?.addonCameras || 0, expiresAt: doc.plan?.expiresAt || null } : null,
        // A plan the admin assigned without an end date is managed by hand (no online payment)
        managed: !!doc && doc.plan?.code !== 'free' && !doc.plan?.expiresAt && !doc.billing?.provider,
        billing: doc?.billing?.provider ? {
            provider: doc.billing.provider,
            autoRenew: !!doc.billing.autoRenew,
            pastDue: !!doc.billing.pastDue,
            graceUntil: doc.billing.graceUntil || null,
            nextRetryAt: doc.billing.nextRetryAt || null
        } : null
    };
}

/**
 * POST /api/billing/checkout { planCode, interval, addonCameras?, provider, currency?,
 * upgradeRequestId? } by the owner of the current workspace. The price comes from the plan
 * (Admin > Plans), never from the browser. Returns { status, body }.
 */
async function checkout(user, body) {
    if (!paymentsEnabled()) return fail(403, 'PAYMENTS_OFF', 'Online payment is not available. Ask for an upgrade instead.');
    const ws = user?.workspace;
    if (!ws) return fail(400, 'NO_WORKSPACE', 'You have no workspace to upgrade.');
    const doc = await Organization.findById(ws.id).select('name plan billing members').lean();
    if (!doc || !ownerOf(doc, user)) return fail(403, 'FORBIDDEN', 'Only the workspace owner can pay for its plan.');

    const b = body && typeof body === 'object' ? body : {};
    if (!['month', 'year'].includes(b.interval)) return fail(400, 'BAD_REQUEST', 'interval must be month or year.');
    const provider = availableProviders().find(p => p.name === b.provider);
    if (!provider) return fail(400, 'BAD_REQUEST', 'This payment method is not available.');
    const currency = String(b.currency || provider.currencies[0]).toUpperCase();
    if (!provider.currencies.includes(currency)) return fail(400, 'BAD_REQUEST', 'This payment method does not take this currency.');

    let planCode;
    let addonCameras;
    let request = null;
    if (b.upgradeRequestId !== undefined && b.upgradeRequestId !== null) {
        if (!mongoose.isValidObjectId(b.upgradeRequestId)) return fail(404, 'NOT_FOUND', 'Request not found.');
        request = await UpgradeRequest.findOne({ _id: b.upgradeRequestId, workspaceId: doc._id, status: 'awaiting_payment' }).lean();
        if (!request) return fail(404, 'NOT_FOUND', 'Request not found.');
        planCode = request.granted?.plan || request.targetPlan;
        addonCameras = request.granted?.addonCameras ?? request.extraCameras ?? 0;
        if (!PAID_PLANS.includes(planCode)) return fail(400, 'BAD_REQUEST', 'planCode must be pro or enterprise.');
    } else {
        planCode = b.planCode;
        if (!PAID_PLANS.includes(planCode)) return fail(400, 'BAD_REQUEST', 'planCode must be pro or enterprise.');
        addonCameras = int(b.addonCameras ?? 0, 0, 1000);
        if (addonCameras === null) return fail(400, 'BAD_REQUEST', 'addonCameras must be a whole number from 0 to 1000.');
    }

    const now = new Date();
    const current = doc.plan?.code || 'free';
    const running = current !== 'free' && (!doc.plan?.expiresAt || new Date(doc.plan.expiresAt) > now);
    if (current !== 'free' && !doc.plan?.expiresAt && !doc.billing?.provider) {
        return fail(409, 'MANAGED_PLAN', 'Your plan is managed by FlyBot. Ask for an upgrade instead.');
    }
    if (running && doc.billing?.autoRenew && doc.billing?.subscriptionRef) {
        return fail(409, 'ALREADY_SUBSCRIBED', 'This workspace already renews automatically.');
    }
    if (running && RANK[planCode] < RANK[current]) {
        return fail(409, 'DOWNGRADE', 'Your current plan is still running. Choose it again or wait until it ends.');
    }

    const price = await planService.quote(planCode, { currency, interval: b.interval, addonCameras });
    if (!price) return fail(400, 'NOT_FOR_SALE', 'This plan is not sold online. Ask for an upgrade instead.');
    if (!env.APP_BASE_URL) return fail(503, 'NOT_CONFIGURED', 'Online payment is not set up yet.');

    let result;
    try {
        result = await paymentService.startCheckout({
            provider: provider.name,
            workspaceId: String(doc._id),
            userId: idOf(user),
            planCode,
            interval: b.interval,
            addonCameras,
            amount: price.amount,
            addonAmount: price.addonAmount,
            currency,
            customerEmail: user.email || undefined,
            returnUrl: `${env.APP_BASE_URL}/billing/return?payment={PAYMENT_ID}`,
            cancelUrl: `${env.APP_BASE_URL}/billing/return?payment={PAYMENT_ID}&cancelled=1`,
            source: request ? 'upgrade_request' : 'pricing',
            upgradeRequestId: request ? String(request._id) : null
        });
    } catch (err) {
        if (err instanceof ProviderError) {
            console.warn('⚠️ Checkout failed:', err.message);
            return fail(502, 'PROVIDER_ERROR', 'The payment service did not answer. Please try again.');
        }
        throw err;
    }
    return {
        status: 201,
        body: {
            success: true,
            checkout: {
                paymentId: String(result.paymentId),
                provider: result.provider,
                checkoutUrl: result.checkoutUrl,
                qrCode: result.qrCode,
                expiresAt: result.expiresAt,
                planCode,
                interval: b.interval,
                addonCameras,
                amount: price.amount,
                currency
            }
        }
    };
}

/** GET /api/billing/payments: the current workspace's payments (its owner). */
async function listPayments(user) {
    const ws = user?.workspace;
    const doc = ws ? await Organization.findById(ws.id).select('members').lean() : null;
    if (!doc || !ownerOf(doc, user)) return fail(403, 'FORBIDDEN', 'Only the workspace owner can see its payments.');
    const docs = await Payment.find({ workspaceId: doc._id, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(100).populate('workspaceId', 'name').lean();
    const pending = await Payment.find({ workspaceId: doc._id, status: 'pending' }).sort({ createdAt: -1 }).limit(5).populate('workspaceId', 'name').lean();
    return { status: 200, body: { success: true, payments: [...pending, ...docs].map(p => view(p)) } };
}

/**
 * GET /api/billing/payments/:id: one payment (the return page polls it; a pending PayOS
 * payment is checked with PayOS when its webhook is late). The payer or the workspace owner.
 */
async function getPayment(user, id, { refresh = false } = {}) {
    if (!mongoose.isValidObjectId(id)) return fail(404, 'NOT_FOUND', 'Payment not found.');
    let payment = await Payment.findById(id).populate('workspaceId', 'name members').lean();
    const ws = payment?.workspaceId;
    if (!payment || !(String(payment.userId) === idOf(user) || ownerOf(ws, user))) return fail(404, 'NOT_FOUND', 'Payment not found.');
    if (refresh && payment.status === 'pending' && Date.now() - new Date(payment.createdAt).getTime() > 5000) {
        try {
            await paymentService.reconcile(payment._id);
            payment = await Payment.findById(id).populate('workspaceId', 'name').lean();
        } catch (err) {
            console.warn('⚠️ Payment status check failed:', err.message);
        }
    }
    return { status: 200, body: { success: true, payment: view(payment) } };
}

/** POST /api/billing/cancel-renewal: stop the automatic renewal (Stripe); the plan runs to its end. */
async function cancelRenewal(user) {
    const ws = user?.workspace;
    const doc = ws ? await Organization.findById(ws.id).select('members billing plan').lean() : null;
    if (!doc || !ownerOf(doc, user)) return fail(403, 'FORBIDDEN', 'Only the workspace owner can pay for its plan.');
    if (!doc.billing?.autoRenew || !doc.billing?.subscriptionRef) return fail(409, 'NOT_RENEWING', 'This workspace does not renew automatically.');
    const provider = getProvider(doc.billing.provider);
    if (!provider?.cancelAtPeriodEnd) return fail(409, 'NOT_RENEWING', 'This workspace does not renew automatically.');
    try {
        await provider.cancelAtPeriodEnd(doc.billing.subscriptionRef);
    } catch (err) {
        if (err instanceof ProviderError) {
            console.warn('⚠️ Cancel renewal failed:', err.message);
            return fail(502, 'PROVIDER_ERROR', 'The payment service did not answer. Please try again.');
        }
        throw err;
    }
    await bridge.setRenewalState(String(doc._id), { autoRenew: false });
    return { status: 200, body: { success: true, autoRenew: false, expiresAt: doc.plan?.expiresAt || null } };
}

// ---------- Admin ----------

/**
 * GET /api/admin/revenue?months=12&status=: paid amounts by month, provider and plan (per
 * currency, never added across currencies), paying workspaces, and the latest payments.
 */
async function revenue({ months = 12, status = null, now = new Date() } = {}) {
    const span = Math.min(Math.max(Number(months) || 12, 1), 36);
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (span - 1), 1));
    const groups = await Payment.aggregate([
        { $match: { status: 'paid', paidAt: { $gte: since } } },
        {
            $group: {
                _id: { month: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: TIMEZONE } }, currency: '$currency', provider: '$provider', planCode: '$planCode' },
                amount: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        }
    ]);
    // Sums of the groups by some of their keys (always with the currency)
    const sumBy = (keys) => {
        const rows = new Map();
        for (const g of groups) {
            const id = Object.fromEntries(keys.map(k => [k, g._id[k]]));
            const key = JSON.stringify(id);
            const row = rows.get(key) || { ...id, amount: 0, count: 0 };
            row.amount += g.amount;
            row.count += g.count;
            rows.set(key, row);
        }
        return [...rows.values()];
    };

    const filter = ['pending', 'paid', 'failed', 'canceled', 'review'].includes(status) ? { status } : {};
    const [recent, review, paying, renewing, pastDue] = await Promise.all([
        Payment.find(filter).sort({ createdAt: -1 }).limit(100).populate('workspaceId', 'name').lean(),
        Payment.countDocuments({ status: 'review' }),
        Organization.countDocuments({ 'billing.provider': { $ne: null }, 'plan.code': { $ne: 'free' }, 'plan.expiresAt': { $gt: now } }),
        Organization.countDocuments({ 'billing.autoRenew': true, 'plan.expiresAt': { $gt: now } }),
        Organization.countDocuments({ 'billing.pastDue': true })
    ]);
    return {
        since,
        months: span,
        totals: sumBy(['currency']),
        byMonth: sumBy(['month', 'currency']).sort((a, b) => a.month.localeCompare(b.month)),
        byProvider: sumBy(['provider', 'currency']),
        byPlan: sumBy(['planCode', 'currency']),
        workspaces: { paying, renewing, pastDue },
        review,
        payments: recent.map(p => view(p, { admin: true }))
    };
}

// ---------- Daily job ----------

/**
 * Once a day: close checkouts nobody finished (a PayOS one is checked with PayOS first), and
 * remind owners whose plan is paid per period (PayOS, or a Stripe subscription that was stopped)
 * 7 days and 1 day before it ends, and when it has ended (grace period). Each reminder once.
 */
async function runDaily(now = new Date()) {
    let closed = 0;
    const stale = await Payment.find({ status: 'pending', createdAt: { $lt: new Date(now.getTime() - DAY) } }).select('_id provider orderCode').limit(500).lean();
    for (const p of stale) {
        if (p.provider === 'payos' && p.orderCode) {
            try {
                const outcome = await paymentService.reconcile(p._id);
                if (outcome.result !== 'unchanged') continue;
            } catch (err) {
                console.warn('⚠️ Payment status check failed:', err.message);
            }
        }
        const res = await Payment.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'canceled', failureReason: 'checkout not finished' } });
        closed += res.modifiedCount || 0;
    }

    let reminded = 0;
    if (paymentsEnabled()) {
        const horizon = new Date(now.getTime() + 8 * DAY);
        const graceStart = new Date(now.getTime() - (env.PAYMENTS_GRACE_DAYS + 1) * DAY);
        const workspaces = await Organization.find({
            'billing.provider': { $ne: null },
            'billing.autoRenew': { $ne: true },
            'plan.code': { $in: PAID_PLANS },
            'plan.expiresAt': { $gt: graceStart, $lt: horizon }
        }).select('plan billing').lean();
        for (const ws of workspaces) {
            const end = new Date(ws.plan.expiresAt);
            const daysLeft = Math.ceil((end.getTime() - now.getTime()) / DAY);
            let stage = null;
            if (daysLeft <= 0) stage = 'ended';
            else if (daysLeft <= 1) stage = '1d';
            else if (daysLeft <= 7) stage = '7d';
            if (!stage) continue;
            const key = `${end.toISOString()}|${stage}`;
            if ((ws.billing.notices || []).includes(key)) continue;
            const marked = await Organization.updateOne(
                { _id: ws._id, 'billing.notices': { $ne: key } },
                { $push: { 'billing.notices': { $each: [key], $slice: -20 } } }
            );
            if (!marked.modifiedCount) continue;
            if (stage === 'ended') {
                const graceUntil = ws.billing.graceUntil ? new Date(ws.billing.graceUntil) : new Date(end.getTime() + env.PAYMENTS_GRACE_DAYS * DAY);
                await bridge.notifyOwner(String(ws._id), 'plan_ended', { plan: ws.plan.code, date: ymd(end), graceDate: ymd(graceUntil) });
            } else {
                await bridge.notifyOwner(String(ws._id), 'plan_expiring', { plan: ws.plan.code, date: ymd(end), days: daysLeft });
            }
            reminded += 1;
        }
    }
    if (closed || reminded) console.log(`💳 Billing: ${closed} unfinished checkout(s) closed, ${reminded} reminder(s) sent.`);
    return { closed, reminded };
}

module.exports = {
    view,
    summary,
    checkout,
    listPayments,
    getPayment,
    cancelRenewal,
    revenue,
    runDaily
};
