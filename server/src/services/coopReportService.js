const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
// Same Vietnamese-capable font as the report PDFs
const { addQuicksandFonts } = require('../../../client/src/utils/pdfFonts.js');
const { Camera, Treatment, User } = require('../models');
const { translate, normalizeLanguage } = require('../utils/i18n');
const catchStats = require('./catchStats');
const treatmentService = require('./treatmentService');

/**
 * Cooperative report for its board: over a chosen period, every member's traps with flies per
 * trap per day (FTD) against the period before, ranked, the cooperative month by month, which
 * active ingredients worked across all members, and the treatment record as an appendix.
 * The period is parsed like the season report's (services/seasonReportService.parsePeriod).
 */
const FARM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const MARGIN = 12;
const round1 = (n) => Math.round(n * 10) / 10;
const change = (current, previous) => (current === null || previous === null || previous === 0 ? null : Math.round(((current - previous) / previous) * 100));

const dayMonthYear = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
const farmDateTime = (date) => {
    const d = new Date(new Date(date).getTime() + FARM_OFFSET_MS);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** FTD of some cameras over some days; null without data. */
function ftdOf(serials, catches, dayKeys) {
    let total = 0;
    let trapDays = 0;
    for (const serial of serials) {
        const byDay = catches.get(serial)?.total;
        if (!byDay) continue;
        for (const day of dayKeys) {
            const v = byDay.get(day);
            if (v === null || v === undefined) continue;
            total += v;
            trapDays++;
        }
    }
    return trapDays ? round1(total / trapDays) : null;
}

/** Everything the report shows, for one organization and period. */
async function coopData(org, period) {
    const cameras = await Camera.find({ orgId: org._id }).select('deviceSerial deviceName userId').lean();
    const serials = cameras.map(c => c.deviceSerial);
    // The period and the one before it, counted back from the period's last day
    const end = new Date(new Date(`${period.toKey}T12:00:00Z`).getTime() - FARM_OFFSET_MS);
    const { dayKeys, cameras: catches } = serials.length
        ? await catchStats.catchesBySerial(serials, period.days * 2, end)
        : { dayKeys: [], cameras: new Map() };
    const current = dayKeys.slice(-period.days);
    const previous = dayKeys.slice(0, -period.days);
    const months = [...new Set(current.map(d => d.slice(0, 7)))];

    const from = new Date(new Date(`${period.fromKey}T00:00:00Z`).getTime() - FARM_OFFSET_MS);
    const to = new Date(new Date(`${period.toKey}T00:00:00Z`).getTime() - FARM_OFFSET_MS + DAY_MS - 1);
    const [treatments, users] = await Promise.all([
        serials.length ? Treatment.find({ cameraSerials: { $in: serials }, at: { $gte: from, $lte: to } }).sort({ at: 1 }).lean() : [],
        User.find({ _id: { $in: [...new Set(cameras.map(c => String(c.userId)))] } }).select('name email').lean()
    ]);
    const userById = new Map(users.map(u => [String(u._id), u]));
    const ownerOf = new Map(cameras.map(c => [c.deviceSerial, String(c.userId)]));
    const names = new Map(cameras.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));

    // One row per member with traps here, the busiest first
    const owners = [...new Set(cameras.map(c => String(c.userId)))];
    const members = owners.map(id => {
        const own = cameras.filter(c => String(c.userId) === id).map(c => c.deviceSerial);
        const ftd = ftdOf(own, catches, current);
        const before = ftdOf(own, catches, previous);
        const theirs = treatments.filter(t => t.cameraSerials.some(s => own.includes(s)));
        const user = userById.get(id);
        return {
            name: user?.name || user?.email || '--',
            email: user?.email || '',
            traps: own.length,
            ftd,
            ftdPrevious: before,
            change: change(ftd, before),
            monthly: Object.fromEntries(months.map(m => [m, ftdOf(own, catches, current.filter(d => d.startsWith(m)))])),
            treatments: theirs.length,
            lastTreatmentAt: theirs.at(-1)?.at || null
        };
    }).sort((a, b) => (b.ftd ?? -1) - (a.ftd ?? -1) || a.name.localeCompare(b.name));

    const ftd = ftdOf(serials, catches, current);
    const ftdPrevious = ftdOf(serials, catches, previous);
    return {
        org: { name: org.name, members: org.members.length },
        period,
        months,
        totals: { traps: serials.length, ftd, ftdPrevious, change: change(ftd, ftdPrevious), treatments: treatments.length },
        monthly: months.map(m => ({ month: m, ftd: ftdOf(serials, catches, current.filter(d => d.startsWith(m))) })),
        members,
        ingredients: await treatmentService.effectivenessByIngredient([...treatments].reverse(), new Set(serials)),
        treatments: treatments.map(t => {
            const own = t.cameraSerials.filter(s => names.has(s));
            const member = userById.get(ownerOf.get(own[0]));
            return { ...t, traps: own.map(s => names.get(s)), member: member?.name || member?.email || '' };
        })
    };
}

/** The report as an A4 landscape PDF (Buffer). */
function buildCoopPdf(data, { language, owner, generatedAt = new Date() }) {
    const lang = normalizeLanguage(language);
    const t = (key, params) => translate(lang, `coop.${key}`, params);
    const doc = new jsPDF({ orientation: 'l', unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
    addQuicksandFonts(doc);
    const table = (startY, head, body, extra = {}) => autoTable(doc, {
        startY,
        margin: { left: MARGIN, right: MARGIN, bottom: 14 },
        head: [head],
        body,
        theme: 'grid',
        styles: { font: 'Quicksand', fontSize: 8.5, valign: 'middle', textColor: TEXT, cellPadding: 1.8 },
        headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
        didDrawPage: () => {
            const h = doc.internal.pageSize.getHeight();
            doc.setFontSize(7.5);
            doc.setTextColor(...MUTED);
            doc.text(t('footer'), MARGIN, h - 7);
        },
        ...extra
    });
    const heading = (text, y) => {
        doc.setFont('Quicksand', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(...TEXT);
        doc.text(text, MARGIN, y);
        doc.setFont('Quicksand', 'normal');
        return y + 3;
    };
    const after = () => doc.lastAutoTable.finalY + 10;
    const value = (v) => (v === null || v === undefined ? '--' : String(v));
    const pct = (v) => (v === null || v === undefined ? '--' : `${v > 0 ? '+' : ''}${v}%`);

    doc.setFont('Quicksand', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...TEXT);
    doc.text(t('title', { org: data.org.name, from: dayMonthYear(data.period.fromKey), to: dayMonthYear(data.period.toKey) }), MARGIN, 16);
    doc.setFont('Quicksand', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(t('subtitle', { owner, members: data.members.length, traps: data.totals.traps, days: data.period.days, date: farmDateTime(generatedAt) }), MARGIN, 22);
    doc.text(t('summary', { ftd: value(data.totals.ftd), previous: value(data.totals.ftdPrevious), change: pct(data.totals.change), treatments: data.totals.treatments }), MARGIN, 27);

    // 1. Members, the busiest first
    let y = heading(t('membersTitle'), 36);
    table(y, ['#', t('col.member'), t('col.traps'), t('col.ftd'), t('col.previous'), t('col.change'), t('col.treatments'), t('col.lastTreatment')],
        data.members.map((m, i) => [i + 1, m.email && m.name !== m.email ? `${m.name}\n${m.email}` : m.name, m.traps, value(m.ftd), value(m.ftdPrevious), pct(m.change), m.treatments, m.lastTreatmentAt ? farmDateTime(m.lastTreatmentAt).slice(0, 10) : '--']),
        { columnStyles: { 0: { cellWidth: 8, halign: 'center' }, 2: { halign: 'center', cellWidth: 16 }, 3: { halign: 'center', cellWidth: 26 }, 4: { halign: 'center', cellWidth: 26 }, 5: { halign: 'center', cellWidth: 22 }, 6: { halign: 'center', cellWidth: 22 } } });

    // 2. The cooperative month by month
    if (data.monthly.length) {
        y = heading(t('monthsTitle'), after());
        table(y, [t('col.month'), t('col.ftd'), ...data.members.slice(0, 5).map(m => m.name)],
            data.monthly.map(row => [`${row.month.slice(5, 7)}/${row.month.slice(0, 4)}`, value(row.ftd), ...data.members.slice(0, 5).map(m => value(m.monthly[row.month]))]),
            { columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 30, halign: 'center' } } });
    }

    // 3. Which active ingredients worked, across members
    y = heading(t('ingredientsTitle'), after());
    if (data.ingredients.length) {
        table(y, [t('col.ingredient'), t('col.products'), t('col.uses'), t('col.avgChange'), t('col.clearlyWorked')],
            data.ingredients.map(g => [g.name, g.products.join(', ') || '--', t('usesValue', { uses: g.uses, measured: g.measured }), pct(g.avgChangePct), g.measured ? `${g.effective}/${g.measured}` : '--']));
    } else {
        doc.setFontSize(9);
        doc.setTextColor(...MUTED);
        doc.text(t('noTreatments'), MARGIN, y + 4);
    }

    // Appendix: the treatment record of every member
    if (data.treatments.length) {
        doc.addPage();
        y = heading(t('recordTitle'), 16);
        table(y, ['#', t('col.date'), t('col.member'), t('col.trapsList'), t('col.type'), t('col.product'), t('col.ingredient'), t('col.dose'), t('col.operator'), t('col.phi')],
            data.treatments.map((r, i) => [
                i + 1, farmDateTime(r.at), r.member || '--', r.traps.join(', '),
                translate(lang, `vietgap.types.${r.type}`), r.product || '', r.activeIngredient || '', r.dose || '',
                r.operator || r.createdByEmail || '', Number.isInteger(r.preHarvestDays) ? String(r.preHarvestDays) : ''
            ]),
            { styles: { font: 'Quicksand', fontSize: 7.5, valign: 'middle', textColor: TEXT, cellPadding: 1.5 }, columnStyles: { 0: { cellWidth: 8, halign: 'center' }, 1: { cellWidth: 26 }, 9: { cellWidth: 14, halign: 'center' } } });
    }
    return Buffer.from(doc.output('arraybuffer'));
}

module.exports = {
    coopData,
    buildCoopPdf
};
