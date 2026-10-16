const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const axios = require('axios');
const { Webhook, User } = require('../models');

/**
 * Signed webhook deliveries of a user's alerts.
 *
 * Body: { id, event, createdAt, deviceSerial, severity, params }
 * Headers: X-FlyBot-Event, X-FlyBot-Timestamp (unix seconds) and
 * X-FlyBot-Signature: sha256=HMAC_SHA256(secret, `${timestamp}.${body}`) in hex.
 *
 * Only public HTTPS addresses are called: the host is resolved and checked on every request
 * (not just when saved), so a name cannot later point at the server's own network.
 */
const TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [10 * 1000, 60 * 1000, 5 * 60 * 1000];
const MAX_FAILURES = 15;

// ---------- Address checks ----------

function isPrivateIPv4(ip) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0)
        || (a === 198 && (b === 18 || b === 19));
}

// IPv6 ranges that are internal, or that embed an IPv4 address (mapped, compatible, NAT64,
// 6to4, Teredo): refused whole, since a webhook has no reason to use them
const blockedV6 = new net.BlockList();
for (const [prefix, bits] of [
    ['::', 128], ['::1', 128], ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
]) blockedV6.addSubnet(prefix, bits, 'ipv6');

function isPrivateAddress(ip) {
    const address = String(ip).replace(/^\[|\]$/g, '');
    if (net.isIPv4(address)) return isPrivateIPv4(address);
    if (!net.isIPv6(address)) return true;
    return blockedV6.check(address, 'ipv6');
}

/**
 * URL rules for saving a webhook. Returns an error message or null.
 */
function urlProblem(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return 'Enter a full URL starting with https://';
    }
    if (url.protocol !== 'https:') return 'The URL must start with https://';
    if (url.username || url.password) return 'The URL must not contain a user name or password.';
    if (value.length > 500) return 'The URL is too long.';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) {
        return 'The URL must be a public address.';
    }
    return null;
}

// Resolver used for every delivery; tests replace it
const resolver = {
    lookup: (hostname, options, callback) => dns.lookup(hostname, options, callback)
};

// http(s) "lookup" that refuses private addresses (also stops DNS rebinding)
function safeLookup(hostname, options, callback) {
    resolver.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
        const bad = list.find(a => isPrivateAddress(a.address));
        // WEBHOOK_ALLOW_PRIVATE lets a local receiver be tested in development, never in production
        if (bad && (process.env.NODE_ENV === 'production' || !process.env.WEBHOOK_ALLOW_PRIVATE)) {
            return callback(Object.assign(new Error('Webhook address is not public'), { code: 'EPRIVATE' }));
        }
        if (options?.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
    });
}

// ---------- Delivery ----------

const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

function sign(secret, timestamp, body) {
    return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * POST one event to one webhook. Returns { ok, status, error }.
 */
async function send(webhook, event, payload) {
    if (urlProblem(webhook.url)) return { ok: false, status: null, error: 'Address is not public' };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
        const res = await axios.post(webhook.url, body, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'FlyBot-Webhook/1',
                'X-FlyBot-Event': event,
                'X-FlyBot-Timestamp': String(timestamp),
                'X-FlyBot-Signature': sign(webhook.secret, timestamp, body)
            },
            timeout: TIMEOUT_MS,
            maxRedirects: 0,
            maxContentLength: 64 * 1024,
            validateStatus: () => true,
            lookup: safeLookup
        });
        const ok = res.status >= 200 && res.status < 300;
        return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}` };
    } catch (err) {
        return { ok: false, status: null, error: err.code === 'EPRIVATE' ? 'Address is not public' : (err.code || err.message) };
    }
}

async function record(webhookId, result) {
    const update = result.ok
        ? { $set: { lastDeliveryAt: new Date(), lastStatus: result.status, lastError: null, failures: 0 } }
        : { $set: { lastDeliveryAt: new Date(), lastStatus: result.status, lastError: String(result.error).slice(0, 200) }, $inc: { failures: 1 } };
    const doc = await Webhook.findByIdAndUpdate(webhookId, update, { new: true });
    if (doc && doc.failures >= MAX_FAILURES && doc.active) {
        await Webhook.updateOne({ _id: doc._id }, { $set: { active: false } });
        console.warn(`⚠️ Webhook ${doc._id} switched off after ${doc.failures} failed deliveries.`);
    }
}

/**
 * Deliver with retries (in the background). Returns the first attempt's result.
 */
async function deliver(webhook, event, payload, attempt = 0) {
    const result = await send(webhook, event, payload);
    await record(webhook._id, result).catch(err => console.warn('⚠️ Webhook status not saved:', err.message));
    // Retry network errors and server errors; a 4xx answer will not change
    const retryable = !result.ok && (result.status === null || result.status >= 500 || result.status === 429);
    if (retryable && attempt < RETRY_DELAYS_MS.length && result.error !== 'Address is not public') {
        setTimeout(async () => {
            const fresh = await Webhook.findById(webhook._id).catch(() => null);
            if (fresh?.active) deliver(fresh, event, payload, attempt + 1);
        }, RETRY_DELAYS_MS[attempt]).unref();
    }
    return result;
}

const payloadOf = (notification) => ({
    id: String(notification._id),
    event: notification.type,
    createdAt: notification.createdAt,
    deviceSerial: notification.deviceSerial || null,
    severity: notification.severity,
    params: notification.params || {}
});


/**
 * Send a new notification to the user's webhooks that subscribe to its type.
 */
async function dispatch(userId, notification) {
    const hooks = await Webhook.find({ userId, active: true, events: notification.type });
    if (!hooks.length) return 0;
    // Webhooks keep firing while the account's plan has API & webhooks (services/entitlements.js)
    if (!(await require('./entitlements').integrationsAllowed(userId))) return 0;
    await Promise.all(hooks.map(hook => deliver(hook, notification.type, payloadOf(notification))));
    return hooks.length;
}

/**
 * Active webhooks of these users that subscribe to `event`, kept only for users still allowed
 * integrations. An event that is not a notification checks this first, so it builds no
 * payload when nobody listens.
 */
async function subscribers(userIds, event) {
    const ids = [...new Set(userIds.filter(Boolean).map(String))];
    if (!ids.length) return [];
    const hooks = await Webhook.find({ userId: { $in: ids }, active: true, events: event });
    if (!hooks.length) return [];
    const owners = [...new Set(hooks.map(h => String(h.userId)))];
    const entitlements = require('./entitlements');
    const allowedIds = new Set();
    for (const id of owners) if (await entitlements.integrationsAllowed(id)) allowedIds.add(id);
    return hooks.filter(h => allowedIds.has(String(h.userId)));
}

/**
 * Deliver an event that is not a notification (snapshot_analyzed) to these webhooks, with
 * retries. `payload` has the notification shape: { id, event, createdAt, deviceSerial, severity, params }.
 */
async function deliverEvent(hooks, payload) {
    await Promise.all(hooks.map(hook => deliver(hook, payload.event, payload)));
    return hooks.length;
}

/** A "ping" to check a webhook from the settings page (no retries). */
async function ping(webhook) {
    const result = await send(webhook, 'ping', { id: `ping_${Date.now()}`, event: 'ping', createdAt: new Date(), deviceSerial: null, severity: 'info', params: {} });
    await record(webhook._id, result);
    return result;
}

module.exports = {
    MAX_FAILURES,
    resolver,
    isPrivateAddress,
    urlProblem,
    safeLookup,
    newSecret,
    sign,
    send,
    dispatch,
    subscribers,
    deliverEvent,
    ping
};
