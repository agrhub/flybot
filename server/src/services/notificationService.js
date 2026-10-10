const { Camera, User, Notification } = require('../models');
const { NON_PEST_LABELS } = require('../constants/species');
const { normalizeLanguage } = require('../utils/i18n');
const sseHub = require('../realtime/sseHub');
const { queueMail } = require('./mailService');
const emailTemplates = require('./emailTemplates');
const { appUrl } = require('./authTokenService');
const telegramService = require('./telegramService');
const pushService = require('./pushService');

// Minimum gap between two notifications of the same type for the same user + camera
const COOLDOWN_MINUTES = {
    pest_threshold: 120,
    camera_offline: 60,
    camera_online: 60,
    ai_failure: 360,
    // Every share is its own event
    camera_shared: 0,
    dashboard_shared: 0
};

const SEVERITY = {
    pest_threshold: 'critical',
    camera_offline: 'warning',
    camera_online: 'info',
    ai_failure: 'warning',
    camera_shared: 'info',
    dashboard_shared: 'info'
};

// "Back online" is good news: in-app only
const EMAIL_TYPES = new Set(['pest_threshold', 'camera_offline', 'ai_failure']);
// Phone/browser push: the alerts, plus something new shared with you
const PUSH_TYPES = new Set([...EMAIL_TYPES, 'camera_shared', 'dashboard_shared']);

// Consecutive failed AI analyses before alerting
const AI_FAILURE_THRESHOLD = 3;
const aiFailureCounts = new Map(); // deviceSerial -> consecutive failures

function toClient(notification) {
    return {
        id: notification._id,
        type: notification.type,
        severity: notification.severity,
        deviceSerial: notification.deviceSerial,
        params: notification.params,
        read: notification.read,
        createdAt: notification.createdAt
    };
}

/**
 * Create one notification for one user (unless in cooldown), push it live and email it.
 * Returns the notification, or null when suppressed.
 */
async function notifyUser({ userId, type, deviceSerial = '', params = {} }) {
    const since = new Date(Date.now() - COOLDOWN_MINUTES[type] * 60 * 1000);
    const recent = await Notification.exists({ userId, type, deviceSerial, createdAt: { $gte: since } });
    if (recent) return null;

    const notification = await Notification.create({
        userId,
        type,
        severity: SEVERITY[type],
        deviceSerial,
        params
    });

    sseHub.sendToUser(userId, 'notification', toClient(notification));

    const needsUser = EMAIL_TYPES.has(type) || (PUSH_TYPES.has(type) && pushService.isEnabled());
    const user = needsUser ? await User.findById(userId) : null;
    if (!user || user.disabled) return notification;

    // Each subscribed device is opted in by the user on that device
    if (PUSH_TYPES.has(type)) {
        pushService.queueNotification(user, { type, params, deviceSerial });
    }

    // Email and Telegram carry the same alert types ("back online" stays in-app only)
    if (EMAIL_TYPES.has(type)) {
        let url = null;
        try {
            url = appUrl('/dashboard');
        } catch (err) {
            console.warn('⚠️ Alert without link:', err.message);
        }
        const language = normalizeLanguage(user.language);
        const fullParams = { ...params, deviceSerial };

        // Only verified addresses get alert emails, so typos never receive farm data
        if (user.emailVerified && user.notificationPrefs?.email !== false) {
            queueMail(emailTemplates.alertEmail({ user, language, type, params: fullParams, url }));
        }
        if (user.telegram?.chatId && user.notificationPrefs?.telegram !== false) {
            telegramService.queueMessage(user.telegram.chatId, telegramService.formatAlert({ language, type, params: fullParams, url }));
        }
    }
    return notification;
}

/**
 * Notify everyone who can see this camera: its owner and the people it is shared with
 * (pending invitations have no account yet and are skipped).
 */
async function notifyCameraOwners(deviceSerial, type, buildParams) {
    const camera = await Camera.findOne({ deviceSerial });
    if (!camera) return [];
    const params = buildParams(camera);
    if (!params) return [];

    const recipients = [camera.userId, ...(camera.sharedWith || []).map(sh => sh.userId)]
        .filter(Boolean)
        .map(String);
    const results = [];
    for (const userId of [...new Set(recipients)]) {
        try {
            results.push(await notifyUser({ userId, type, deviceSerial, params }));
        } catch (err) {
            console.error(`⚠️ Notification ${type} for ${deviceSerial} failed:`, err.message);
        }
    }
    return results.filter(Boolean);
}

const cameraName = (camera) => camera.deviceName || camera.deviceSerial;

/**
 * Total insects in a snapshot summary, excluding non-pest detections.
 */
function countPests(summary) {
    if (!summary) return 0;
    const entries = summary instanceof Map ? [...summary.entries()] : Object.entries(summary);
    return entries
        .filter(([label]) => !NON_PEST_LABELS.includes(String(label).toLowerCase()))
        .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
}

/**
 * After an AI analysis: alert owners whose threshold is reached.
 */
function checkPestThreshold(deviceSerial, count) {
    return notifyCameraOwners(deviceSerial, 'pest_threshold', (camera) => {
        const threshold = camera.alertThreshold || 15;
        if (count < threshold) return null;
        return { deviceName: cameraName(camera), count, threshold };
    });
}

/**
 * Online/offline transition detected by the status sync.
 */
function cameraStatusChanged(deviceSerial, status) {
    const type = status === 1 ? 'camera_online' : 'camera_offline';
    return notifyCameraOwners(deviceSerial, type, (camera) => ({ deviceName: cameraName(camera) }));
}

/**
 * Record the outcome of an AI analysis; alert after several failures in a row.
 */
async function recordAiResult(deviceSerial, succeeded) {
    if (succeeded) {
        aiFailureCounts.delete(deviceSerial);
        return [];
    }
    const failures = (aiFailureCounts.get(deviceSerial) || 0) + 1;
    aiFailureCounts.set(deviceSerial, failures);
    if (failures < AI_FAILURE_THRESHOLD) return [];
    return notifyCameraOwners(deviceSerial, 'ai_failure', (camera) => ({ deviceName: cameraName(camera), failures }));
}

module.exports = {
    COOLDOWN_MINUTES,
    AI_FAILURE_THRESHOLD,
    toClient,
    notifyUser,
    countPests,
    checkPestThreshold,
    cameraStatusChanged,
    recordAiResult
};
