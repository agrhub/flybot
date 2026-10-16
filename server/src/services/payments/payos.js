const crypto = require('crypto');
const axios = require('axios');
const {
    EVENT_TYPES, WebhookSignatureError, ProviderError, normalizedEvent, parseJson
} = require('./provider');

/**
 * PayOS (payos.vn): VietQR bank transfer payment links, Vietnam, VND only. Plain REST, no SDK.
 *
 * PayOS has no recurring billing: every period is a new payment link (a renewal reminder sends
 * the owner to a fresh checkout). Webhooks arrive only for paid links.
 *
 *  - create link: POST /v2/payment-requests, headers x-client-id / x-api-key, body signed with
 *    HMAC-SHA256(checksumKey, "amount=..&cancelUrl=..&description=..&orderCode=..&returnUrl=..")
 *  - webhook: { code, desc, success, data, signature }, signature = HMAC-SHA256(checksumKey,
 *    data's keys sorted, "key=value" joined by "&", null -> "", arrays as JSON)
 */
const NAME = 'payos';
// Transfer content shown in the buyer's banking app; banks not linked through PayOS keep 9 chars
const DESCRIPTION_MAX = 9;

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');

function sortKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
}

/** The string PayOS signs for webhook / response `data` objects. */
function canonicalData(data) {
    return Object.keys(data).sort()
        .filter((key) => data[key] !== undefined)
        .map((key) => {
            let value = data[key];
            if (Array.isArray(value)) value = JSON.stringify(value.map(sortKeys));
            else if (value && typeof value === 'object') value = JSON.stringify(sortKeys(value));
            if (value === null || value === 'null' || value === 'undefined') value = '';
            return `${key}=${value}`;
        })
        .join('&');
}

/** The string PayOS signs when creating a payment link (these five fields only, sorted). */
function canonicalPaymentRequest({ amount, cancelUrl, description, orderCode, returnUrl }) {
    return `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
}

function safeEqualHex(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** A positive integer PayOS accepts as orderCode, unique enough per millisecond. */
function newOrderCode(now = Date.now()) {
    return now * 1000 + crypto.randomInt(1000);
}

/** "2023-02-04 18:25:00" (Vietnam time) -> Date */
function parseVnTime(text) {
    if (!text) return null;
    const date = new Date(`${String(text).replace(' ', 'T')}+07:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Short transfer content, e.g. "FBPROM" for PRO monthly. */
function transferDescription(planCode, interval) {
    const code = String(planCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return `FB${code}${interval === 'year' ? 'Y' : 'M'}`.slice(0, DESCRIPTION_MAX);
}

function createPayosProvider(config) {
    const { clientId, apiKey, checksumKey, baseUrl, linkTtlMinutes } = config;
    const http = axios.create({
        baseURL: baseUrl,
        timeout: 15000,
        headers: { 'x-client-id': clientId, 'x-api-key': apiKey, 'Content-Type': 'application/json' }
    });

    function assertConfigured() {
        if (!clientId || !apiKey || !checksumKey) throw new ProviderError(NAME, 'PAYOS_CLIENT_ID, PAYOS_API_KEY and PAYOS_CHECKSUM_KEY are required');
    }

    async function call(method, url, data) {
        let res;
        try {
            res = await http.request({ method, url, data });
        } catch (err) {
            throw new ProviderError(NAME, err.response?.data?.desc || err.message, err.response?.data);
        }
        const body = res.data || {};
        if (body.code !== '00' || !body.data) throw new ProviderError(NAME, body.desc || `code ${body.code}`, body);
        // Responses carry a signature over `data` too; an unsigned or wrongly signed answer is not trusted
        if (body.signature && !safeEqualHex(hmac(checksumKey, canonicalData(body.data)), body.signature)) {
            throw new ProviderError(NAME, 'response signature mismatch');
        }
        return body.data;
    }

    return {
        name: NAME,
        recurring: false,
        currencies: ['VND'],

        isConfigured: () => Boolean(clientId && apiKey && checksumKey),

        async createCheckout(order) {
            assertConfigured();
            if (String(order.currency || 'VND').toUpperCase() !== 'VND') throw new ProviderError(NAME, 'only VND is supported');
            if (!Number.isInteger(order.amount) || order.amount <= 0) throw new ProviderError(NAME, 'amount must be a positive integer (VND)');
            const orderCode = order.orderCode || newOrderCode();
            const expiresAt = new Date(Date.now() + linkTtlMinutes * 60000);
            const body = {
                orderCode,
                amount: order.amount,
                description: transferDescription(order.planCode, order.interval),
                returnUrl: order.returnUrl,
                cancelUrl: order.cancelUrl,
                buyerEmail: order.customerEmail || undefined,
                items: [{ name: `FlyBot ${order.planCode} (${order.interval})`, quantity: 1, price: order.amount }],
                expiredAt: Math.floor(expiresAt.getTime() / 1000)
            };
            body.signature = hmac(checksumKey, canonicalPaymentRequest(body));
            const data = await call('post', '/v2/payment-requests', body);
            return {
                checkoutUrl: data.checkoutUrl,
                checkoutRef: data.paymentLinkId,
                orderCode,
                qrCode: data.qrCode || null,
                expiresAt
            };
        },

        /** Status of a payment link (for the return page): PENDING, PAID, CANCELLED, EXPIRED... */
        async getCheckout(orderCodeOrLinkId) {
            assertConfigured();
            const data = await call('get', `/v2/payment-requests/${encodeURIComponent(orderCodeOrLinkId)}`);
            return { status: data.status, amount: data.amount, amountPaid: data.amountPaid, orderCode: data.orderCode };
        },

        verifyWebhook(rawBody) {
            if (!checksumKey) throw new WebhookSignatureError('PayOS checksum key is not set');
            const payload = parseJson(rawBody);
            if (!payload || typeof payload.data !== 'object' || !payload.data || !payload.signature) {
                throw new WebhookSignatureError('PayOS webhook without data or signature');
            }
            if (!safeEqualHex(hmac(checksumKey, canonicalData(payload.data)), payload.signature)) {
                throw new WebhookSignatureError('PayOS webhook signature mismatch');
            }
            return payload;
        },

        parseEvent(payload) {
            const data = payload.data || {};
            const paid = payload.code === '00' && data.code === '00';
            return normalizedEvent({
                provider: NAME,
                eventId: `${NAME}:${data.orderCode}:${data.reference || data.paymentLinkId || ''}`,
                type: paid ? EVENT_TYPES.SUCCEEDED : EVENT_TYPES.FAILED,
                reference: String(data.orderCode),
                orderCode: Number(data.orderCode),
                checkoutRef: data.paymentLinkId || null,
                amount: Number(data.amount),
                currency: String(data.currency || 'VND').toUpperCase(),
                paidAt: paid ? (parseVnTime(data.transactionDateTime) || new Date()) : null,
                failureReason: paid ? null : (data.desc || payload.desc || 'failed')
            });
        }
    };
}

module.exports = {
    createPayosProvider,
    canonicalData,
    canonicalPaymentRequest,
    transferDescription,
    newOrderCode,
    parseVnTime
};
