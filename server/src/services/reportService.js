const { User, Camera, DailyStat, MaintenanceEvent, Treatment } = require('../models');
const { viewableCameras } = require('../utils/ownership');
const { translate, normalizeLanguage } = require('../utils/i18n');
const { dayKeyOf, addDays, DAY_MS } = require('./dailyStats');
const { dailyValues } = require('./treatmentService');
const { trapKindOf } = require('../constants/trap');
const { cardDueAt } = require('./maintenanceService');
const { queueMail } = require('./mailService');
const emailTemplates = require('./emailTemplates');
const telegramService = require('./telegramService');
const pushService = require('./pushService');
const { appUrl } = require('./authTokenService');

const WEEK_DAYS = 7;
const TOP_CAMERAS = 5;
// A camera "rising" this week: at least this much more than last week, and enough insects to matter
const RISING_PCT = 50;
const RISING_MIN = 10;

const sum = (values) => values.reduce((a, b) => a + (b || 0), 0);
const percentChange = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 100) : null);

/**
 * The past 7 days (yesterday back) vs the 7 before, for the cameras this user can see.
 * Insects are catches per day (rise of the sticky-card count), summed over the week.
 */
async function buildWeeklyReport(user, now = new Date()) {
    const cameras = await viewableCameras(user).select('deviceSerial deviceName status cardReplacedAt cardReminderDays addedAt trapKind').lean();
    if (!cameras.length) return null;
    const serials = cameras.map(c => c.deviceSerial);

    const lastKey = addDays(dayKeyOf(now), -1);
    const weekStart = addDays(lastKey, -(WEEK_DAYS - 1));
    const prevStart = addDays(weekStart, -WEEK_DAYS);
    // One day more before the previous week, for its first day's rise
    const fromKey = addDays(prevStart, -1);

    const [rows, cardEvents, treatments] = await Promise.all([
        DailyStat.find({ deviceSerial: { $in: serials }, day: { $gte: fromKey, $lte: lastKey } }).select('deviceSerial day peak total scans').lean(),
        MaintenanceEvent.find({ deviceSerial: { $in: serials }, type: 'card_replaced', at: { $gte: new Date(now.getTime() - 16 * DAY_MS) } }).select('deviceSerial at').lean(),
        Treatment.countDocuments({ cameraSerials: { $in: serials }, at: { $gte: new Date(`${weekStart}T00:00:00+07:00`), $lte: now } })
    ]);

    const perCamera = cameras.map(cam => {
        const cardDays = new Set(cardEvents.filter(e => e.deviceSerial === cam.deviceSerial).map(e => dayKeyOf(e.at)));
        const catches = dailyValues(rows.filter(r => r.deviceSerial === cam.deviceSerial), cardDays, fromKey, lastKey, trapKindOf(cam));
        let current = 0;
        let previous = 0;
        for (const [day, value] of catches) {
            if (day >= weekStart) current += value || 0;
            else if (day >= prevStart) previous += value || 0;
        }
        return { deviceSerial: cam.deviceSerial, deviceName: cam.deviceName, current, previous, changePct: percentChange(current, previous) };
    });

    const current = sum(perCamera.map(c => c.current));
    const previous = sum(perCamera.map(c => c.previous));
    return {
        period: { from: weekStart, to: lastKey },
        totals: { current, previous, changePct: percentChange(current, previous) },
        topCameras: [...perCamera].sort((a, b) => b.current - a.current).filter(c => c.current > 0).slice(0, TOP_CAMERAS),
        rising: perCamera.filter(c => c.current >= RISING_MIN && c.changePct !== null && c.changePct >= RISING_PCT),
        offline: cameras.filter(c => c.status !== 1).map(c => ({ deviceSerial: c.deviceSerial, deviceName: c.deviceName })),
        cardsDue: cameras.filter(c => {
            const due = cardDueAt(c);
            return due && due <= now;
        }).map(c => ({ deviceSerial: c.deviceSerial, deviceName: c.deviceName })),
        treatments,
        cameraCount: cameras.length
    };
}

/**
 * The report as plain lines (email paragraphs, Telegram message).
 */
function reportLines(report, language) {
    const t = (key, params) => translate(language, key, params);
    const names = (list) => list.map(c => c.deviceName || c.deviceSerial).join(', ');
    const change = report.totals.changePct === null ? '' : ` (${report.totals.changePct > 0 ? '+' : ''}${report.totals.changePct}%)`;
    const lines = [
        t('email.weeklyReport.period', { from: report.period.from, to: report.period.to, cameras: report.cameraCount }),
        t('email.weeklyReport.total', { count: report.totals.current, previous: report.totals.previous, change })
    ];
    if (report.topCameras.length) {
        lines.push(t('email.weeklyReport.top', { list: report.topCameras.map(c => `${c.deviceName} ${c.current}`).join(', ') }));
    }
    if (report.rising.length) lines.push(t('email.weeklyReport.rising', { list: names(report.rising) }));
    if (report.cardsDue.length) lines.push(t('email.weeklyReport.cardsDue', { list: names(report.cardsDue) }));
    if (report.offline.length) lines.push(t('email.weeklyReport.offline', { list: names(report.offline) }));
    lines.push(t('email.weeklyReport.treatments', { count: report.treatments }));
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
 * Send one user's report on the channels they use. Returns what was sent.
 */
async function sendReport(user, report) {
    const language = normalizeLanguage(user.language);
    const lines = reportLines(report, language);
    const url = safeAppUrl('/analytics');
    const sent = { email: false, telegram: false, push: 0 };

    if (user.emailVerified && user.notificationPrefs?.email !== false) {
        queueMail(emailTemplates.weeklyReportEmail({ user, language, lines, url }));
        sent.email = true;
    }
    if (user.telegram?.chatId && user.notificationPrefs?.telegram !== false) {
        const title = translate(language, 'email.weeklyReport.subject');
        telegramService.queueMessage(user.telegram.chatId, [`<b>${emailTemplates.escapeHtml(title)}</b>`, ...lines.map(l => emailTemplates.escapeHtml(l))].join('\n'));
        sent.telegram = true;
    }
    sent.push = await pushService.sendToUser(user._id, {
        type: 'weekly_report',
        title: translate(language, 'email.weeklyReport.subject'),
        body: lines.slice(1, 3).join(' · '),
        url: '/analytics',
        tag: 'weekly_report'
    });
    return sent;
}

/**
 * Monday morning job: everyone active who wants the report and sees at least one camera.
 */
async function sendWeeklyReports(now = new Date()) {
    const users = await User.find({ disabled: { $ne: true }, 'notificationPrefs.weeklyReport': { $ne: false } })
        .select('email name role language emailVerified notificationPrefs telegram');
    let count = 0;
    for (const user of users) {
        try {
            const report = await buildWeeklyReport(user, now);
            if (!report) continue;
            await sendReport(user, report);
            count++;
        } catch (err) {
            console.error(`⚠️ Weekly report failed (${user.email}):`, err.message);
        }
    }
    console.log(`📰 Weekly reports sent to ${count} user(s).`);
    return count;
}

module.exports = {
    buildWeeklyReport,
    reportLines,
    sendReport,
    sendWeeklyReports
};
