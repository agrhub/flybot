const webpush = require('web-push');
const { PushSubscription } = require('../models');
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, APP_BASE_URL } = require('../config/env');
const { translate, normalizeLanguage, alertTextKey } = require('../utils/i18n');

// Push services drop a message they could not deliver within this time
const ALERT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TEXT = 200;
// Same text as the alert emails / share emails, keyed by notification type
const TEXT_KEYS = {
    pest_threshold: 'email.alerts.pest_threshold',
    camera_offline: 'email.alerts.camera_offline',
    camera_online: 'email.alerts.camera_online',
    ai_failure: 'email.alerts.ai_failure',
    card_due: 'email.alerts.card_due',
    plot_threshold: 'email.alerts.plot_threshold',
    pest_surge: 'email.alerts.pest_surge',
    image_quality: 'email.alerts.image_quality',
    harvest_ready: 'email.alerts.harvest_ready',
    weather_risk: 'email.alerts.weather_risk',
    log_reminder: 'email.alerts.log_reminder',
    org_digest: 'email.alerts.org_digest',
    farm_shared: 'email.farmShared',
    org_joined: 'email.orgShared',
    camera_shared: 'email.cameraShared',
    dashboard_shared: 'email.dashboardShared'
};
// Where a tap on the notification opens the app
const TARGET_PATH = {
    pest_threshold: '/analytics',
    camera_offline: '/cameras',
    camera_online: '/cameras',
    ai_failure: '/analytics',
    card_due: '/cameras',
    plot_threshold: '/farms',
    pest_surge: '/analytics',
    image_quality: '/cameras',
    harvest_ready: '/logbook',
    weather_risk: '/dashboard',
    log_reminder: '/logbook',
    org_digest: '/farms',
    camera_shared: '/cameras',
    org_joined: '/settings?tab=organizations'
};
const URGENT_TYPES = new Set(['pest_threshold', 'camera_offline']);

let configured = false;
function setup() {
    if (configured) return true;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
    const subject = VAPID_SUBJECT || (APP_BASE_URL.startsWith('https://') ? APP_BASE_URL : 'mailto:no-reply@localhost');
    try {
        webpush.setVapidDetails(subject, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
        configured = true;
    } catch (err) {
        console.error('❌ Web push disabled, invalid VAPID settings:', err.message);
    }
    return configured;
}

function isEnabled() {
    return setup();
}

function publicKey() {
    return isEnabled() ? VAPID_PUBLIC_KEY : null;
}

const clip = (text) => {
    const value = String(text ?? '');
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
};

/**
 * Notification text in the user's language, plus where a tap should lead.
 */
function buildPayload({ type, language, params = {}, deviceSerial = '' }) {
    const lang = normalizeLanguage(language);
    if (!TEXT_KEYS[type]) return null;
    const base = alertTextKey(type, params);
    const fullParams = { ...params, deviceSerial };
    let url = TARGET_PATH[type] || '/dashboard';
    if (type === 'dashboard_shared' && params.dashboardId) url = `/reports/${params.dashboardId}`;
    if ((type === 'farm_shared' || type === 'plot_threshold') && params.farmId) url = `/farms/${params.farmId}`;
    return {
        type,
        title: clip(translate(lang, `${base}.subject`, fullParams)),
        body: clip(translate(lang, `${base}.body`, fullParams)),
        url,
        // A newer alert of the same kind for the same camera replaces the old one on the device
        tag: `${type}:${deviceSerial || params.dashboardId || params.farmId || ''}`
    };
}

/**
 * Send one payload to every device of the user. Never throws; subscriptions the
 * push service reports as gone (404/410) are removed. Returns the number delivered.
 */
async function sendToUser(userId, payload, { urgent = false } = {}) {
    if (!payload || !isEnabled()) return 0;
    let subscriptions;
    try {
        subscriptions = await PushSubscription.find({ userId });
    } catch (err) {
        console.error('⚠️ Push lookup failed:', err.message);
        return 0;
    }
    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(subscriptions.map(async (sub) => {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
                body,
                { TTL: ALERT_TTL_SECONDS, urgency: urgent ? 'high' : 'normal' }
            );
            await PushSubscription.updateOne({ _id: sub._id }, { $set: { lastSuccessAt: new Date() } });
            return true;
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                // Unsubscribed, expired or the app was uninstalled
                await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
            } else {
                console.error(`⚠️ Push to a device failed (${err.statusCode || err.message})`);
            }
            return false;
        }
    }));
    return results.filter(r => r.status === 'fulfilled' && r.value === true).length;
}

/**
 * Fire-and-forget push for a notification (used by notificationService).
 */
function queueNotification(user, { type, params, deviceSerial }) {
    if (!isEnabled()) return;
    const payload = buildPayload({ type, language: user.language, params, deviceSerial });
    sendToUser(user._id, payload, { urgent: URGENT_TYPES.has(type) })
        .catch(err => console.error('⚠️ Push failed:', err.message));
}

module.exports = {
    isEnabled,
    publicKey,
    buildPayload,
    sendToUser,
    queueNotification
};
