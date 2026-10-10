const { PushSubscription } = require('../models');
const pushService = require('../services/pushService');
const { sendServerError } = require('../utils/http');
const { translate, normalizeLanguage } = require('../utils/i18n');

const MAX_DEVICES_PER_USER = 20;
const MAX_KEY_LENGTH = 200;

// The server posts to the subscription endpoint, so only real push services are accepted
// (otherwise a client could make the server call internal addresses)
const PUSH_HOSTS = [
    /^fcm\.googleapis\.com$/,
    /^android\.googleapis\.com$/,
    /(^|\.)push\.services\.mozilla\.com$/,
    /(^|\.)notify\.windows\.com$/,
    /(^|\.)push\.apple\.com$/
];

function readEndpoint(value) {
    if (typeof value !== 'string' || value.length > 1000) return null;
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    return PUSH_HOSTS.some(re => re.test(url.hostname)) ? url.href : null;
}

const validKey = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH && /^[A-Za-z0-9_\-=+/]+$/.test(value);

/**
 * GET /api/push/config: whether push is set up on the server, and the public key to subscribe with
 */
function getConfig(req, res) {
    res.json({ success: true, enabled: pushService.isEnabled(), publicKey: pushService.publicKey() });
}

/**
 * POST /api/push/subscriptions { subscription: { endpoint, keys: { p256dh, auth } } }
 * Saves this device for the signed-in user (moves it if another account used it before).
 */
async function subscribe(req, res) {
    try {
        if (!pushService.isEnabled()) {
            return res.status(503).json({ success: false, code: 'PUSH_DISABLED', message: "Push notifications are not configured on this server." });
        }
        const sub = req.body?.subscription;
        const endpoint = readEndpoint(sub?.endpoint);
        if (!endpoint || !validKey(sub?.keys?.p256dh) || !validKey(sub?.keys?.auth)) {
            return res.status(400).json({ success: false, message: "Invalid push subscription." });
        }

        await PushSubscription.findOneAndUpdate(
            { endpoint },
            {
                $set: {
                    userId: req.user.id,
                    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
                    userAgent: String(req.headers['user-agent'] || '').slice(0, 300)
                },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
        );

        // Keep the newest devices only
        const extra = await PushSubscription.find({ userId: req.user.id }).sort({ createdAt: -1 }).skip(MAX_DEVICES_PER_USER).select('_id');
        if (extra.length) await PushSubscription.deleteMany({ _id: { $in: extra.map(s => s._id) } });

        const devices = await PushSubscription.countDocuments({ userId: req.user.id });
        res.json({ success: true, devices });
    } catch (err) {
        sendServerError(res, err, { context: 'Push subscribe' });
    }
}

/**
 * DELETE /api/push/subscriptions { endpoint }: stop push on this device
 */
async function unsubscribe(req, res) {
    try {
        const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
        await PushSubscription.deleteOne({ endpoint, userId: req.user.id });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Push unsubscribe' });
    }
}

/**
 * POST /api/push/test: send a test notification to all of my devices
 */
async function sendTest(req, res) {
    try {
        if (!pushService.isEnabled()) {
            return res.status(503).json({ success: false, code: 'PUSH_DISABLED', message: "Push notifications are not configured on this server." });
        }
        const lang = normalizeLanguage(req.user.language);
        const delivered = await pushService.sendToUser(req.user.id, {
            type: 'test',
            title: translate(lang, 'push.testTitle'),
            body: translate(lang, 'push.testBody'),
            url: '/settings?tab=notifications',
            tag: 'test'
        });
        res.json({ success: true, delivered });
    } catch (err) {
        sendServerError(res, err, { context: 'Push test' });
    }
}

module.exports = {
    getConfig,
    subscribe,
    unsubscribe,
    sendTest,
    readEndpoint
};
