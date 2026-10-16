const { Organization, UpgradeRequest } = require('../../models');

/**
 * Where payments meet the workspace plan (Organization.plan { code, addonCameras, expiresAt },
 * Organization.billing, services/entitlements.js). The payment service only goes through these
 * functions, so its tests can replace them.
 */
const ownerIdOf = (ws) => (ws?.members || []).find(m => m.role === 'owner' && m.userId)?.userId || null;

/**
 * Activate or extend a paid plan: the workspace's plan becomes { code: planCode, addonCameras,
 * expiresAt: until }, past-due state is cleared, and the upgrade request the payment came from
 * (if any) is approved and marked paid. Idempotent.
 */
async function applyPaidPeriod(workspaceId, planCode, addonCameras, until, context = {}) {
    const now = new Date();
    const set = {
        'plan.code': planCode,
        'plan.addonCameras': Math.max(0, Number(addonCameras) || 0),
        'plan.expiresAt': until,
        'plan.assignedBy': null,
        'plan.assignedAt': now,
        'plan.note': `Paid online (${context.provider || 'payment'})`,
        'billing.provider': context.provider || null,
        'billing.pastDue': false,
        'billing.graceUntil': null,
        'billing.nextRetryAt': null
    };
    if (context.paymentId) set['billing.lastPaymentId'] = context.paymentId;
    const ws = await Organization.findByIdAndUpdate(workspaceId, { $set: set }, { new: true }).lean();
    if (!ws) return { applied: false };

    if (context.upgradeRequestId) {
        await UpgradeRequest.updateOne(
            { _id: context.upgradeRequestId, status: { $in: ['awaiting_payment', 'approved'] } },
            { $set: { status: 'approved', paid: true, 'granted.plan': planCode, 'granted.addonCameras': set['plan.addonCameras'], 'granted.expiresAt': until, 'granted.workspaceId': ws._id } }
        );
    }
    require('../auditService').recordAudit(null, {
        action: 'billing.payment_received',
        actor: { email: `payments:${context.provider || 'unknown'}` },
        target: { type: 'workspace', id: String(ws._id), label: ws.name },
        details: { plan: planCode, addonCameras: set['plan.addonCameras'], expiresAt: new Date(until).toISOString(), paymentId: context.paymentId || '' }
    });
    return { applied: true };
}

/**
 * The date the workspace's paid plan runs to, or null when it is on FREE or has no end. With
 * `planCode`, null also when the workspace is on another plan (a switch starts today).
 */
async function paidThrough(workspaceId, planCode = null) {
    const ws = await Organization.findById(workspaceId).select('plan').lean();
    const plan = ws?.plan;
    if (!plan || plan.code === 'free' || !plan.expiresAt) return null;
    if (planCode && plan.code !== planCode) return null;
    return plan.expiresAt;
}

/**
 * Renewal state: { autoRenew, pastDue, graceUntil, subscriptionRef, provider, nextRetryAt }
 * (only the keys given change).
 */
async function setRenewalState(workspaceId, state) {
    const set = {};
    for (const key of ['autoRenew', 'pastDue', 'graceUntil', 'subscriptionRef', 'customerRef', 'provider', 'nextRetryAt']) {
        if (state[key] !== undefined) set[`billing.${key}`] = state[key];
    }
    if (!Object.keys(set).length) return { applied: false };
    await Organization.updateOne({ _id: workspaceId }, { $set: set });
    return { applied: true };
}

/**
 * Tell the workspace's owner: payment_received { plan, until }, payment_failed { plan, graceUntil },
 * plan_expiring { plan, date, days }.
 */
async function notifyOwner(workspaceId, type, params = {}) {
    const ws = await Organization.findById(workspaceId).select('members name plan').lean();
    const ownerId = ownerIdOf(ws);
    if (!ownerId) return null;
    return require('../notificationService').notifyUser({
        userId: ownerId,
        type,
        params: { workspace: ws.name, ...params, plan: String(params.plan || ws.plan?.code || '').toUpperCase() }
    }).catch(err => console.warn(`⚠️ ${type} notice not sent:`, err.message));
}

module.exports = { applyPaidPeriod, paidThrough, setRenewalState, notifyOwner };
