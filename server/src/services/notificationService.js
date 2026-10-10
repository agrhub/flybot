const { Camera, User, Notification } = require('../models');
const { NON_PEST_LABELS } = require('../constants/species');
const { normalizeLanguage } = require('../utils/i18n');
const sseHub = require('../realtime/sseHub');
const { queueMail } = require('./mailService');
const emailTemplates = require('./emailTemplates');
const { appUrl } = require('./authTokenService');

// Minimum gap between two notifications of the same type for the same user + camera
const COOLDOWN_MINUTES = {
    pest_threshold: 120,
    camera_offline: 60,
    camera_online: 60,
    ai_failure: 360
};

const SEVERITY = {
    pest_threshold: 'critical',
    camera_offline: 'warning',
    camera_online: 'info',
    ai_failure: 'warning'
};

// "Back online" is good news: in-app only
const EMAIL_TYPES = new Set(['pest_threshold', 'camera_offline', 'ai_failure']);

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

    if (EMAIL_TYPES.has(type)) {
        const user = await User.findById(userId);
        // Only verified addresses get alert emails, so typos never receive farm data
        if (user && user.emailVerified && user.notificationPrefs?.email !== false) {
            let url = null;
            try {
                url = appUrl('/dashboard');
            } catch (err) {
                console.warn('⚠️ Alert email without link:', err.message);
            }
            queueMail(emailTemplates.alertEmail({
                user,
                language: normalizeLanguage(user.language),
                type,
                params: { ...params, deviceSerial },
                url
            }));
        }
    }
    return notification;
}

/**
 * Notify every user who has this camera, with that user's own camera name/threshold.
 */
async function notifyCameraOwners(deviceSerial, type, buildParams) {
    const cameras = await Camera.find({ deviceSerial, userId: { $ne: null } });
    const results = [];
    for (const camera of cameras) {
        const params = buildParams(camera);
        if (!params) continue;
        try {
            results.push(await notifyUser({ userId: camera.userId, type, deviceSerial, params }));
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
