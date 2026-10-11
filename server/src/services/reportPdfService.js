const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
// Same Vietnamese-capable font as the PDFs made in the browser
const { addQuicksandFonts } = require('../../../client/src/utils/pdfFonts.js');
const { translate } = require('../utils/i18n');
const { TIMEZONE } = require('./captureSchedule');

/**
 * A report (dashboard) as a PDF made on the server, for scheduled emails: the same widgets in
 * page order as the browser export, with tables and simple vector bar charts (no browser canvas).
 */

const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const GRID = [229, 231, 235];
const SERIES = [[16, 185, 129], [245, 158, 11], [239, 68, 68], [100, 116, 139], [59, 130, 246], [139, 92, 246], [236, 72, 153], [20, 184, 166]];
const MARGIN = 14;

const SPECIES_KEYS = { fruit_fly: 'fruitFly', bug: 'bug', caterpillar: 'caterpillar', moth: 'moth' };
const ALIASES = [
    ['fruit_fly', ['fruit_fly', 'fruit fly', 'fruit-fly', 'bactrocera', 'ruồi vàng', 'ruoi vang']],
    ['moth', ['moth', 'bướm']],
    ['caterpillar', ['caterpillar', 'sâu']],
    ['bug', ['bug', 'bọ']]
];
function speciesLabel(t, label) {
    const s = String(label || '').toLowerCase();
    const key = ALIASES.find(([, list]) => list.some(a => s.includes(a)))?.[0];
    return key ? t(`reportPdf.species.${SPECIES_KEYS[key]}`) : String(label || '--');
}

const fullDay = (key) => (key ? key.split('-').reverse().join('/') : '');
const shortDay = (key, unit) => {
    if (!key) return '';
    const [y, m, d] = key.split('-');
    return unit === 'month' ? `${m}/${y}` : `${d}/${m}`;
};
const period = (from, to, unit) => (unit === 'month' ? shortDay(from, 'month') : unit === 'week' && to !== from ? `${shortDay(from)} - ${shortDay(to)}` : shortDay(from));
const num = (v) => (v === null || v === undefined ? '--' : String(v));
const change = (pct) => (pct === null || pct === undefined ? '--' : `${pct > 0 ? '+' : ''}${pct}%`);

/**
 * Stacked bars drawn with rectangles: labels on x, one or more series, a legend when several.
 */
function drawBars(doc, { x, y, width, height, labels, series }) {
    const sums = labels.map((_, i) => series.reduce((sum, s) => sum + (Number(s.data[i]) || 0), 0));
    const max = Math.max(1, ...sums);
    const plotLeft = x + 10;
    const plotWidth = width - 10;
    const plotHeight = height - (series.length > 1 ? 16 : 8);
    const bottom = y + plotHeight;

    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.setDrawColor(...GRID);
    doc.setLineWidth(0.2);
    for (const fraction of [0, 0.5, 1]) {
        const lineY = bottom - fraction * plotHeight;
        doc.line(plotLeft, lineY, plotLeft + plotWidth, lineY);
        doc.text(String(Math.round(max * fraction * 10) / 10), plotLeft - 1.5, lineY + 1, { align: 'right' });
    }

    const slot = plotWidth / Math.max(1, labels.length);
    const barWidth = Math.max(0.6, slot * 0.7);
    const every = Math.ceil(labels.length / 16);
    labels.forEach((label, i) => {
        let top = bottom;
        series.forEach((s, k) => {
            const value = Number(s.data[i]) || 0;
            if (!value) return;
            const h = (value / max) * plotHeight;
            doc.setFillColor(...SERIES[k % SERIES.length]);
            doc.rect(plotLeft + i * slot + (slot - barWidth) / 2, top - h, barWidth, h, 'F');
            top -= h;
        });
        if (i % every === 0) doc.text(label, plotLeft + i * slot + slot / 2, bottom + 3.5, { align: 'center' });
    });

    if (series.length > 1) {
        let legendX = plotLeft;
        const legendY = bottom + 9;
        for (const [k, s] of series.entries()) {
            doc.setFillColor(...SERIES[k % SERIES.length]);
            doc.rect(legendX, legendY - 2.2, 3, 3, 'F');
            doc.text(String(s.name), legendX + 4, legendY);
            legendX += 6 + doc.getTextWidth(String(s.name)) + 4;
            if (legendX > x + width - 30) break;
        }
    }
}

/**
 * Build the PDF. `range` is what the data covers ({ from, to, days }), `language` 'vi' | 'en'.
 * Returns a Buffer.
 */
function buildReportPdf({ dashboard, data, range, language, generatedAt = new Date() }) {
    const t = (key, params) => translate(language, key, params);
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
    addQuicksandFonts(doc);
    doc.setFont('Quicksand', 'normal');
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const width = pageWidth - 2 * MARGIN;
    let y = 20;

    const ensure = (h) => {
        if (y + h > pageHeight - 16) {
            doc.addPage();
            y = 18;
        }
    };
    const write = (text, { size = 9, color = MUTED, bold = false, gap = 5 } = {}) => {
        doc.setFont('Quicksand', bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        doc.setTextColor(...color);
        for (const line of doc.splitTextToSize(String(text), width)) {
            ensure(gap);
            doc.text(line, MARGIN, y);
            y += gap;
        }
    };
    const table = (head, body, columnStyles = {}) => {
        autoTable(doc, {
            startY: y,
            margin: { left: MARGIN, right: MARGIN },
            head: [head],
            body: body.length ? body : [[t('reportPdf.noData'), ...head.slice(1).map(() => '')]],
            pageBreak: body.length <= 20 ? 'avoid' : 'auto',
            theme: 'grid',
            styles: { font: 'Quicksand', fontSize: 8.5, valign: 'middle', textColor: TEXT },
            headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
            columnStyles
        });
        y = doc.lastAutoTable.finalY + 8;
    };
    const bars = (labels, series) => {
        const height = 62;
        ensure(height + 4);
        drawBars(doc, { x: MARGIN, y, width, height, labels, series });
        y += height + 6;
    };

    write(dashboard.name, { size: 18, color: BRAND, bold: true, gap: 8 });
    if (dashboard.description) write(dashboard.description, { size: 10, color: TEXT });
    y += 1;
    write(t('reportPdf.range', { from: fullDay(range.from), to: fullDay(range.to), days: range.days }));
    write(t('reportPdf.generated', { time: generatedAt.toLocaleString(language === 'vi' ? 'vi-VN' : 'en-US', { timeZone: TIMEZONE }) }));
    y += 4;

    const widgets = [...(dashboard.widgets || [])].sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0));
    for (const widget of widgets) {
        const d = data?.[widget.id];
        ensure(30);
        write(widget.title || t(`reportPdf.widgets.${widget.type}`), { size: 12, color: TEXT, bold: true, gap: 7 });
        if (d?.range?.own) write(t('reportPdf.ownRange', { from: fullDay(d.range.from), to: fullDay(d.range.to) }));
        if (!d) {
            write(t('reportPdf.noData'));
            y += 3;
            continue;
        }
        switch (widget.type) {
            case 'kpi':
                table([t('reportPdf.figure'), t('reportPdf.value')], [
                    [t('reportPdf.kpi.catches'), `${num(d.catches)} (${d.previousCatches === null ? t('reportPdf.kpi.noPrevious') : t('reportPdf.kpi.vsPrevious', { change: change(d.changePct), previous: num(d.previousCatches) })})`],
                    [t('reportPdf.kpi.ftd'), num(d.ftd)],
                    [t('reportPdf.kpi.avgPerDay'), num(d.avgPerDay)],
                    [t('reportPdf.kpi.busiestDay'), d.busiestDay ? `${num(d.busiestDay.value)} (${fullDay(d.busiestDay.day)})` : '--'],
                    [t('reportPdf.kpi.alertCameras'), String(d.alertCameras)],
                    [t('reportPdf.kpi.cameras'), t('reportPdf.kpi.online', { cameras: d.cameras, online: d.online })],
                    [t('reportPdf.kpi.scans'), String(d.scans)]
                ], { 0: { cellWidth: 70 } });
                break;
            case 'trend': {
                const points = d.points || [];
                if (!points.some(p => p.value)) {
                    write(t('reportPdf.noData'));
                    y += 3;
                    break;
                }
                bars(points.map(p => shortDay(p.date, d.unit)), [{ name: t('reportPdf.thisPeriod'), data: points.map(p => p.value) }]);
                break;
            }
            case 'catchesByTrap': {
                const series = (d.series || []).filter(s => s.data.some(v => v));
                if (!series.length) {
                    write(t('reportPdf.noData'));
                    y += 3;
                    break;
                }
                bars((d.labels || []).map(k => shortDay(k, d.unit)), series.map(s => ({ name: s.deviceName, data: s.data })));
                break;
            }
            case 'species': {
                const all = (d.species || []).reduce((sum, sp) => sum + sp.value, 0) || 1;
                table([t('reportPdf.species.title'), t('reportPdf.flies'), '%'],
                    (d.species || []).map(sp => [speciesLabel(t, sp.label), num(sp.value), `${Math.round((sp.value / all) * 100)}%`]),
                    { 1: { halign: 'right' }, 2: { halign: 'right' } });
                break;
            }
            case 'cameraRanking':
                table([t('reportPdf.ranking.trap'), t('reportPdf.ranking.total'), t('reportPdf.ranking.ftd'), t('reportPdf.ranking.change'), t('reportPdf.ranking.latest')],
                    (d.cameras || []).map(c => [
                        c.deviceName,
                        num(c.total),
                        num(c.ftd),
                        change(c.changePct),
                        `${c.riskValue ?? c.latestCount} / ${c.threshold}${c.riskBasis === 'dailyAverage' ? ` (${t('reportPdf.ranking.averageToday')})` : ''}`
                    ]),
                    { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } });
                break;
            case 'dailyTable':
                table([t(`reportPdf.unit.${d.unit}`), t('reportPdf.ranking.total'), t('reportPdf.ranking.ftd'), t('reportPdf.topSpecies')],
                    (d.rows || []).map(r => [period(r.from, r.to, d.unit), num(r.total), num(r.ftd), r.topSpecies ? `${speciesLabel(t, r.topSpecies.label)} (${r.topSpecies.value})` : '--']),
                    { 1: { halign: 'right' }, 2: { halign: 'right' } });
                break;
            case 'activity':
                table([t('reportPdf.hour'), t('reportPdf.flies')],
                    (d.hours || []).map((h, i) => [`${h}:00 - ${h + 1}:00`, num(Math.round((d.byHour?.[i] || 0) * 10) / 10)]).filter(r => r[1] !== '0'),
                    { 1: { halign: 'right' } });
                break;
            case 'latestSnapshot':
                table([t('reportPdf.ranking.trap'), t('reportPdf.onTrap'), t('reportPdf.photoTime')],
                    (d.snapshots || []).map(s => [s.deviceName, String(s.count), s.createdAt ? new Date(s.createdAt).toLocaleString(language === 'vi' ? 'vi-VN' : 'en-US', { timeZone: TIMEZONE }) : '--']),
                    { 1: { halign: 'right' } });
                break;
            default:
                break;
        }
    }

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFont('Quicksand', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...MUTED);
        doc.text('FlyBot', MARGIN, pageHeight - 8);
        doc.text(`${i} / ${pages}`, pageWidth - MARGIN, pageHeight - 8, { align: 'right' });
    }
    return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildReportPdf };
