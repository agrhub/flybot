const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
// Same Vietnamese-capable font as the report PDFs
const { addQuicksandFonts } = require('../../../client/src/utils/pdfFonts.js');
const { Treatment, Camera, User } = require('../models');
const { getViewableSerials } = require('../utils/ownership');
const { translate, normalizeLanguage } = require('../utils/i18n');
const mailService = require('./mailService');
const emailTemplates = require('./emailTemplates');
const telegramService = require('./telegramService');
const { appUrl } = require('./authTokenService');

/**
 * The monthly pesticide-use record (VietGAP / GlobalGAP): every treatment of the past month on
 * the traps a person can see, as a PDF by email (and Telegram). Opt-in per person
 * (notificationPrefs.vietgapMonthly), sent on the 1st; also on request from the logbook.
 */

// Farm time (UTC+7, no daylight saving): months start at local midnight
const FARM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const MARGIN = 12;

/** The calendar month before `now` in farm time: { from, to, label: 'MM/YYYY', key: 'YYYY-MM' }. */
function previousMonth(now = new Date()) {
    const local = new Date(now.getTime() + FARM_OFFSET_MS);
    const year = local.getUTCMonth() === 0 ? local.getUTCFullYear() - 1 : local.getUTCFullYear();
    const month = (local.getUTCMonth() + 11) % 12; // 0-based
    const from = new Date(Date.UTC(year, month, 1) - FARM_OFFSET_MS);
    const to = new Date(Date.UTC(month === 11 ? year + 1 : year, (month + 1) % 12, 1) - FARM_OFFSET_MS - 1);
    const mm = String(month + 1).padStart(2, '0');
    return { from, to, label: `${mm}/${year}`, key: `${year}-${mm}` };
}

const farmDate = (date) => {
    const d = new Date(new Date(date).getTime() + FARM_OFFSET_MS);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const farmDateTime = (date) => {
    const d = new Date(new Date(date).getTime() + FARM_OFFSET_MS);
    return `${farmDate(date)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** The person's treatments in the month, oldest first, with the names of the traps they can see. */
async function monthlyRecord(user, month) {
    const visible = await getViewableSerials(user);
    if (!visible.length) return [];
    const rows = await Treatment.find({ cameraSerials: { $in: visible }, at: { $gte: month.from, $lte: month.to } })
        .sort({ at: 1 }).lean();
    if (!rows.length) return [];
    const seen = new Set(visible);
    const cameras = await Camera.find({ deviceSerial: { $in: [...new Set(rows.flatMap(r => r.cameraSerials))].filter(s => seen.has(s)) } })
        .select('deviceSerial deviceName').lean();
    const nameOf = new Map(cameras.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
    return rows.map(r => ({ ...r, traps: r.cameraSerials.filter(s => seen.has(s)).map(s => nameOf.get(s) || s) }));
}

/** The record as an A4 landscape PDF (Buffer). */
function buildVietGapPdf({ rows, month, language, owner, generatedAt = new Date() }) {
    const t = (key, params) => translate(language, `vietgap.${key}`, params);
    const doc = new jsPDF({ orientation: 'l', unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
    addQuicksandFonts(doc);
    doc.setFont('Quicksand', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...TEXT);
    doc.text(t('title', { month: month.label }), MARGIN, 16);
    doc.setFont('Quicksand', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(t('subtitle', { owner, count: rows.length, date: farmDateTime(generatedAt) }), MARGIN, 22);
    const head = ['index', 'date', 'traps', 'type', 'product', 'activeIngredient', 'dose', 'area', 'operator', 'phi', 'harvestFrom', 'note'].map(k => t(`col.${k}`));
    const body = rows.map((r, i) => [
        i + 1,
        farmDateTime(r.at),
        r.traps.join(', '),
        t(`types.${r.type}`),
        r.product || '',
        r.activeIngredient || '',
        r.dose || '',
        r.area || '',
        r.operator || r.createdByEmail || '',
        Number.isInteger(r.preHarvestDays) ? String(r.preHarvestDays) : '',
        Number.isInteger(r.preHarvestDays) ? farmDate(new Date(r.at).getTime() + r.preHarvestDays * DAY_MS) : '',
        r.note || ''
    ]);
    autoTable(doc, {
        startY: 27,
        margin: { left: MARGIN, right: MARGIN, bottom: 14 },
        head: [head],
        body,
        theme: 'grid',
        styles: { font: 'Quicksand', fontSize: 8, valign: 'middle', textColor: TEXT, cellPadding: 1.6 },
        headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 9, halign: 'center' }, 1: { cellWidth: 25 }, 9: { cellWidth: 18, halign: 'center' }, 10: { cellWidth: 22 } },
        didDrawPage: () => {
            const pageHeight = doc.internal.pageSize.getHeight();
            doc.setFontSize(7.5);
            doc.setTextColor(...MUTED);
            doc.text(t('footer'), MARGIN, pageHeight - 7);
        }
    });
    return Buffer.from(doc.output('arraybuffer'));
}

function safeAppUrl(pathname) {
    try {
        return appUrl(pathname);
    } catch {
        return null;
    }
}

const channelsOf = (user) => ({
    email: !!user?.email && !!user.emailVerified && user.notificationPrefs?.email !== false,
    telegram: !!user?.telegram?.chatId && user.notificationPrefs?.telegram !== false
});

/**
 * Send one person the record of the month before `now`. Returns { sent, count, reason? }:
 * nothing is sent when there was no treatment or no way to reach them.
 */
async function sendVietGapLog(user, { now = new Date(), channels = channelsOf(user) } = {}) {
    if (!user || user.disabled) return { sent: false, count: 0, reason: 'inactive' };
    if (!channels.email && !channels.telegram) return { sent: false, count: 0, reason: 'no_channel' };
    const month = previousMonth(now);
    const rows = await monthlyRecord(user, month);
    if (!rows.length) return { sent: false, count: 0, reason: 'empty', month: month.label };
    const language = normalizeLanguage(user.language);
    const t = (key, params) => translate(language, `vietgap.${key}`, params);
    const owner = user.name || user.email;
    const pdf = buildVietGapPdf({ rows, month, language, owner, generatedAt: now });
    const filename = `FlyBot_VietGAP_${month.key}.pdf`;
    const url = safeAppUrl('/logbook');
    const params = { month: month.label, count: rows.length };
    if (channels.email) {
        mailService.queueMail(emailTemplates.vietgapEmail({ user, language, params, url, attachments: [{ filename, content: pdf, contentType: 'application/pdf' }] }));
    }
    if (channels.telegram) {
        const esc = emailTemplates.escapeHtml;
        const caption = `<b>${esc(t('title', params))}</b>\n${esc(t('intro', params))}`;
        telegramService.queueDocument(user.telegram.chatId, { content: pdf, filename, caption, plainCaption: `${t('title', params)}\n${t('intro', params)}` });
    }
    return { sent: true, count: rows.length, month: month.label };
}

/**
 * Monthly job (the 1st, 07:00 farm time): everyone active who turned it on.
 */
async function sendMonthlyVietGapLogs(now = new Date()) {
    const users = await User.find({ disabled: { $ne: true }, 'notificationPrefs.vietgapMonthly': true })
        .select('email name role language emailVerified notificationPrefs telegram disabled');
    let sent = 0;
    for (const user of users) {
        try {
            if ((await sendVietGapLog(user, { now })).sent) sent++;
        } catch (err) {
            console.error(`⚠️ VietGAP record failed (${user._id}):`, err.message);
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    if (sent) console.log(`📒 VietGAP records sent: ${sent}`);
    return { sent };
}

module.exports = {
    previousMonth,
    monthlyRecord,
    buildVietGapPdf,
    sendVietGapLog,
    sendMonthlyVietGapLogs
};
