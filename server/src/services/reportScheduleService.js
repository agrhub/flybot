const { Dashboard, User } = require('../models');
const { translate, normalizeLanguage } = require('../utils/i18n');
const mailService = require('./mailService');
const emailTemplates = require('./emailTemplates');
const dashboardService = require('./dashboardService');
const { buildReportPdf } = require('./reportPdfService');
const { appUrl } = require('./authTokenService');

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

/**
 * Email one person the report, with the data they may see. `range`: { preset, from?, to? }
 * (default: the report's own range). Returns false when there is nobody to send to.
 */
async function sendReportTo(dashboard, user, { range = null, now = new Date() } = {}) {
    if (!user?.email || user.disabled) return false;
    const language = normalizeLanguage(user.language);
    const t = (key, params) => translate(language, key, params);
    const serials = await dashboardService.effectiveSerials(dashboard, user);
    const { range: covered, widgets } = await dashboardService.computeWidgetData(dashboard, serials, {
        imageUrl: () => '',
        range,
        now
    });
    const pdf = buildReportPdf({ dashboard, data: widgets, range: covered, language, generatedAt: now });
    const params = { name: String(dashboard.name).replace(/[\r\n\t]+/g, ' ').slice(0, 80), from: fullDay(covered.from), to: fullDay(covered.to) };
    const fileName = `FlyBot_${params.name.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}_${covered.from}_${covered.to}.pdf`;
    mailService.queueMail(emailTemplates.scheduledReportEmail({
        user,
        language,
        params,
        lines: summaryLines(t, dashboard, widgets),
        url: safeAppUrl(`/reports/${dashboard._id}`),
        attachments: [{ filename: fileName, content: pdf, contentType: 'application/pdf' }]
    }));
    return true;
}

/**
 * Who gets a scheduled report: the owner, plus the people it is shared with when the schedule
 * says so and sharing has not ended. Only confirmed, active accounts that take emails.
 */
async function recipientsOf(dashboard) {
    const ids = [dashboard.ownerId?._id ?? dashboard.ownerId];
    if (dashboard.schedule?.recipients === 'all' && !dashboardService.isExpired(dashboard)) {
        ids.push(...(dashboard.sharedWith || []).map(sh => sh.userId).filter(Boolean));
    }
    return User.find({
        _id: { $in: ids },
        disabled: { $ne: true },
        emailVerified: true,
        'notificationPrefs.email': { $ne: false }
    }).select('email name language role disabled');
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
        try {
            for (const user of await recipientsOf(dashboard)) {
                if (await sendReportTo(dashboard, user, { range: PERIOD[dashboard.schedule.frequency], now })) sent++;
            }
        } catch (err) {
            console.error(`❌ Scheduled report ${dashboard._id} failed:`, err.message);
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
