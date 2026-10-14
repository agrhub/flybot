const { Camera, User, Notification, Snapshot } = require('../models');
const { trapKindOf } = require('../constants/trap');
const { NON_PEST_LABELS } = require('../constants/species');
const { normalizeLanguage, translate } = require('../utils/i18n');
const sseHub = require('../realtime/sseHub');
const mailService = require('./mailService');
const emailTemplates = require('./emailTemplates');
const { appUrl } = require('./authTokenService');
const telegramService = require('./telegramService');
const { TIMEZONE } = require('./captureSchedule');
const pushService = require('./pushService');

// Minimum gap between two notifications of the same type for the same user + camera
const COOLDOWN_MINUTES = {
    pest_threshold: 120,
    camera_offline: 60,
    camera_online: 60,
    ai_failure: 360,
    // Every share is its own event
    camera_shared: 0,
    dashboard_shared: 0,
    // Daily reminder until the card is replaced
    card_due: 20 * 60,
    card_change_detected: 0,
    plot_threshold: 120,
    farm_shared: 0,
    // At most one "sudden rise" per camera per day
    pest_surge: 24 * 60,
    weekly_report: 0,
    // A bad photo is reminded once a day while it lasts
    image_quality: 24 * 60,
    org_joined: 0,
    // One per treatment (the job marks the treatment as reminded)
    harvest_ready: 0,
    // One weather warning per farm a day
    weather_risk: 20 * 60,
    // A cooperative's reminder to log the work: once a day per member and organization
    log_reminder: 20 * 60,
    // The Monday list of members to visit: once a week per organization
    org_digest: 6 * 24 * 60
};

const SEVERITY = {
    pest_threshold: 'critical',
    camera_offline: 'warning',
    camera_online: 'info',
    ai_failure: 'warning',
    camera_shared: 'info',
    dashboard_shared: 'info',
    card_due: 'warning',
    card_change_detected: 'info',
    plot_threshold: 'critical',
    farm_shared: 'info',
    pest_surge: 'warning',
    weekly_report: 'info',
    image_quality: 'warning',
    org_joined: 'info',
    harvest_ready: 'info',
    weather_risk: 'warning',
    log_reminder: 'warning',
    org_digest: 'info'
};

// "Back online" is good news: in-app only
const EMAIL_TYPES = new Set(['pest_threshold', 'camera_offline', 'ai_failure', 'card_due', 'plot_threshold', 'pest_surge', 'image_quality', 'harvest_ready', 'weather_risk', 'log_reminder', 'org_digest']);
// Phone/browser push: the alerts, plus something new shared with you
const PUSH_TYPES = new Set([...EMAIL_TYPES, 'camera_shared', 'dashboard_shared', 'farm_shared', 'org_joined']);

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

const QUIET_FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Is it the user's quiet time (farm time zone)? Handles ranges across midnight (21:00-06:00).
 */
function inQuietHours(user, now = new Date()) {
    const q = user?.notificationPrefs?.quietHours;
    if (!q?.enabled || !q.start || !q.end || q.start === q.end) return false;
    const current = QUIET_FORMAT.format(now);
    return q.start < q.end ? current >= q.start && current < q.end : current >= q.start || current < q.end;
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
    // The user's webhooks (in the background; delivery has its own retries)
    require('./webhookService').dispatch(userId, notification).catch(err => console.warn('⚠️ Webhook dispatch failed:', err.message));

    const needsUser = EMAIL_TYPES.has(type) || (PUSH_TYPES.has(type) && pushService.isEnabled());
    const user = needsUser ? await User.findById(userId) : null;
    if (!user || user.disabled) return notification;

    // Night hours chosen by the user: nothing that buzzes a phone
    const quiet = inQuietHours(user);
    params = localizeParams(user.language, params);

    // Each subscribed device is opted in by the user on that device
    if (PUSH_TYPES.has(type) && !quiet) {
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
            mailService.queueMail(emailTemplates.alertEmail({ user, language, type, params: fullParams, url }));
        }
        if (user.telegram?.chatId && user.notificationPrefs?.telegram !== false && !quiet) {
            telegramService.queueMessage(user.telegram.chatId, telegramService.formatAlert({ language, type, params: fullParams, url }));
        }
    }
    return notification;
}

/**
 * Params that are stable keys get their text in the user's language for push, email and
 * Telegram (the app translates the keys itself).
 */
function localizeParams(language, params = {}) {
    if (!params.issue) return params;
    return { ...params, issueText: translate(normalizeLanguage(language), `email.imageIssues.${params.issue}`) };
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

    let recipients = [...new Set([camera.userId, ...(camera.sharedWith || []).map(sh => sh.userId)]
        .filter(Boolean)
        .map(String))];
    // People who muted this camera get nothing from it
    const muted = await User.find({ _id: { $in: recipients }, 'notificationPrefs.mutedCameras': deviceSerial }).select('_id').lean();
    const mutedIds = new Set(muted.map(u => String(u._id)));
    recipients = recipients.filter(id => !mutedIds.has(id));
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

// Start of the local day (farm time zone, UTC+7 without daylight saving)
const localDayStart = (now) => new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(now)}T00:00:00+07:00`);

/** Average pest count per analyzed photo of a camera since local midnight. */
async function dailyAveragePests(deviceSerial, now = new Date()) {
    const snaps = await Snapshot.find({ deviceSerial, aiProcessed: true, createdAt: { $gte: localDayStart(now), $lte: now } })
        .select('aiResults.summary').lean();
    if (!snaps.length) return 0;
    const total = snaps.reduce((sum, snap) => sum + countPests(snap.aiResults?.summary), 0);
    return Math.round((total / snaps.length) * 10) / 10;
}

/**
 * After an AI analysis: alert owners whose threshold is reached.
 * A sticky trap compares the latest photo (the card keeps what it caught); a lure trap, where
 * flies come and go, compares the day's average per photo so one busy photo does not alert.
 */
async function checkPestThreshold(deviceSerial, count, { now = new Date() } = {}) {
    const trap = await Camera.findOne({ deviceSerial }).select('trapKind').lean();
    const lure = trapKindOf(trap) === 'lure';
    const value = lure ? await dailyAveragePests(deviceSerial, now) : count;
    return notifyCameraOwners(deviceSerial, 'pest_threshold', (camera) => {
        const threshold = camera.alertThreshold || 15;
        if (value < threshold) return null;
        return { deviceName: cameraName(camera), count: value, threshold, ...(lure ? { basis: 'dailyAverage' } : {}) };
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
    dailyAveragePests,
    cameraStatusChanged,
    notifyCameraOwners,
    inQuietHours,
    recordAiResult
};
