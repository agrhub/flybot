const billingService = require('../services/billingService');
const { recordAudit } = require('../services/auditService');
const { sendServerError } = require('../utils/http');

/**
 * Online payment of workspace plans (API.md "Payments"). Webhooks are routes/paymentWebhookRoutes.js.
 */
const send = (res, { status, body }) => res.status(status).json(body);

async function getSummary(req, res) {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, ...(await billingService.summary(req.user)) });
    } catch (err) {
        sendServerError(res, err, { context: 'Billing' });
    }
}

async function createCheckout(req, res) {
    try {
        const result = await billingService.checkout(req.user, req.body);
        if (result.status === 201) {
            const c = result.body.checkout;
            recordAudit(req, {
                action: 'billing.checkout_started',
                target: { type: 'workspace', id: req.user.workspace?.id || '', label: req.user.workspace?.name || '' },
                details: { plan: c.planCode, interval: c.interval, addonCameras: c.addonCameras, amount: c.amount, currency: c.currency, provider: c.provider, paymentId: c.paymentId }
            });
        }
        send(res, result);
    } catch (err) {
        sendServerError(res, err, { context: 'Checkout' });
    }
}

async function listPayments(req, res) {
    try {
        send(res, await billingService.listPayments(req.user));
    } catch (err) {
        sendServerError(res, err, { context: 'Payments' });
    }
}

async function getPayment(req, res) {
    try {
        res.setHeader('Cache-Control', 'no-store');
        send(res, await billingService.getPayment(req.user, req.params.id, { refresh: req.query.refresh === '1' }));
    } catch (err) {
        sendServerError(res, err, { context: 'Payment' });
    }
}

async function cancelRenewal(req, res) {
    try {
        const result = await billingService.cancelRenewal(req.user);
        if (result.status === 200) {
            recordAudit(req, { action: 'billing.renewal_cancelled', target: { type: 'workspace', id: req.user.workspace?.id || '', label: req.user.workspace?.name || '' } });
        }
        send(res, result);
    } catch (err) {
        sendServerError(res, err, { context: 'Cancel renewal' });
    }
}

/** GET /api/admin/revenue?months=&status= */
async function adminRevenue(req, res) {
    try {
        res.json({ success: true, ...(await billingService.revenue({ months: req.query.months, status: req.query.status })) });
    } catch (err) {
        sendServerError(res, err, { context: 'Revenue' });
    }
}

module.exports = {
    getSummary,
    createCheckout,
    listPayments,
    getPayment,
    cancelRenewal,
    adminRevenue
};
