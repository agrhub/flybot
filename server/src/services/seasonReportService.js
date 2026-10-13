const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
// Same Vietnamese-capable font as the report PDFs
const { addQuicksandFonts } = require('../../../client/src/utils/pdfFonts.js');
const { Farm, Plot, Camera, Treatment } = require('../models');
const { getViewableSerials } = require('../utils/ownership');
const { translate, normalizeLanguage } = require('../utils/i18n');
const catchStats = require('./catchStats');
const dailyStats = require('./dailyStats');
const treatmentService = require('./treatmentService');
const farmService = require('./farmService');
const { orgRolesOf } = require('./orgService');

/**
 * Season report for a cooperative: over a chosen period, every farm the person can see with
 * its flies per trap per day (FTD), month by month, its worst plot and busiest days, the
 * treatments and which active ingredients worked, and the treatment record as an appendix.
 */
const MAX_DAYS = 366;
const DEFAULT_DAYS = 182;
// Farms side by side in the month table (the busiest ones); more would not fit the page
const MONTH_COLUMNS = 6;
const PEAK_DAYS = 3;

const FARM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const MARGIN = 12;
const round1 = (n) => Math.round(n * 10) / 10;

const dayMonthYear = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
const farmDateTime = (date) => {
    const d = new Date(new Date(date).getTime() + FARM_OFFSET_MS);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/**
 * The period from ?from=YYYY-MM-DD&to=YYYY-MM-DD (farm days, both included), the last 6 months
 * by default. Returns { fromKey, toKey, days } or { error }.
 */
function parsePeriod({ from, to } = {}, now = new Date()) {
    const today = dailyStats.dayKeyOf(now);
    const valid = (key) => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && !isNaN(new Date(`${key}T00:00:00Z`));
    const toKey = to === undefined || to === '' ? today : to;
    const fromKey = from === undefined || from === '' ? dailyStats.addDays(toKey, -(DEFAULT_DAYS - 1)) : from;
    if (!valid(fromKey) || !valid(toKey)) return { error: 'Dates must be YYYY-MM-DD.' };
    if (toKey > today || fromKey > toKey) return { error: 'The period must end today at the latest and start before it ends.' };
    const days = Math.round((new Date(`${toKey}T00:00:00Z`) - new Date(`${fromKey}T00:00:00Z`)) / DAY_MS) + 1;
    if (days > MAX_DAYS) return { error: 'The period can be at most a year.' };
    return { fromKey, toKey, days };
}

/** FTD of some cameras over some days, from catchesBySerial's per-camera maps. */
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

/** Everything the report shows, for one person and period. */
async function seasonData(user, period) {
    const withRoles = user.orgRoles ? user : { _id: user._id, id: user.id, role: user.role, orgRoles: await orgRolesOf(user) };
    const farms = await Farm.find(farmService.farmViewFilter(withRoles)).select('name').sort({ name: 1 }).lean();
    const visible = new Set(await getViewableSerials(user));
    const farmIds = farms.map(f => f._id);
    const [plots, farmCameras] = await Promise.all([
        Plot.find({ farmId: { $in: farmIds } }).select('farmId name').lean(),
        Camera.find({ farmId: { $in: farmIds } }).select('deviceSerial deviceName farmId plotId').lean()
    ]);
    const cameras = farmCameras.filter(c => visible.has(c.deviceSerial));
    const serials = cameras.map(c => c.deviceSerial);
    // catchesBySerial counts back from a day: the period's last day
    const end = new Date(new Date(`${period.toKey}T12:00:00Z`).getTime() - FARM_OFFSET_MS);
    const { dayKeys, cameras: catches } = serials.length
        ? await catchStats.catchesBySerial(serials, period.days, end)
        : { dayKeys: [], cameras: new Map() };
    const months = [...new Set(dayKeys.map(d => d.slice(0, 7)))];

    const farmRows = farms.map(farm => {
        const own = cameras.filter(c => String(c.farmId) === String(farm._id));
        const ownSerials = own.map(c => c.deviceSerial);
        const plotRows = plots.filter(p => String(p.farmId) === String(farm._id))
            .map(plot => ({ name: plot.name, ftd: ftdOf(own.filter(c => String(c.plotId) === String(plot._id)).map(c => c.deviceSerial), catches, dayKeys) }))
            .filter(p => p.ftd !== null)
            .sort((a, b) => b.ftd - a.ftd);
        const daily = dayKeys.map(day => ({ day, ftd: ftdOf(ownSerials, catches, [day]) })).filter(d => d.ftd !== null);
        return {
            id: String(farm._id),
            name: farm.name,
            traps: ownSerials.length,
            serials: ownSerials,
            ftd: ftdOf(ownSerials, catches, dayKeys),
            worstPlot: plotRows[0] || null,
            monthly: Object.fromEntries(months.map(m => [m, ftdOf(ownSerials, catches, dayKeys.filter(d => d.startsWith(m)))])),
            peaks: [...daily].sort((a, b) => b.ftd - a.ftd || a.day.localeCompare(b.day)).slice(0, PEAK_DAYS)
        };
    }).sort((a, b) => (b.ftd ?? -1) - (a.ftd ?? -1) || a.name.localeCompare(b.name));

    const from = new Date(new Date(`${period.fromKey}T00:00:00Z`).getTime() - FARM_OFFSET_MS);
    const to = new Date(new Date(`${period.toKey}T00:00:00Z`).getTime() - FARM_OFFSET_MS + DAY_MS - 1);
    const treatments = serials.length
        ? await Treatment.find({ cameraSerials: { $in: serials }, at: { $gte: from, $lte: to } }).sort({ at: 1 }).lean()
        : [];
    const names = new Map(cameras.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
    const farmOf = new Map(cameras.map(c => [c.deviceSerial, farms.find(f => String(f._id) === String(c.farmId))?.name]));
    for (const farm of farmRows) farm.treatments = treatments.filter(t => t.cameraSerials.some(s => farm.serials.includes(s))).length;
    const ingredients = await treatmentService.effectivenessByIngredient([...treatments].reverse(), new Set(serials));

    return {
        period,
        months,
        farms: farmRows,
        ingredients,
        treatments: treatments.map(t => {
            const own = t.cameraSerials.filter(s => names.has(s));
            return { ...t, traps: own.map(s => names.get(s)), farms: [...new Set(own.map(s => farmOf.get(s)).filter(Boolean))] };
        })
    };
}

/** The report as an A4 landscape PDF (Buffer). */
function buildSeasonPdf(data, { language, owner, generatedAt = new Date() }) {
    const lang = normalizeLanguage(language);
    const t = (key, params) => translate(lang, `season.${key}`, params);
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

    doc.setFont('Quicksand', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...TEXT);
    doc.text(t('title', { from: dayMonthYear(data.period.fromKey), to: dayMonthYear(data.period.toKey) }), MARGIN, 16);
    doc.setFont('Quicksand', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(t('subtitle', { owner, farms: data.farms.length, days: data.period.days, date: farmDateTime(generatedAt) }), MARGIN, 22);
    doc.text(t('ftdNote'), MARGIN, 27);

    // 1. Farms
    let y = heading(t('farmsTitle'), 36);
    table(y, [t('col.farm'), t('col.traps'), t('col.ftd'), t('col.worstPlot'), t('col.peaks'), t('col.treatments')],
        data.farms.map(f => [
            f.name, f.traps, value(f.ftd),
            f.worstPlot ? `${f.worstPlot.name} (${f.worstPlot.ftd})` : '--',
            f.peaks.length ? f.peaks.map(p => `${dayMonthYear(p.day).slice(0, 5)} (${p.ftd})`).join(', ') : '--',
            f.treatments
        ]),
        { columnStyles: { 1: { halign: 'center', cellWidth: 16 }, 2: { halign: 'center', cellWidth: 26 }, 5: { halign: 'center', cellWidth: 22 } } });

    // 2. Month by month (the busiest farms)
    const shown = data.farms.filter(f => f.traps > 0).slice(0, MONTH_COLUMNS);
    if (shown.length && data.months.length) {
        y = heading(t('monthsTitle'), after());
        table(y, [t('col.month'), ...shown.map(f => f.name)],
            data.months.map(m => [`${m.slice(5, 7)}/${m.slice(0, 4)}`, ...shown.map(f => value(f.monthly[m]))]),
            { columnStyles: { 0: { cellWidth: 24 } } });
        if (data.farms.filter(f => f.traps > 0).length > MONTH_COLUMNS) {
            doc.setFontSize(8);
            doc.setTextColor(...MUTED);
            doc.text(t('monthsMore', { count: MONTH_COLUMNS }), MARGIN, doc.lastAutoTable.finalY + 5);
        }
    }

    // 3. Which active ingredients worked
    y = heading(t('ingredientsTitle'), after());
    if (data.ingredients.length) {
        table(y, [t('col.ingredient'), t('col.products'), t('col.uses'), t('col.avgChange'), t('col.clearlyWorked')],
            data.ingredients.map(g => [
                g.name, g.products.join(', ') || '--', t('usesValue', { uses: g.uses, measured: g.measured }),
                g.avgChangePct === null ? '--' : `${g.avgChangePct > 0 ? '+' : ''}${g.avgChangePct}%`,
                g.measured ? `${g.effective}/${g.measured}` : '--'
            ]));
    } else {
        doc.setFontSize(9);
        doc.setTextColor(...MUTED);
        doc.text(t('noTreatments'), MARGIN, y + 4);
    }

    // 4. Appendix: the treatment record (VietGAP)
    if (data.treatments.length) {
        doc.addPage();
        y = heading(t('recordTitle'), 16);
        table(y, ['#', t('col.date'), t('col.farm'), t('col.trapsList'), t('col.type'), t('col.product'), t('col.ingredient'), t('col.dose'), t('col.operator'), t('col.phi')],
            data.treatments.map((r, i) => [
                i + 1, farmDateTime(r.at), r.farms.join(', ') || '--', r.traps.join(', '),
                translate(lang, `vietgap.types.${r.type}`), r.product || '', r.activeIngredient || '', r.dose || '',
                r.operator || r.createdByEmail || '', Number.isInteger(r.preHarvestDays) ? String(r.preHarvestDays) : ''
            ]),
            { styles: { font: 'Quicksand', fontSize: 7.5, valign: 'middle', textColor: TEXT, cellPadding: 1.5 }, columnStyles: { 0: { cellWidth: 8, halign: 'center' }, 1: { cellWidth: 26 }, 9: { cellWidth: 14, halign: 'center' } } });
    }
    return Buffer.from(doc.output('arraybuffer'));
}

module.exports = {
    MAX_DAYS,
    DEFAULT_DAYS,
    parsePeriod,
    seasonData,
    buildSeasonPdf
};
