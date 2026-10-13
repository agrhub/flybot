const { Dashboard, User } = require('../models');
const { translate, normalizeLanguage } = require('../utils/i18n');
const mailService = require('./mailService');
const emailTemplates = require('./emailTemplates');
const dashboardService = require('./dashboardService');
const { buildReportPdf } = require('./reportPdfService');
const { appUrl } = require('./authTokenService');
const telegramService = require('./telegramService');

/**
 * Reports emailed on a schedule (weekly or monthly) with the report as a PDF attachment.
 * Times are farm time (Asia/Ho_Chi_Minh, UTC+7, no daylight saving).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const FARM_OFFSET_MS = 7 * 60 * 60 * 1000;
// Data each email covers
const PERIOD = { weekly: { preset: '7d' }, monthly: { preset: '30d' } };

/**
 * The latest scheduled moment at or before `now` (a Date), or null when the schedule is off.
 * schedule: { frequency: 'weekly' | 'monthly', weekday 1-7 (Monday = 1), monthDay 1-28, hour 0-23 }
 */
function lastSlot(schedule, now = new Date()) {
    if (!PERIOD[schedule?.frequency]) return null;
    // UTC fields of `local` read as the farm's wall clock
    const local = new Date(now.getTime() + FARM_OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const hour = schedule.hour ?? 7;
    let slot;
    if (schedule.frequency === 'weekly') {
        const weekday = local.getUTCDay() || 7;
        slot = Date.UTC(y, m, local.getUTCDate(), hour) - ((weekday - (schedule.weekday || 1) + 7) % 7) * DAY_MS;
        if (slot > local.getTime()) slot -= 7 * DAY_MS;
    } else {
        const day = schedule.monthDay || 1;
        slot = Date.UTC(y, m, day, hour);
        if (slot > local.getTime()) slot = Date.UTC(y, m - 1, day, hour);
    }
    return new Date(slot - FARM_OFFSET_MS);
}

function safeAppUrl(pathname) {
    try {
        return appUrl(pathname);
    } catch {
        return null;
    }
}

const fullDay = (key) => (key ? key.split('-').reverse().join('/') : '');

// Headline figures for the email body, from the report's first key-figures widget
function summaryLines(t, dashboard, widgets) {
    const kpiWidget = (dashboard.widgets || []).find(w => w.type === 'kpi' && widgets[w.id]);
    if (!kpiWidget) return [];
    const k = widgets[kpiWidget.id];
    const change = k.changePct === null || k.changePct === undefined ? '' : ` (${k.changePct > 0 ? '+' : ''}${k.changePct}%)`;
    return [
        t('email.scheduledReport.catches', { count: k.catches ?? '--', change, ftd: k.ftd ?? '--' }),
        t('email.scheduledReport.alerts', { count: k.alertCameras, cameras: k.cameras })
    ];
}

// The ways a person takes scheduled reports: email (confirmed address) and a linked Telegram chat
const channelsOf = (user) => ({
    email: !!user?.email && !!user.emailVerified && user.notificationPrefs?.email !== false,
    telegram: !!user?.telegram?.chatId && user.notificationPrefs?.telegram !== false
});

/**
 * Send one person the report with its PDF, with the data they may see. `range`: { preset, from?,
 * to? } (default: the report's own range). `channels`: { email, telegram } (default: email only).
 * Returns false when nothing was sent.
 */
async function sendReportTo(dashboard, user, { range = null, now = new Date(), channels = { email: true }, cache = null } = {}) {
    if (!user || user.disabled || (!channels.email && !channels.telegram)) return false;
    if (channels.email && !user.email) return false;
    const language = normalizeLanguage(user.language);
    const t = (key, params) => translate(language, key, params);
    const serials = await dashboardService.effectiveSerials(dashboard, user);
    // People who see the same cameras in the same language get the same PDF (built once per run)
    const key = `${language}|${serials.join(',')}`;
    let built = cache?.get(key);
    if (!built) {
        const { range: covered, widgets } = await dashboardService.computeWidgetData(dashboard, serials, {
            imageUrl: () => '',
            range,
            now
        });
        built = { covered, widgets, pdf: buildReportPdf({ dashboard, data: widgets, range: covered, language, generatedAt: now }) };
        cache?.set(key, built);
    }
    const { covered, widgets, pdf } = built;
    const params = { name: String(dashboard.name).replace(/[\r\n\t]+/g, ' ').slice(0, 80), from: fullDay(covered.from), to: fullDay(covered.to) };
    const fileName = `FlyBot_${params.name.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}_${covered.from}_${covered.to}.pdf`;
    const lines = summaryLines(t, dashboard, widgets);
    const url = safeAppUrl(`/reports/${dashboard._id}`);
    if (channels.email) {
        mailService.queueMail(emailTemplates.scheduledReportEmail({
            user,
            language,
            params,
            lines,
            url,
            attachments: [{ filename: fileName, content: pdf, contentType: 'application/pdf' }]
        }));
    }
    if (channels.telegram) {
        const esc = emailTemplates.escapeHtml;
        const subject = t('email.scheduledReport.subject', params);
        const caption = [
            `<b>${esc(subject)}</b>`,
            ...lines.map(esc),
            ...(url ? [`<a href="${esc(url)}">${esc(t('email.scheduledReport.button'))}</a>`] : [])
        ].join('\n');
        // Same text without markup, if Telegram cannot read the HTML one
        const plainCaption = [subject, ...lines, ...(url ? [url] : [])].join('\n');
        telegramService.queueDocument(user.telegram.chatId, { content: pdf, filename: fileName, caption, plainCaption });
    }
    return true;
}

/**
 * Who gets a scheduled report: the owner, plus the people it is shared with when the schedule
 * says so and sharing has not ended. Active accounts with a confirmed email or a linked Telegram.
 */
async function recipientsOf(dashboard) {
    const ids = [dashboard.ownerId?._id ?? dashboard.ownerId];
    if (dashboard.schedule?.recipients === 'all' && !dashboardService.isExpired(dashboard)) {
        // Not those who stopped this report's scheduled messages for themselves
        ids.push(...(dashboard.sharedWith || []).filter(sh => !sh.scheduleMuted).map(sh => sh.userId).filter(Boolean));
    }
    const users = await User.find({ _id: { $in: ids }, disabled: { $ne: true } })
        .select('email name language role disabled emailVerified notificationPrefs telegram');
    return users.filter(user => channelsOf(user).email || channelsOf(user).telegram);
}

/**
 * Hourly job: send every report whose scheduled moment has come since it was last sent.
 */
async function sendDueReports(now = new Date()) {
    const dashboards = await Dashboard.find({ 'schedule.frequency': { $in: Object.keys(PERIOD) } })
        .populate('ownerId', 'email name role disabled language');
    let sent = 0;
    for (const dashboard of dashboards) {
        const slot = lastSlot(dashboard.schedule, now);
        if (!slot || (dashboard.schedule.lastSentAt && dashboard.schedule.lastSentAt >= slot)) continue;
        if (!dashboard.ownerId?.email || dashboard.ownerId.disabled) continue;
        // Marked first, so a failure is not retried every hour
        await Dashboard.updateOne({ _id: dashboard._id }, { $set: { 'schedule.lastSentAt': now } });
        const cache = new Map();
        let recipients = [];
        try {
            recipients = await recipientsOf(dashboard);
        } catch (err) {
            console.error(`❌ Scheduled report ${dashboard._id} failed:`, err.message);
        }
        for (const user of recipients) {
            // One person failing does not stop the others
            try {
                if (await sendReportTo(dashboard, user, { range: PERIOD[dashboard.schedule.frequency], now, channels: channelsOf(user), cache })) sent++;
            } catch (err) {
                console.error(`❌ Scheduled report ${dashboard._id} for ${user._id} failed:`, err.message);
            }
            // PDFs are built on the main thread: let requests in between
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    if (sent) console.log(`📨 Scheduled reports sent: ${sent}`);
    return sent;
}

module.exports = {
    PERIOD,
    lastSlot,
    sendReportTo,
    sendDueReports
};
