/**
 * Payments: PayOS and Stripe adapters (request signing, webhook signatures, event mapping) and
 * the provider-neutral payment service (activate, extend, renew, fail into grace, end), with
 * local stub servers for the provider APIs and an in-memory Payment model. No network, no DB.
 *
 * Webhook payloads follow the shapes in each provider's documentation; their signatures are
 * computed here with test keys (the known-answer strings are written out by hand).
 */
require('./isolation');
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const { EVENT_TYPES, WebhookSignatureError, ProviderError } = require('../src/services/payments/provider');
const payos = require('../src/services/payments/payos');
const stripe = require('../src/services/payments/stripe');
const { createProviders } = require('../src/services/payments');
const { createPaymentService, addInterval, planState } = require('../src/services/payments/paymentService');
const Payment = require('../src/models/Payment');

const PAYOS_CHECKSUM = 'test-payos-checksum-key';
const STRIPE_WHSEC = 'whsec_test_secret';
const hmacHex = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');
const WORKSPACE = '64d000000000000000000001';
const DAY = 24 * 60 * 60 * 1000;

// ---------- Provider API stubs ----------
let stub;
let stubUrl;
let calls;
let answer; // (req) => { status, body }

before(async () => {
    stub = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const call = { method: req.method, url: req.url, headers: req.headers, raw };
            calls.push(call);
            const { status = 200, body } = answer(call);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${stub.address().port}`;
});
after(() => new Promise((resolve) => stub.close(resolve)));
beforeEach(() => {
    calls = [];
    answer = () => ({ status: 404, body: {} });
});

function testConfig(overrides = {}) {
    return {
        appMode: 'b2c',
        enabled: true,
        allowLive: false,
        graceDays: 7,
        payos: { clientId: 'test-client', apiKey: 'test-api-key', checksumKey: PAYOS_CHECKSUM, baseUrl: stubUrl, linkTtlMinutes: 60 },
        stripe: { secretKey: 'sk_test_123', webhookSecret: STRIPE_WHSEC, baseUrl: stubUrl, toleranceSeconds: 300 },
        ...overrides
    };
}

// A PayOS "payment link created" answer, signed like the real API signs its responses
function payosLinkAnswer(call) {
    const sent = JSON.parse(call.raw);
    const data = {
        bin: '970422',
        accountNumber: '0123456789',
        accountName: 'AGRIHUB',
        amount: sent.amount,
        description: sent.description,
        orderCode: sent.orderCode,
        currency: 'VND',
        paymentLinkId: 'plink_test_1',
        status: 'PENDING',
        checkoutUrl: `https://pay.payos.vn/web/plink_test_1`,
        qrCode: '00020101021238570010A000000727'
    };
    return { body: { code: '00', desc: 'success', data, signature: hmacHex(PAYOS_CHECKSUM, payos.canonicalData(data)) } };
}

// A PayOS webhook (shape from the PayOS docs) signed with the test checksum key
function payosWebhook(data, key = PAYOS_CHECKSUM) {
    const full = {
        orderCode: 123,
        amount: 3000,
        description: 'VQRIO123',
        accountNumber: '12345678',
        reference: 'TF230204212323',
        transactionDateTime: '2023-02-04 18:25:00',
        currency: 'VND',
        paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
        code: '00',
        desc: 'success',
        counterAccountBankId: '',
        counterAccountBankName: '',
        counterAccountName: '',
        counterAccountNumber: '',
        virtualAccountName: '',
        virtualAccountNumber: '',
        ...data
    };
    return JSON.stringify({ code: '00', desc: 'success', success: true, data: full, signature: hmacHex(key, payos.canonicalData(full)) });
}

// A Stripe event (shape from the Stripe docs) and its Stripe-Signature header
function stripeEvent(type, object, id = `evt_${crypto.randomBytes(6).toString('hex')}`) {
    const raw = JSON.stringify({ id, object: 'event', type, created: 1792000000, data: { object } });
    return { raw, headers: { 'stripe-signature': stripe.signPayload(raw, STRIPE_WHSEC) } };
}

function stripeInvoice({ id, subscription = 'sub_test_1', metadata, billingReason = 'subscription_create', amount = 1900, start, end, newShape = true }) {
    const invoice = {
        id,
        object: 'invoice',
        customer: 'cus_test_1',
        currency: 'usd',
        amount_due: amount,
        amount_paid: amount,
        billing_reason: billingReason,
        number: `INV-${id}`,
        hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
        attempt_count: 1,
        next_payment_attempt: null,
        status_transitions: { paid_at: Math.floor(start / 1000) },
        lines: { data: [{ period: { start: Math.floor(start / 1000), end: Math.floor(end / 1000) } }] }
    };
    if (newShape) invoice.parent = { type: 'subscription_details', subscription_details: { subscription, metadata } };
    else Object.assign(invoice, { subscription, subscription_details: { metadata } });
    return invoice;
}

// ---------- In-memory Payment model (only what paymentService uses) ----------
function memoryPaymentModel() {
    const rows = [];
    let seq = 0;
    const matches = (row, filter) => Object.entries(filter).every(([k, v]) => String(row[k]) === String(v));
    const wrap = (row) => {
        Object.defineProperty(row, 'save', { value: async () => row, enumerable: false });
        return row;
    };
    return {
        rows,
        async create(data) {
            seq += 1;
            const row = wrap({
                _id: (0x64e000000000000000000000n + BigInt(seq)).toString(16),
                status: 'pending', events: [], addonCameras: 0, orderCode: null, reference: null,
                subscriptionRef: null, customerRef: null, receiptNumber: null, createdAt: seq,
                ...data
            });
            rows.push(row);
            return row;
        },
        async findById(id) {
            return rows.find((r) => r._id === String(id)) || null;
        },
        async findOne(filter, _projection, options = {}) {
            const found = rows.filter((r) => matches(r, filter));
            if (options.sort?.createdAt === -1) found.reverse();
            return found[0] || null;
        }
    };
}

function recordingBridge(paidThroughValue = null) {
    const bridge = {
        applied: [],
        renewal: [],
        through: paidThroughValue,
        async applyPaidPeriod(workspaceId, planCode, addonCameras, until, context) {
            bridge.applied.push({ workspaceId, planCode, addonCameras, until, context });
            bridge.through = until;
        },
        async paidThrough() {
            return bridge.through;
        },
        async setRenewalState(workspaceId, state) {
            bridge.renewal.push({ workspaceId, ...state });
        }
    };
    return bridge;
}

function serviceFor({ config = testConfig(), bridge = recordingBridge(), now } = {}) {
    const providers = createProviders(config);
    const model = memoryPaymentModel();
    const service = createPaymentService({ Payment: model, bridge, config, getProvider: (n) => providers[n] || null, now });
    return { service, model, bridge, providers };
}

// ---------- PayOS ----------
describe('PayOS adapter', () => {
    test('canonical data string: keys sorted, null and empty as blank (known answer)', () => {
        const data = { orderCode: 7, amount: 2000, desc: null, code: '00', accountNumber: '', skipped: undefined };
        assert.equal(payos.canonicalData(data), 'accountNumber=&amount=2000&code=00&desc=&orderCode=7');
    });

    test('verifies a signed webhook and maps it to payment.succeeded', () => {
        const provider = createProviders(testConfig()).payos;
        const payload = provider.verifyWebhook(payosWebhook({ orderCode: 1792000000123, amount: 199000 }));
        const event = provider.parseEvent(payload);
        assert.equal(event.type, EVENT_TYPES.SUCCEEDED);
        assert.equal(event.orderCode, 1792000000123);
        assert.equal(event.amount, 199000);
        assert.equal(event.currency, 'VND');
        // 18:25 in Vietnam (UTC+7)
        assert.equal(event.paidAt.toISOString(), '2023-02-04T11:25:00.000Z');
        assert.equal(event.eventId, 'payos:1792000000123:TF230204212323');
    });

    test('the signature is HMAC-SHA256 over the documented string (known answer)', () => {
        const raw = payosWebhook({});
        const expected = hmacHex(PAYOS_CHECKSUM, 'accountNumber=12345678&amount=3000&code=00&counterAccountBankId=&counterAccountBankName='
            + '&counterAccountName=&counterAccountNumber=&currency=VND&desc=success&description=VQRIO123&orderCode=123'
            + '&paymentLinkId=124c33293c43417ab7879e14c8d9eb18&reference=TF230204212323&transactionDateTime=2023-02-04 18:25:00'
            + '&virtualAccountName=&virtualAccountNumber=');
        assert.equal(JSON.parse(raw).signature, expected);
    });

    test('rejects a tampered amount, a wrong key, a missing signature and a non-JSON body', () => {
        const provider = createProviders(testConfig()).payos;
        const tampered = JSON.parse(payosWebhook({ amount: 3000 }));
        tampered.data.amount = 3;
        assert.throws(() => provider.verifyWebhook(JSON.stringify(tampered)), WebhookSignatureError);
        assert.throws(() => provider.verifyWebhook(payosWebhook({}, 'another-key')), WebhookSignatureError);
        const unsigned = JSON.parse(payosWebhook({}));
        delete unsigned.signature;
        assert.throws(() => provider.verifyWebhook(JSON.stringify(unsigned)), WebhookSignatureError);
        assert.throws(() => provider.verifyWebhook('not json'), WebhookSignatureError);
    });

    test('creates a signed payment link with the API key headers', async () => {
        answer = payosLinkAnswer;
        const provider = createProviders(testConfig()).payos;
        const out = await provider.createCheckout({
            orderCode: 1792000000555, amount: 199000, currency: 'VND', planCode: 'pro', interval: 'month',
            returnUrl: 'https://app.example.test/billing/return', cancelUrl: 'https://app.example.test/pricing'
        });
        assert.equal(calls.length, 1);
        const [call] = calls;
        assert.equal(call.method, 'POST');
        assert.equal(call.url, '/v2/payment-requests');
        assert.equal(call.headers['x-client-id'], 'test-client');
        assert.equal(call.headers['x-api-key'], 'test-api-key');
        const sent = JSON.parse(call.raw);
        assert.equal(sent.description, 'FBPROM');
        assert.equal(sent.signature, hmacHex(PAYOS_CHECKSUM,
            'amount=199000&cancelUrl=https://app.example.test/pricing&description=FBPROM&orderCode=1792000000555&returnUrl=https://app.example.test/billing/return'));
        assert.equal(out.checkoutRef, 'plink_test_1');
        assert.equal(out.orderCode, 1792000000555);
        assert.ok(out.qrCode);
    });

    test('refuses a response with a wrong signature, a non-VND currency and an unconfigured account', async () => {
        answer = (call) => {
            const ok = payosLinkAnswer(call);
            ok.body.signature = 'f'.repeat(64);
            return ok;
        };
        const provider = createProviders(testConfig()).payos;
        const order = { amount: 199000, currency: 'VND', planCode: 'pro', interval: 'year', returnUrl: 'https://a.test/r', cancelUrl: 'https://a.test/c' };
        await assert.rejects(provider.createCheckout(order), ProviderError);
        await assert.rejects(provider.createCheckout({ ...order, currency: 'USD' }), ProviderError);
        const bare = createProviders(testConfig({ payos: { ...testConfig().payos, checksumKey: '' } })).payos;
        assert.equal(bare.isConfigured(), false);
        await assert.rejects(bare.createCheckout(order), ProviderError);
    });

    test('transfer description stays within 9 characters', () => {
        assert.equal(payos.transferDescription('ENTERPRISE', 'year'), 'FBENTERPR');
        assert.equal(payos.transferDescription('pro', 'year'), 'FBPROY');
    });
});

// ---------- Stripe ----------
describe('Stripe adapter', () => {
    test('accepts a valid Stripe-Signature, also among several v1 values', () => {
        const provider = createProviders(testConfig()).stripe;
        const { raw, headers } = stripeEvent('invoice.paid', { id: 'in_1' });
        assert.equal(provider.verifyWebhook(raw, headers).type, 'invoice.paid');
        const t = stripe.parseSignatureHeader(headers['stripe-signature']).timestamp;
        const multi = `t=${t},v1=${'0'.repeat(64)},v1=${hmacHex(STRIPE_WHSEC, `${t}.${raw}`)}`;
        assert.equal(provider.verifyWebhook(Buffer.from(raw), { 'stripe-signature': multi }).id, JSON.parse(raw).id);
    });

    test('rejects a tampered body, a wrong secret, an old timestamp and a missing header', () => {
        const provider = createProviders(testConfig()).stripe;
        const { raw, headers } = stripeEvent('invoice.paid', { id: 'in_1', amount_paid: 1900 });
        assert.throws(() => provider.verifyWebhook(raw.replace('1900', '1'), headers), WebhookSignatureError);
        assert.throws(() => provider.verifyWebhook(raw, { 'stripe-signature': stripe.signPayload(raw, 'whsec_other') }), WebhookSignatureError);
        const old = Math.floor(Date.now() / 1000) - 3600;
        assert.throws(() => provider.verifyWebhook(raw, { 'stripe-signature': stripe.signPayload(raw, STRIPE_WHSEC, old) }), WebhookSignatureError);
        assert.throws(() => provider.verifyWebhook(raw, {}), WebhookSignatureError);
    });

    test('maps invoice.paid in both API shapes, renewals and failures', () => {
        const provider = createProviders(testConfig()).stripe;
        const meta = { paymentId: 'p1', workspaceId: WORKSPACE, planCode: 'pro', interval: 'month', addonCameras: '2' };
        const start = Date.UTC(2026, 9, 16);
        const end = Date.UTC(2026, 10, 16);
        for (const newShape of [true, false]) {
            const event = provider.parseEvent(JSON.parse(stripeEvent('invoice.paid', stripeInvoice({ id: 'in_1', metadata: meta, start, end, newShape })).raw));
            assert.equal(event.type, EVENT_TYPES.SUCCEEDED);
            assert.equal(event.subscriptionRef, 'sub_test_1');
            assert.equal(event.workspaceId, WORKSPACE);
            assert.equal(event.addonCameras, 2);
            assert.equal(event.currency, 'USD');
            assert.equal(event.periodEnd.getTime(), end);
            assert.equal(event.renewal, false);
        }
        const renewal = provider.parseEvent(JSON.parse(stripeEvent('invoice.paid', stripeInvoice({ id: 'in_2', metadata: meta, billingReason: 'subscription_cycle', start, end })).raw));
        assert.equal(renewal.renewal, true);
        const failed = provider.parseEvent(JSON.parse(stripeEvent('invoice.payment_failed', { ...stripeInvoice({ id: 'in_3', metadata: meta, billingReason: 'subscription_cycle', start, end }), amount_paid: 0, attempt_count: 2, next_payment_attempt: 1793000000 }).raw));
        assert.equal(failed.type, EVENT_TYPES.FAILED);
        assert.equal(failed.attempt, 2);
        assert.equal(failed.nextRetryAt.getTime(), 1793000000 * 1000);
        const ended = provider.parseEvent(JSON.parse(stripeEvent('customer.subscription.deleted', { id: 'sub_test_1', metadata: meta, ended_at: 1793000000 }).raw));
        assert.equal(ended.type, EVENT_TYPES.SUBSCRIPTION_ENDED);
        assert.equal(provider.parseEvent(JSON.parse(stripeEvent('charge.refunded', { id: 'ch_1' }).raw)).type, EVENT_TYPES.IGNORED);
    });

    test('creates a subscription checkout: plan line, add-on line, metadata on the subscription', async () => {
        answer = () => ({ body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: 1792086400 } });
        const provider = createProviders(testConfig()).stripe;
        const out = await provider.createCheckout({
            paymentId: 'p1', workspaceId: WORKSPACE, planCode: 'pro', interval: 'year', addonCameras: 3,
            amount: 19000 + 3 * 1200, addonAmount: 1200, currency: 'USD', customerEmail: 'owner@example.test',
            returnUrl: 'https://app.example.test/billing/return?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://app.example.test/pricing'
        });
        const [call] = calls;
        assert.equal(call.url, '/v1/checkout/sessions');
        assert.equal(call.headers.authorization, 'Bearer sk_test_123');
        const form = new URLSearchParams(call.raw);
        assert.equal(form.get('mode'), 'subscription');
        assert.equal(form.get('client_reference_id'), WORKSPACE);
        assert.equal(form.get('line_items[0][price_data][unit_amount]'), '19000');
        assert.equal(form.get('line_items[0][price_data][recurring][interval]'), 'year');
        assert.equal(form.get('line_items[1][quantity]'), '3');
        assert.equal(form.get('line_items[1][price_data][unit_amount]'), '1200');
        assert.equal(form.get('subscription_data[metadata][paymentId]'), 'p1');
        assert.equal(form.get('subscription_data[metadata][addonCameras]'), '3');
        assert.equal(form.get('success_url'), 'https://app.example.test/billing/return?session_id={CHECKOUT_SESSION_ID}');
        assert.equal(out.checkoutRef, 'cs_test_1');
    });

    test('a live key is refused unless PAYMENTS_ALLOW_LIVE', async () => {
        const live = testConfig({ stripe: { ...testConfig().stripe, secretKey: 'sk_live_abc' } });
        const provider = createProviders(live).stripe;
        assert.equal(provider.isConfigured(), false);
        await assert.rejects(provider.createCheckout({ amount: 100, currency: 'USD', interval: 'month' }), /PAYMENTS_ALLOW_LIVE/);
        assert.equal(calls.length, 0);
        assert.equal(createProviders({ ...live, allowLive: true }).stripe.isConfigured(), true);
    });

    test('form encoding of nested objects and arrays', () => {
        assert.equal(stripe.formEncode({ a: { b: [{ c: 1 }, { c: 'x y' }] }, skip: null }).toString(), 'a%5Bb%5D%5B0%5D%5Bc%5D=1&a%5Bb%5D%5B1%5D%5Bc%5D=x+y');
    });
});

// ---------- Periods ----------
describe('periods and plan state', () => {
    test('adds months and years, keeping month ends', () => {
        assert.equal(addInterval(new Date('2027-01-31T10:00:00Z'), 'month').toISOString(), '2027-02-28T10:00:00.000Z');
        assert.equal(addInterval(new Date('2028-02-29T00:00:00Z'), 'year').toISOString(), '2029-02-28T00:00:00.000Z');
        assert.equal(addInterval(new Date('2026-10-16T00:00:00Z'), 'month').toISOString(), '2026-11-16T00:00:00.000Z');
    });

    test('active, then grace, then expired (back to FREE)', () => {
        const expiresAt = new Date('2026-11-16T00:00:00Z');
        assert.equal(planState({ expiresAt: null }), 'free');
        assert.equal(planState({ expiresAt, now: new Date('2026-11-15T00:00:00Z'), graceDays: 7 }), 'active');
        assert.equal(planState({ expiresAt, now: new Date('2026-11-20T00:00:00Z'), graceDays: 7 }), 'grace');
        assert.equal(planState({ expiresAt, now: new Date('2026-11-24T00:00:00Z'), graceDays: 7 }), 'expired');
        assert.equal(planState({ expiresAt, graceUntil: new Date('2026-11-30T00:00:00Z'), now: new Date('2026-11-24T00:00:00Z') }), 'grace');
    });
});

// ---------- Payment service ----------
describe('payment service', () => {
    const NOW = new Date('2026-10-16T05:00:00Z');
    const now = () => new Date(NOW);
    const order = {
        provider: 'payos', workspaceId: WORKSPACE, userId: '64b000000000000000000001', planCode: 'pro', interval: 'month',
        addonCameras: 0, amount: 199000, currency: 'VND', returnUrl: 'https://app.example.test/billing/return', cancelUrl: 'https://app.example.test/pricing'
    };

    test('PayOS: a FREE workspace pays and gets PRO for a month; a replayed webhook changes nothing', async () => {
        answer = payosLinkAnswer;
        const { service, model, bridge } = serviceFor({ now });
        const checkout = await service.startCheckout(order);
        assert.match(checkout.checkoutUrl, /^https:\/\/pay\.payos\.vn\//);
        const [payment] = model.rows;
        assert.equal(payment.status, 'pending');
        assert.ok(payment.orderCode > 0);

        const hook = payosWebhook({ orderCode: payment.orderCode, amount: 199000, transactionDateTime: '2026-10-16 12:00:00' });
        const outcome = await service.handleWebhook('payos', hook, {});
        assert.equal(outcome.result, 'applied');
        assert.equal(payment.status, 'paid');
        assert.match(payment.receiptNumber, /^FB-2026-[0-9A-F]{8}$/);
        assert.equal(bridge.applied.length, 1);
        assert.deepEqual(
            { ...bridge.applied[0], context: undefined },
            { workspaceId: WORKSPACE, planCode: 'pro', addonCameras: 0, until: new Date('2026-11-16T05:00:00Z'), context: undefined }
        );
        assert.equal(bridge.renewal.at(-1).autoRenew, false);

        assert.equal((await service.handleWebhook('payos', hook, {})).result, 'duplicate');
        assert.equal(bridge.applied.length, 1);
    });

    test('PayOS: paying again before expiry extends from the current end, not from today', async () => {
        answer = payosLinkAnswer;
        const bridge = recordingBridge(new Date('2026-11-10T00:00:00Z'));
        const { service, model } = serviceFor({ bridge, now });
        await service.startCheckout({ ...order, interval: 'year', amount: 1990000 });
        const hook = payosWebhook({ orderCode: model.rows[0].orderCode, amount: 1990000 });
        await service.handleWebhook('payos', hook, {});
        assert.equal(bridge.applied[0].until.toISOString(), '2027-11-10T00:00:00.000Z');
    });

    test('PayOS: less money than ordered is held for review and does not change the plan', async () => {
        answer = payosLinkAnswer;
        const { service, model, bridge } = serviceFor({ now });
        await service.startCheckout(order);
        const outcome = await service.handleWebhook('payos', payosWebhook({ orderCode: model.rows[0].orderCode, amount: 1000 }), {});
        assert.equal(outcome.result, 'review');
        assert.equal(model.rows[0].status, 'review');
        assert.equal(bridge.applied.length, 0);
    });

    test('a bad signature throws and records nothing; an unknown order is acknowledged', async () => {
        const { service, model, bridge } = serviceFor({ now });
        await assert.rejects(service.handleWebhook('payos', payosWebhook({}, 'wrong-key'), {}), WebhookSignatureError);
        // PayOS sends a sample (orderCode 123) when the webhook URL is confirmed
        assert.equal((await service.handleWebhook('payos', payosWebhook({}), {})).result, 'unknown_payment');
        assert.equal(model.rows.length, 0);
        assert.equal(bridge.applied.length, 0);
        assert.equal((await service.handleWebhook('paypal', '{}', {})).result, 'unknown_provider');
    });

    test('Stripe: checkout, first invoice, renewal, failed renewal into grace, subscription ended', async () => {
        answer = () => ({ body: { id: 'cs_test_9', url: 'https://checkout.stripe.com/c/pay/cs_test_9' } });
        const { service, model, bridge } = serviceFor({ now });
        await service.startCheckout({ ...order, provider: 'stripe', currency: 'USD', amount: 1900 + 2 * 300, addonAmount: 300, addonCameras: 2 });
        const first = model.rows[0];
        const meta = { paymentId: first._id, workspaceId: WORKSPACE, planCode: 'pro', interval: 'month', addonCameras: '2' };

        // checkout.session.completed only links the subscription
        const completed = stripeEvent('checkout.session.completed', { id: 'cs_test_9', mode: 'subscription', subscription: 'sub_9', customer: 'cus_9', client_reference_id: WORKSPACE, metadata: meta });
        assert.equal((await service.handleWebhook('stripe', completed.raw, completed.headers)).result, 'linked');
        assert.equal(first.subscriptionRef, 'sub_9');
        assert.equal(bridge.applied.length, 0);

        const p1 = [Date.UTC(2026, 9, 16), Date.UTC(2026, 10, 16)];
        const paid = stripeEvent('invoice.paid', stripeInvoice({ id: 'in_first', subscription: 'sub_9', metadata: meta, amount: 2500, start: p1[0], end: p1[1] }));
        assert.equal((await service.handleWebhook('stripe', paid.raw, paid.headers)).result, 'applied');
        assert.equal(first.status, 'paid');
        assert.equal(first.reference, 'in_first');
        assert.equal(bridge.applied[0].until.getTime(), p1[1]);
        assert.equal(bridge.applied[0].addonCameras, 2);
        assert.equal(bridge.renewal.at(-1).autoRenew, true);

        // Next month Stripe charges on its own: a new receipt, the plan runs a month longer
        const p2 = [p1[1], Date.UTC(2026, 11, 16)];
        const renewed = stripeEvent('invoice.paid', stripeInvoice({ id: 'in_second', subscription: 'sub_9', metadata: meta, amount: 2500, billingReason: 'subscription_cycle', start: p2[0], end: p2[1] }));
        assert.equal((await service.handleWebhook('stripe', renewed.raw, renewed.headers)).result, 'applied');
        assert.equal(model.rows.length, 2);
        assert.equal(model.rows[1].source, 'renewal');
        assert.equal(model.rows[1].status, 'paid');
        assert.equal(bridge.applied[1].until.getTime(), p2[1]);

        // The third month's card fails: past due, plan kept until the period end + 7 days
        const p3 = [p2[1], Date.UTC(2027, 0, 16)];
        const failed = stripeEvent('invoice.payment_failed', { ...stripeInvoice({ id: 'in_third', subscription: 'sub_9', metadata: meta, amount: 2500, billingReason: 'subscription_cycle', start: p3[0], end: p3[1] }), amount_paid: 0 });
        const failOutcome = await service.handleWebhook('stripe', failed.raw, failed.headers);
        assert.equal(failOutcome.result, 'grace');
        assert.equal(failOutcome.graceUntil.getTime(), p2[1] + 7 * DAY);
        assert.equal(bridge.renewal.at(-1).pastDue, true);
        assert.equal(bridge.applied.length, 2);
        assert.equal(planState({ expiresAt: bridge.through, graceUntil: failOutcome.graceUntil, now: new Date(p2[1] + 3 * DAY) }), 'grace');
        assert.equal(planState({ expiresAt: bridge.through, graceUntil: failOutcome.graceUntil, now: new Date(p2[1] + 8 * DAY) }), 'expired');

        // Stripe gives up and deletes the subscription: no more renewals, data untouched
        const ended = stripeEvent('customer.subscription.deleted', { id: 'sub_9', customer: 'cus_9', metadata: meta, ended_at: Math.floor((p2[1] + 8 * DAY) / 1000) });
        assert.equal((await service.handleWebhook('stripe', ended.raw, ended.headers)).result, 'ended');
        assert.equal(bridge.renewal.at(-1).autoRenew, false);
        assert.equal(model.rows.length, 3);
        assert.deepEqual(model.rows.map((r) => r.status), ['paid', 'paid', 'failed']);
    });

    test('Stripe: a failed first payment does not start a grace period', async () => {
        answer = () => ({ body: { id: 'cs_test_10', url: 'https://checkout.stripe.com/c/pay/cs_test_10' } });
        const { service, model, bridge } = serviceFor({ now });
        await service.startCheckout({ ...order, provider: 'stripe', currency: 'USD', amount: 1900 });
        const meta = { paymentId: model.rows[0]._id, workspaceId: WORKSPACE, planCode: 'pro', interval: 'month', addonCameras: '0' };
        const failed = stripeEvent('invoice.payment_failed', stripeInvoice({ id: 'in_x', metadata: meta, start: Date.now(), end: Date.now() + 30 * DAY }));
        assert.equal((await service.handleWebhook('stripe', failed.raw, failed.headers)).result, 'failed');
        assert.equal(bridge.renewal.length, 0);
    });

    test('b2b mode keeps manual invoicing: no checkout, webhooks not applied', async () => {
        const { service, bridge } = serviceFor({ config: testConfig({ appMode: 'b2b' }), now });
        await assert.rejects(service.startCheckout(order), (err) => err.status === 403);
        assert.equal((await service.handleWebhook('payos', payosWebhook({}), {})).result, 'disabled');
        assert.equal(bridge.applied.length, 0);
        assert.equal(calls.length, 0);
    });

    test('a provider error marks the checkout failed', async () => {
        answer = () => ({ status: 400, body: { code: '20', desc: 'invalid request' } });
        const { service, model } = serviceFor({ now });
        await assert.rejects(service.startCheckout(order), ProviderError);
        assert.equal(model.rows[0].status, 'failed');
    });
});

test('Payment model validates a receipt row', () => {
    const doc = new Payment({ workspaceId: WORKSPACE, provider: 'payos', planCode: 'PRO', interval: 'month', amount: 199000, currency: 'vnd' });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.planCode, 'pro');
    assert.equal(doc.currency, 'VND');
    assert.ok(new Payment({ workspaceId: WORKSPACE, provider: 'cash', planCode: 'pro', interval: 'week', amount: 1, currency: 'VND' }).validateSync());
});
