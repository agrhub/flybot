/**
 * Online payment of workspace plans, end to end through the API: checkout (PayOS, Stripe),
 * signed webhooks, plan activation, renewal, failed renewal and grace, fall back to FREE without
 * losing data, upgrade requests paid online, receipts, the admin's revenue page, the daily job,
 * and APP_MODE=b2b (manual invoicing). The provider APIs are a local stub server.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');

process.env.TELEGRAM_BOT_TOKEN = '';

const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const env = require('../src/config/env');
const planService = require('../src/services/planService');
const entitlements = require('../src/services/entitlements');
const billingService = require('../src/services/billingService');
const { canonicalData } = require('../src/services/payments/payos');
const { signPayload } = require('../src/services/payments/stripe');

const PAYOS_KEY = 'test-payos-checksum';
const STRIPE_WHSEC = 'whsec_test_billing';
const DAY = 24 * 60 * 60 * 1000;
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');

// ---------- Provider API stub ----------
let stub;
let calls;
let payosStatus; // what GET /v2/payment-requests/:id answers

function stubAnswer(call) {
    if (call.method === 'POST' && call.url === '/v2/payment-requests') {
        const sent = JSON.parse(call.raw);
        const data = { amount: sent.amount, description: sent.description, orderCode: sent.orderCode, currency: 'VND', paymentLinkId: `plink_${sent.orderCode}`, status: 'PENDING', checkoutUrl: `https://pay.payos.vn/web/plink_${sent.orderCode}`, qrCode: '000201010212' };
        return { code: '00', desc: 'success', data, signature: hmac(PAYOS_KEY, canonicalData(data)) };
    }
    if (call.method === 'GET' && call.url.startsWith('/v2/payment-requests/')) {
        const orderCode = Number(call.url.split('/').pop());
        const data = { orderCode, amount: payosStatus.amount, amountPaid: payosStatus.status === 'PAID' ? payosStatus.amount : 0, status: payosStatus.status };
        return { code: '00', desc: 'success', data, signature: hmac(PAYOS_KEY, canonicalData(data)) };
    }
    if (call.method === 'POST' && call.url === '/v1/checkout/sessions') {
        return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    }
    if (call.method === 'POST' && call.url.startsWith('/v1/subscriptions/')) {
        return { id: call.url.split('/').pop(), status: 'active', cancel_at: Math.floor(Date.now() / 1000) + 10 * 86400 };
    }
    return { error: { message: 'not stubbed' } };
}

before(async () => {
    stub = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const call = { method: req.method, url: req.url, headers: req.headers, raw };
            calls.push(call);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stubAnswer(call)));
        });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${stub.address().port}`;
    Object.assign(env, {
        PAYOS_CLIENT_ID: 'test-client', PAYOS_API_KEY: 'test-key', PAYOS_CHECKSUM_KEY: PAYOS_KEY, PAYOS_API_URL: url,
        STRIPE_SECRET_KEY: 'sk_test_billing', STRIPE_WEBHOOK_SECRET: STRIPE_WHSEC, STRIPE_API_URL: url
    });
    await startDb();
});
after(async () => {
    await stopDb();
    await new Promise((resolve) => stub.close(resolve));
});
beforeEach(async () => {
    await clearDb();
    planService.clearCache();
    Object.assign(env, { APP_MODE: 'b2c', PAYMENTS_ENABLED: true, PAYMENTS_GRACE_DAYS: 7, PAYMENTS_ALLOW_LIVE: false });
    calls = [];
    payosStatus = { status: 'PENDING', amount: 0 };
    await planService.updatePlan('pro', { prices: { VND: { month: 199000, year: 1990000, addonMonth: 30000, addonYear: 300000 }, USD: { month: 900, year: 9000, addonMonth: 150, addonYear: 1500 } } }, null);
});

// ---------- Helpers ----------
const freeOwner = async (email) => {
    const user = await createUser({ plan: 'free', email });
    const ws = await models.Organization.findOne({ 'members.userId': user._id }).lean();
    return { user, ws };
};
const checkout = (as, body) => request('/api/billing/checkout', { method: 'POST', as, body }).then(json);
const myEntitlements = (as) => request('/api/me/entitlements', { as }).then(json).then(r => r.body.entitlements);
const workspaceOf = (ws) => models.Organization.findById(ws._id).lean();

// PayOS writes the payment time in Vietnam time (UTC+7), "YYYY-MM-DD HH:mm:ss"
const vnNow = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

function payosHook(data, key = PAYOS_KEY) {
    const full = { orderCode: 1, amount: 0, description: 'FBPROM', accountNumber: '12345678', reference: `FT${data.orderCode}`, transactionDateTime: vnNow(), currency: 'VND', paymentLinkId: `plink_${data.orderCode}`, code: '00', desc: 'success', counterAccountBankId: '', counterAccountBankName: '', counterAccountName: '', counterAccountNumber: '', virtualAccountName: '', virtualAccountNumber: '', ...data };
    return JSON.stringify({ code: '00', desc: 'success', success: true, data: full, signature: hmac(key, canonicalData(full)) });
}
const postHook = (provider, raw, headers = {}) => request(`/api/payments/webhooks/${provider}`, {
    method: 'POST', body: Buffer.from(raw), headers: { 'Content-Type': 'application/json', ...headers }
}).then(json);

function stripeHook(type, object) {
    const raw = JSON.stringify({ id: `evt_${crypto.randomBytes(6).toString('hex')}`, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } });
    return postHook('stripe', raw, { 'Stripe-Signature': signPayload(raw, STRIPE_WHSEC) });
}
const invoice = ({ id, meta, start, end, reason = 'subscription_create', amount = 900 }) => ({
    id, object: 'invoice', customer: 'cus_1', currency: 'usd', amount_paid: amount, amount_due: amount, billing_reason: reason,
    number: `INV-${id}`, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, attempt_count: 1,
    status_transitions: { paid_at: Math.floor(start / 1000) },
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: meta } },
    lines: { data: [{ period: { start: Math.floor(start / 1000), end: Math.floor(end / 1000) } }] }
});

// ---------- PayOS: FREE to PRO ----------

test('PayOS: a FREE workspace pays in test mode and becomes PRO (with 2 add-on cameras)', async () => {
    const { user, ws } = await freeOwner('farmer@example.test');
    assert.equal((await myEntitlements(user)).plan, 'free');

    const summary = await json(await request('/api/billing', { as: user }));
    assert.equal(summary.body.enabled, true);
    assert.equal(summary.body.isOwner, true);
    assert.deepEqual(summary.body.providers.map(p => p.name).sort(), ['payos', 'stripe']);

    // The browser's amount is ignored: the price comes from the plan
    const started = await checkout(user, { planCode: 'pro', interval: 'month', addonCameras: 2, provider: 'payos', amount: 1 });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.match(started.body.checkout.checkoutUrl, /^https:\/\/pay\.payos\.vn\//);
    assert.equal(started.body.checkout.amount, 199000 + 2 * 30000);
    const sent = JSON.parse(calls.find(c => c.url === '/v2/payment-requests').raw);
    assert.equal(sent.amount, 259000);
    assert.equal(sent.returnUrl, `https://app.example.test/billing/return?payment=${started.body.checkout.paymentId}`);

    const payment = await models.Payment.findById(started.body.checkout.paymentId).lean();
    assert.equal(payment.status, 'pending');
    assert.equal(String(payment.workspaceId), String(ws._id));

    const hook = payosHook({ orderCode: payment.orderCode, amount: 259000 });
    const delivered = await postHook('payos', hook);
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.result, 'applied');

    const ent = await myEntitlements(user);
    assert.equal(ent.plan, 'pro');
    assert.equal(ent.addonCameras, 2);
    assert.equal(ent.maxCameras, 10 + 2);
    const days = (new Date(ent.expiresAt) - Date.now()) / DAY;
    assert.ok(days > 27 && days < 32, `expires in ${days} days`);

    const doc = await workspaceOf(ws);
    assert.equal(doc.billing.provider, 'payos');
    assert.equal(doc.billing.autoRenew, false);

    // The receipt, for the owner
    const receipts = await json(await request('/api/billing/payments', { as: user }));
    assert.equal(receipts.body.payments.length, 1);
    assert.equal(receipts.body.payments[0].status, 'paid');
    assert.match(receipts.body.payments[0].receiptNumber, /^FB-\d{4}-[0-9A-F]{8}$/);
    assert.ok(await models.Notification.exists({ userId: user._id, type: 'payment_received' }));

    // The same webhook again changes nothing; a forged one is refused
    assert.equal((await postHook('payos', hook)).body.result, 'duplicate');
    assert.equal((await postHook('payos', payosHook({ orderCode: payment.orderCode, amount: 259000 }, 'forged'))).status, 400);
    assert.equal(await models.Payment.countDocuments({ status: 'paid' }), 1);
});

test('PayOS: paying again before the end extends from the end date; the return page catches a missed webhook', async () => {
    const { user, ws } = await freeOwner();
    const first = await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos' });
    const p1 = await models.Payment.findById(first.body.checkout.paymentId).lean();
    await postHook('payos', payosHook({ orderCode: p1.orderCode, amount: 199000 }));
    const end1 = (await workspaceOf(ws)).plan.expiresAt;

    // Second payment: the webhook never comes, the return page asks PayOS
    const second = await checkout(user, { planCode: 'pro', interval: 'year', provider: 'payos' });
    const id = second.body.checkout.paymentId;
    await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { createdAt: new Date(Date.now() - 60000) } });
    payosStatus = { status: 'PAID', amount: 1990000 };
    const status = await json(await request(`/api/billing/payments/${id}?refresh=1`, { as: user }));
    assert.equal(status.body.payment.status, 'paid');
    const end2 = (await workspaceOf(ws)).plan.expiresAt;
    const expected = new Date(end1);
    expected.setUTCFullYear(expected.getUTCFullYear() + 1);
    assert.equal(new Date(end2).toISOString(), expected.toISOString());

    // Someone else cannot see it
    const stranger = await createUser();
    assert.equal((await json(await request(`/api/billing/payments/${id}`, { as: stranger }))).status, 404);
});

test('expiry: a plan paid online gets the grace period, then falls back to FREE and keeps the cameras', async () => {
    const { user, ws } = await freeOwner();
    const started = await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos' });
    const p = await models.Payment.findById(started.body.checkout.paymentId).lean();
    await postHook('payos', payosHook({ orderCode: p.orderCode, amount: 199000 }));
    for (let i = 0; i < 5; i++) await createCamera(user, { orgId: ws._id });

    // Ended 3 days ago: still PRO (grace)
    await models.Organization.updateOne({ _id: ws._id }, { $set: { 'plan.expiresAt': new Date(Date.now() - 3 * DAY) } });
    let ent = await myEntitlements(user);
    assert.equal(ent.plan, 'pro');
    assert.equal(ent.grace, true);
    assert.ok(ent.graceUntil);

    // Ended 8 days ago: FREE, nothing deleted, adding is blocked
    await models.Organization.updateOne({ _id: ws._id }, { $set: { 'plan.expiresAt': new Date(Date.now() - 8 * DAY) } });
    ent = await myEntitlements(user);
    assert.equal(ent.plan, 'free');
    assert.equal(ent.expired, true);
    assert.equal(await models.Camera.countDocuments({ orgId: ws._id }), 5);
    assert.equal((await entitlements.checkCameraLimit({ _id: user._id, role: 'user', email: user.email }, ws._id))?.body.code, 'UPGRADE_REQUIRED');

    // A plan the admin assigned by hand has no grace period
    await models.Organization.updateOne({ _id: ws._id }, { $unset: { billing: 1 }, $set: { 'plan.expiresAt': new Date(Date.now() - DAY) } });
    assert.equal((await myEntitlements(user)).plan, 'free');
});

// ---------- Stripe: subscription ----------

test('Stripe: subscription checkout, first invoice, automatic renewal, failed renewal and grace, end', async () => {
    const { user, ws } = await freeOwner();
    const started = await checkout(user, { planCode: 'pro', interval: 'month', provider: 'stripe', currency: 'USD', addonCameras: 1 });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const form = new URLSearchParams(calls.find(c => c.url === '/v1/checkout/sessions').raw);
    assert.equal(form.get('mode'), 'subscription');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '900');
    assert.equal(form.get('line_items[1][price_data][unit_amount]'), '150');
    const paymentId = started.body.checkout.paymentId;
    const meta = { paymentId, workspaceId: String(ws._id), planCode: 'pro', interval: 'month', addonCameras: '1' };

    assert.equal((await stripeHook('checkout.session.completed', { id: 'cs_test_1', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: String(ws._id), metadata: meta })).body.result, 'linked');
    assert.equal((await myEntitlements(user)).plan, 'free');

    const start = Date.now();
    const end = start + 30 * DAY;
    assert.equal((await stripeHook('invoice.paid', invoice({ id: 'in_1', meta, start, end, amount: 1050 }))).body.result, 'applied');
    let doc = await workspaceOf(ws);
    assert.equal(doc.plan.code, 'pro');
    assert.equal(doc.plan.addonCameras, 1);
    assert.equal(new Date(doc.plan.expiresAt).getTime(), Math.floor(end / 1000) * 1000);
    assert.equal(doc.billing.autoRenew, true);
    assert.equal(doc.billing.subscriptionRef, 'sub_1');

    // A second subscription on top is refused
    assert.equal((await checkout(user, { planCode: 'pro', interval: 'year', provider: 'stripe', currency: 'USD' })).body.code, 'ALREADY_SUBSCRIBED');

    // Renewal: a new receipt, a month more
    const end2 = end + 30 * DAY;
    assert.equal((await stripeHook('invoice.paid', invoice({ id: 'in_2', meta, start: end, end: end2, reason: 'subscription_cycle', amount: 1050 }))).body.result, 'applied');
    doc = await workspaceOf(ws);
    assert.equal(new Date(doc.plan.expiresAt).getTime(), Math.floor(end2 / 1000) * 1000);
    assert.equal(await models.Payment.countDocuments({ workspaceId: ws._id, status: 'paid' }), 2);

    // The next renewal fails: past due, plan kept until end + 7 days
    const failed = await stripeHook('invoice.payment_failed', { ...invoice({ id: 'in_3', meta, start: end2, end: end2 + 30 * DAY, reason: 'subscription_cycle', amount: 1050 }), amount_paid: 0 });
    assert.equal(failed.body.result, 'grace');
    doc = await workspaceOf(ws);
    assert.equal(doc.billing.pastDue, true);
    assert.equal(new Date(doc.billing.graceUntil).getTime(), Math.floor(end2 / 1000) * 1000 + 7 * DAY);
    assert.ok(await models.Notification.exists({ userId: user._id, type: 'payment_failed' }));

    // Inside the grace period: still PRO; after it: FREE
    const after2 = new Date(Math.floor(end2 / 1000) * 1000 + 2 * DAY);
    assert.equal((await entitlements.getEntitlements(user, doc, after2)).plan, 'pro');
    assert.equal((await entitlements.getEntitlements(user, doc, new Date(after2.getTime() + 6 * DAY))).plan, 'free');

    // Stripe gives up: no more renewals
    assert.equal((await stripeHook('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', metadata: meta })).body.result, 'ended');
    assert.equal((await workspaceOf(ws)).billing.autoRenew, false);
});

test('Stripe: the owner stops the automatic renewal; the plan runs to its end', async () => {
    const { user, ws } = await freeOwner();
    const started = await checkout(user, { planCode: 'pro', interval: 'month', provider: 'stripe', currency: 'USD' });
    const meta = { paymentId: started.body.checkout.paymentId, workspaceId: String(ws._id), planCode: 'pro', interval: 'month', addonCameras: '0' };
    await stripeHook('invoice.paid', invoice({ id: 'in_9', meta, start: Date.now(), end: Date.now() + 30 * DAY }));
    const stopped = await json(await request('/api/billing/cancel-renewal', { method: 'POST', as: user }));
    assert.equal(stopped.status, 200);
    assert.ok(calls.some(c => c.url === '/v1/subscriptions/sub_1' && new URLSearchParams(c.raw).get('cancel_at_period_end') === 'true'));
    const doc = await workspaceOf(ws);
    assert.equal(doc.billing.autoRenew, false);
    assert.equal(doc.plan.code, 'pro');
    assert.equal((await json(await request('/api/billing/cancel-renewal', { method: 'POST', as: user }))).body.code, 'NOT_RENEWING');
});

// ---------- Upgrade request paid online ----------

test('an upgrade request approved for online payment starts the plan when the owner pays', async () => {
    const admin = await createUser({ role: 'admin' });
    const { user, ws } = await freeOwner();
    const asked = await json(await request('/api/upgrade-requests', { method: 'POST', as: user, body: { targetPlan: 'pro', extraCameras: 3 } }));
    assert.equal(asked.status, 201);
    const id = asked.body.request.id;
    const approved = await json(await request(`/api/admin/upgrade-requests/${id}/approve`, { method: 'POST', as: admin, body: { payOnline: true } }));
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.request.status, 'awaiting_payment');
    assert.equal((await workspaceOf(ws)).plan.code, 'free');

    const started = await checkout(user, { upgradeRequestId: id, interval: 'month', provider: 'payos', planCode: 'enterprise', addonCameras: 99 });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    // What the admin granted, not what the browser sent
    assert.equal(started.body.checkout.planCode, 'pro');
    assert.equal(started.body.checkout.addonCameras, 3);
    const p = await models.Payment.findById(started.body.checkout.paymentId).lean();
    assert.equal(p.source, 'upgrade_request');
    await postHook('payos', payosHook({ orderCode: p.orderCode, amount: 199000 + 3 * 30000 }));

    const doc = await workspaceOf(ws);
    assert.equal(doc.plan.code, 'pro');
    assert.equal(doc.plan.addonCameras, 3);
    const request2 = await models.UpgradeRequest.findById(id).lean();
    assert.equal(request2.status, 'approved');
    assert.equal(request2.paid, true);
});

// ---------- Guards ----------

test('checkout guards: owner only, priced plans, managed plans, no downgrade while running, short payments held', async () => {
    const { user, ws } = await freeOwner();
    const member = await createUser({ email: 'member@example.test' });
    const org = await models.Organization.create({ name: 'Co-op', kind: 'organization', plan: { code: 'free' }, members: [{ userId: user._id, email: user.email, role: 'owner' }, { userId: member._id, email: member.email, role: 'manager' }] });
    const inOrg = { 'X-Workspace-Id': String(org._id) };
    env.APP_MODE = 'hybrid';
    assert.equal((await json(await request('/api/billing/checkout', { method: 'POST', as: member, headers: inOrg, body: { planCode: 'pro', interval: 'month', provider: 'payos' } }))).status, 403);
    env.APP_MODE = 'b2c';

    assert.equal((await checkout(user, { planCode: 'enterprise', interval: 'month', provider: 'payos' })).body.code, 'NOT_FOR_SALE');
    assert.equal((await checkout(user, { planCode: 'free', interval: 'month', provider: 'payos' })).status, 400);
    assert.equal((await checkout(user, { planCode: 'pro', interval: 'week', provider: 'payos' })).status, 400);
    assert.equal((await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos', currency: 'USD' })).status, 400);
    assert.equal((await checkout(user, { planCode: 'pro', interval: 'month', provider: 'paypal' })).status, 400);

    // ENTERPRISE given by the admin with no end date: managed by hand
    await models.Organization.updateOne({ _id: ws._id }, { $set: { plan: { code: 'enterprise' } } });
    assert.equal((await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos' })).body.code, 'MANAGED_PLAN');
    // A running paid ENTERPRISE is not swapped for PRO
    await models.Organization.updateOne({ _id: ws._id }, { $set: { plan: { code: 'enterprise', expiresAt: new Date(Date.now() + 10 * DAY) }, billing: { provider: 'payos' } } });
    assert.equal((await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos' })).body.code, 'DOWNGRADE');

    // Less money than the order: held for the admin, plan unchanged
    await models.Organization.updateOne({ _id: ws._id }, { $set: { plan: { code: 'free' } }, $unset: { billing: 1 } });
    const started = await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos' });
    const p = await models.Payment.findById(started.body.checkout.paymentId).lean();
    assert.equal((await postHook('payos', payosHook({ orderCode: p.orderCode, amount: 1000 }))).body.result, 'review');
    assert.equal((await workspaceOf(ws)).plan.code, 'free');
    assert.equal((await models.Payment.findById(p._id).lean()).status, 'review');
});

test('a live Stripe key is refused unless PAYMENTS_ALLOW_LIVE', async () => {
    const { user } = await freeOwner();
    env.STRIPE_SECRET_KEY = 'sk_live_not_a_real_key';
    try {
        const summary = await json(await request('/api/billing', { as: user }));
        assert.deepEqual(summary.body.providers.map(p => p.name), ['payos']);
        assert.equal((await checkout(user, { planCode: 'pro', interval: 'month', provider: 'stripe', currency: 'USD' })).status, 400);
        assert.equal(calls.filter(c => c.url.startsWith('/v1/')).length, 0);
    } finally {
        env.STRIPE_SECRET_KEY = 'sk_test_billing';
    }
});

test('APP_MODE=b2b keeps manual invoicing: no checkout, webhooks not applied, no pay-online approval', async () => {
    env.APP_MODE = 'b2b';
    const admin = await createUser({ role: 'admin' });
    const owner = await createUser();
    const org = await models.Organization.create({ name: 'Mango Co', kind: 'organization', plan: { code: 'free' }, members: [{ userId: owner._id, email: owner.email, role: 'owner' }] });
    const res = await json(await request('/api/billing/checkout', { method: 'POST', as: owner, body: { planCode: 'pro', interval: 'month', provider: 'payos' } }));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'PAYMENTS_OFF');
    assert.equal((await json(await request('/api/billing', { as: owner }))).body.enabled, false);
    assert.equal((await postHook('payos', payosHook({ orderCode: 5, amount: 199000 }))).body.result, 'disabled');
    assert.equal(calls.length, 0);

    const asked = await json(await request('/api/upgrade-requests', { method: 'POST', as: owner, body: { targetPlan: 'pro' } }));
    const approved = await json(await request(`/api/admin/upgrade-requests/${asked.body.request.id}/approve`, { method: 'POST', as: admin, body: { payOnline: true } }));
    assert.equal(approved.body.code, 'PAYMENTS_OFF');
    assert.equal((await models.Organization.findById(org._id).lean()).plan.code, 'free');
});

// ---------- Admin ----------

test('admin: prices are validated; revenue sums paid payments per currency', async () => {
    const admin = await createUser({ role: 'admin' });
    const bad = await json(await request('/api/admin/plans/pro', { method: 'PUT', as: admin, body: { prices: { VND: { month: -1 } } } }));
    assert.equal(bad.status, 400);
    assert.equal((await json(await request('/api/admin/plans/free', { method: 'PUT', as: admin, body: { prices: { VND: { month: 1000 } } } }))).status, 400);
    assert.equal((await json(await request('/api/admin/plans/pro', { method: 'PUT', as: admin, body: { prices: { EUR: { month: 5 } } } }))).status, 400);
    const plans = await json(await request('/api/plans'));
    assert.equal(plans.body.plans.find(p => p.code === 'pro').prices.VND.month, 199000);

    const { user, ws } = await freeOwner();
    const started = await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos' });
    const p = await models.Payment.findById(started.body.checkout.paymentId).lean();
    await postHook('payos', payosHook({ orderCode: p.orderCode, amount: 199000 }));
    await models.Payment.create({ workspaceId: ws._id, provider: 'stripe', planCode: 'pro', interval: 'month', amount: 900, currency: 'USD', status: 'paid', paidAt: new Date(), reference: 'in_x' });

    const revenue = await json(await request('/api/admin/revenue', { as: admin }));
    assert.equal(revenue.status, 200);
    const totals = Object.fromEntries(revenue.body.totals.map(t => [t.currency, t.amount]));
    assert.deepEqual(totals, { VND: 199000, USD: 900 });
    assert.equal(revenue.body.workspaces.paying, 1);
    assert.equal(revenue.body.payments.length, 2);
    assert.equal((await json(await request('/api/admin/revenue', { as: user }))).status, 403);
});

// ---------- Daily job ----------

test('daily job: renewal reminders once each, unfinished checkouts closed (PayOS asked first)', async () => {
    const { user, ws } = await freeOwner();
    await models.Organization.updateOne({ _id: ws._id }, { $set: { plan: { code: 'pro', expiresAt: new Date(Date.now() + 5 * DAY) }, billing: { provider: 'payos', autoRenew: false } } });
    await billingService.runDaily();
    await billingService.runDaily();
    assert.equal(await models.Notification.countDocuments({ userId: user._id, type: 'plan_expiring' }), 1);

    await models.Organization.updateOne({ _id: ws._id }, { $set: { 'plan.expiresAt': new Date(Date.now() - DAY) } });
    await billingService.runDaily();
    assert.equal(await models.Notification.countDocuments({ userId: user._id, type: 'plan_ended' }), 1);

    // A link opened two days ago and never paid; PayOS says it expired
    const stale = await checkout(user, { planCode: 'pro', interval: 'month', provider: 'payos' });
    await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(stale.body.checkout.paymentId) }, { $set: { createdAt: new Date(Date.now() - 2 * DAY) } });
    payosStatus = { status: 'EXPIRED', amount: 199000 };
    const outcome = await billingService.runDaily();
    assert.equal((await models.Payment.findById(stale.body.checkout.paymentId).lean()).status, 'canceled');
    assert.equal(outcome.closed, 0);
});
