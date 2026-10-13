const { User, Notification } = require('../models');
const { viewableCameras } = require('../utils/ownership');
const { translate, normalizeLanguage } = require('../utils/i18n');
const catchStats = require('./catchStats');
const { latestProcessedByCamera } = require('./snapshotQueries');
const { judgedCounts } = require('./dashboardService');
const { cardDueAt } = require('./maintenanceService');
const { countPests } = require('./notificationService');
const { thresholdOf, riskLevel } = require('../constants/risk');
const { queueMail } = require('./mailService');
const emailTemplates = require('./emailTemplates');
const telegramService = require('./telegramService');
const { appUrl } = require('./authTokenService');

const HOUR_MS = 60 * 60 * 1000;
const MAX_NAMES = 5;
const plain = (summary) => (summary instanceof Map ? Object.fromEntries(summary) : (summary || {}));

/**
 * What a user should know at the start of the day, for the cameras they can see: yesterday's
 * catches, traps at or near their threshold (judged as alerts are), sticky cards due, cameras
 * offline, and alerts of the last 24 hours. Built from the figures, no AI call. Null without cameras.
 */
async function buildMorningBrief(user, now = new Date()) {
    const cameras = await viewableCameras(user)
        .select('deviceSerial deviceName status alertThreshold trapKind cardReplacedAt cardReminderDays addedAt').lean();
    const unique = [...new Map(cameras.map(c => [c.deviceSerial, c])).values()];
    if (!unique.length) return null;
    const serials = unique.map(c => c.deviceSerial);
    const [catches, latest, alerts] = await Promise.all([
        catchStats.overview(serials, now),
        latestProcessedByCamera(serials),
        Notification.countDocuments({ userId: user._id, createdAt: { $gte: new Date(now.getTime() - 24 * HOUR_MS) } })
    ]);
    for (const row of latest.values()) row.count = countPests(plain(row.summary));
    const judged = await judgedCounts(unique, latest, now);
    const name = (c) => c.deviceName || c.deviceSerial;
    const risk = (c) => riskLevel(judged.get(c.deviceSerial)?.value || 0, thresholdOf(c));
    return {
        cameras: unique.length,
        yesterday: catches.yesterday,
        ftd7: catches.ftd7,
        changePct: catches.changePct,
        over: unique.filter(c => risk(c) === 'high').map(name),
        near: unique.filter(c => risk(c) === 'moderate').map(name),
        cardsDue: unique.filter(c => {
            const due = cardDueAt(c);
            return due && due <= now;
        }).map(name),
        offline: unique.filter(c => c.status !== 1).map(name),
        alerts
    };
}

const list = (names) => (names.length > MAX_NAMES ? `${names.slice(0, MAX_NAMES).join(', ')} +${names.length - MAX_NAMES}` : names.join(', '));

/** The brief as plain lines, in the user's language. */
function briefLines(brief, language) {
    const t = (key, params) => translate(language, `morningBrief.${key}`, params);
    const change = brief.changePct === null || brief.changePct === undefined ? '' : ` (${brief.changePct > 0 ? '+' : ''}${brief.changePct}%)`;
    const lines = [
        brief.yesterday === null || brief.yesterday === undefined
            ? t('noData', { cameras: brief.cameras })
            : t('yesterday', { count: brief.yesterday, cameras: brief.cameras }),
        t('ftd', { ftd: brief.ftd7 ?? '--', change })
    ];
    if (brief.over.length) lines.push(t('over', { list: list(brief.over) }));
    if (brief.near.length) lines.push(t('near', { list: list(brief.near) }));
    if (!brief.over.length && !brief.near.length) lines.push(t('allClear'));
    if (brief.cardsDue.length) lines.push(t('cardsDue', { list: list(brief.cardsDue) }));
    if (brief.offline.length) lines.push(t('offline', { list: list(brief.offline) }));
    if (brief.alerts) lines.push(t('alerts', { count: brief.alerts }));
    return lines;
}

function safeAppUrl(pathname) {
    try {
        return appUrl(pathname);
    } catch {
        return null;
    }
}

/**
 * Send one brief: on Telegram when linked, else by email (one channel, not both).
 * Returns 'telegram', 'email' or null.
 */
function sendBrief(user, brief) {
    const language = normalizeLanguage(user.language);
    const title = translate(language, 'morningBrief.title');
    const lines = briefLines(brief, language);
    if (user.telegram?.chatId && user.notificationPrefs?.telegram !== false && telegramService.isEnabled()) {
        telegramService.queueMessage(user.telegram.chatId, [`<b>${emailTemplates.escapeHtml(title)}</b>`, ...lines.map(l => emailTemplates.escapeHtml(l))].join('\n'));
        return 'telegram';
    }
    if (user.email && user.emailVerified && user.notificationPrefs?.email !== false) {
        queueMail(emailTemplates.morningBriefEmail({ user, language, title, lines, url: safeAppUrl('/dashboard') }));
        return 'email';
    }
    return null;
}

/**
 * Daily job (06:30 farm time): everyone active who turned the brief on.
 */
async function sendMorningBriefs(now = new Date()) {
    const users = await User.find({ disabled: { $ne: true }, 'notificationPrefs.morningBrief': true })
        .select('email name role language emailVerified notificationPrefs telegram');
    let sent = 0;
    for (const user of users) {
        try {
            const brief = await buildMorningBrief(user, now);
            if (brief && sendBrief(user, brief)) sent++;
        } catch (err) {
            console.error(`⚠️ Morning brief failed (${user._id}):`, err.message);
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    if (sent) console.log(`🌅 Morning briefs sent: ${sent}`);
    return { sent };
}

module.exports = {
    buildMorningBrief,
    briefLines,
    sendBrief,
    sendMorningBriefs
};
