import { loadPdf } from '@/utils/lazyLibs';
import { speciesName } from '@/utils/species';
import { formatDayKey, formatPeriod, formatNumber, formatChange, rangeLabel } from '@/utils/dashboards';

// PDF colors (the PDF is always printed on white)
const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const MARGIN = 14;

const fullDay = (key) => (key ? key.split('-').reverse().join('/') : '');

// A chart canvas on a white background (charts are drawn on a transparent one)
function chartImage(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out.toDataURL('image/png');
}

/**
 * Save a report as an A4 PDF: title, time range, then each widget in page order.
 * Charts are copied from the page (`root` holds the rendered widgets); tables and figures are
 * written from the data, so they stay sharp and searchable.
 */
export async function exportReportPdf({ t, locale, report, range, widgets, data, generatedAt, root }) {
  const { jsPDF, autoTable, addQuicksandFonts } = await loadPdf();
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
  addQuicksandFonts(doc);
  doc.setFont('Quicksand', 'normal');

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const width = pageWidth - 2 * MARGIN;
  const dateLocale = locale === 'vi' ? 'vi-VN' : 'en-US';
  let y = 20;

  const ensure = (height) => {
    if (y + height > pageHeight - 16) {
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
      body: body.length ? body : [[t('dashboards.noDetections'), ...head.slice(1).map(() => '')]],
      // Short tables stay on one page
      pageBreak: body.length <= 20 ? 'avoid' : 'auto',
      theme: 'grid',
      styles: { font: 'Quicksand', fontSize: 8.5, valign: 'middle', textColor: TEXT },
      headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles,
    });
    y = doc.lastAutoTable.finalY + 8;
  };
  // A widget's chart as drawn on the page, scaled to the page width (narrow charts: at most 75 mm high)
  const chartOf = (widgetId) => {
    const canvas = root?.querySelector(`[data-widget-id="${widgetId}"] canvas`);
    if (!canvas || !canvas.width || !canvas.height || canvas.offsetParent === null) return null;
    const height = Math.min(75, (width * canvas.height) / canvas.width);
    return { canvas, height, width: (height * canvas.width) / canvas.height };
  };
  const chart = (found) => {
    if (!found) {
      write(t('dashboards.noDetections'));
      y += 3;
      return;
    }
    ensure(found.height + 4);
    doc.addImage(chartImage(found.canvas), 'PNG', MARGIN, y, found.width, found.height);
    y += found.height + 8;
  };

  // Title and range
  write(report.name, { size: 18, color: BRAND, bold: true, gap: 8 });
  if (report.description) write(report.description, { size: 10, color: TEXT });
  y += 1;
  write(t('dashboards.pdf.range', { range: rangeLabel(t, range), from: fullDay(range?.from), to: fullDay(range?.to) }));
  write(t('dashboards.pdf.generated', { time: new Date(generatedAt || Date.now()).toLocaleString(dateLocale) }));
  y += 4;

  for (const widget of widgets) {
    const d = data?.[widget.id];
    const found = ['trend', 'species', 'catchesByTrap'].includes(widget.type) ? chartOf(widget.id) : null;
    // Keep a title with the start of what follows it
    ensure(found ? found.height + 12 : 28);
    write(widget.title || t(`dashboards.widgetTypes.${widget.type}`), { size: 12, color: TEXT, bold: true, gap: 7 });
    // The widget's own filters
    const own = [
      ...(widget.range?.preset && d?.range ? [t('dashboards.pdf.ownRange', { from: fullDay(d.range.from), to: fullDay(d.range.to) })] : []),
      ...(widget.status && widget.status !== 'all' ? [t(`filters.statuses.${widget.status}`)] : []),
      ...(widget.risk && widget.risk !== 'all' ? [t(`filters.risks.${widget.risk}`)] : []),
    ];
    if (own.length) write(own.join(' · '));
    if (!d) {
      write(t('dashboards.noDetections'));
      y += 3;
      continue;
    }
    switch (widget.type) {
      case 'kpi':
        table([t('dashboards.pdf.figure'), t('dashboards.pdf.value')], [
          [t('dashboards.kpi.catches'), `${formatNumber(d.catches)} (${d.previousCatches === null ? t('dashboards.kpi.noPrevious') : t('dashboards.kpi.vsPrevious', { change: formatChange(d.changePct), previous: formatNumber(d.previousCatches) })})`],
          [t('dashboards.kpi.ftd'), `${formatNumber(d.ftd)} (${d.previousFtd === null ? t('dashboards.kpi.noPrevious') : t('dashboards.kpi.previousValue', { value: formatNumber(d.previousFtd) })})`],
          [t('dashboards.kpi.avgPerDay'), formatNumber(d.avgPerDay)],
          [t('dashboards.kpi.busiestDay'), d.busiestDay ? `${formatNumber(d.busiestDay.value)} (${fullDay(d.busiestDay.day)})` : '--'],
          [t('dashboards.kpi.alertCameras'), String(d.alertCameras)],
          [t('dashboards.kpi.cameras'), `${d.cameras} (${t('dashboards.kpi.online', { count: d.online })})`],
          [t('dashboards.kpi.scans'), String(d.scans)],
        ], { 0: { cellWidth: 70 } });
        break;
      case 'trend':
      case 'species':
      case 'catchesByTrap':
        chart(found);
        break;
      case 'cameraRanking':
        table(
          ['#', t('dashboards.ranking.trap'), t('trapKind.label'), t('dashboards.ranking.total'), t('dashboards.ranking.ftd'), t('dashboards.ranking.change'), t('dashboards.ranking.busiestDay'), t('dashboards.ranking.latest')],
          (d.cameras || []).map((c, i) => [
            i + 1,
            c.deviceName,
            t(`trapKind.${c.trapKind}.short`),
            formatNumber(c.total),
            formatNumber(c.ftd),
            formatChange(c.changePct),
            c.busiestDay ? `${formatNumber(c.busiestDay.value)} (${formatDayKey(c.busiestDay.day)})` : '--',
            `${c.latestCount} / ${c.threshold}`,
          ]),
          { 0: { cellWidth: 8 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } }
        );
        break;
      case 'dailyTable':
        table(
          [t(`dashboards.periodUnit.${d.unit}`), t('dashboards.ranking.total'), t('dashboards.ranking.ftd'), t('dashboards.topSpecies')],
          (d.rows || []).map(r => [
            formatPeriod(r.from, r.to, d.unit),
            formatNumber(r.total),
            formatNumber(r.ftd),
            r.topSpecies ? `${speciesName(r.topSpecies.label, t)} (${r.topSpecies.value})` : '--',
          ]),
          { 1: { halign: 'right' }, 2: { halign: 'right' } }
        );
        break;
      case 'activity': {
        if (d.windowDays) write(t('dashboards.lastDays', { days: d.windowDays }));
        const rows = (d.hours || []).map((h, i) => [`${h}:00 - ${h + 1}:00`, formatNumber(Math.round((d.byHour?.[i] || 0) * 10) / 10)]);
        table([t('dashboards.pdf.hour'), t('dashboards.kpi.fliesUnit')], rows.filter(r => r[1] !== '0'), { 1: { halign: 'right' } });
        break;
      }
      case 'latestSnapshot':
        table(
          [t('dashboards.ranking.trap'), t('dashboards.pdf.count'), t('dashboards.pdf.time')],
          (d.snapshots || []).map(s => [s.deviceName, String(s.count), s.createdAt ? new Date(s.createdAt).toLocaleString(dateLocale) : t('dashboards.noSnapshot')]),
          { 1: { halign: 'right' } }
        );
        break;
      default:
        break;
    }
  }

  // Page numbers
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('Quicksand', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(t('common.brandName'), MARGIN, pageHeight - 8);
    doc.text(`${i} / ${pages}`, pageWidth - MARGIN, pageHeight - 8, { align: 'right' });
  }

  const safeName = String(report.name || 'report').replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40);
  doc.save(`FlyBot_${safeName}_${range?.from || ''}_${range?.to || ''}.pdf`);
}
