import { newPdf, addHistoryTable, addPageNumbers } from '@/utils/historyExport';
import { chartImage } from '@/utils/pdfCharts';

const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const MARGIN = 12;

/**
 * The analytics page as one PDF (landscape A4). Each tab gives its sections, built from what it
 * shows with its own filters:
 *   { part?, title, lines?, chart?: Chart.js config, table?: { head, body, columnStyles? }, history?: items }
 * `part` starts a new chapter (Trends, Insights, History) on a new page.
 */
export async function exportAnalyticsPdf({ t, locale, title, lines, sections, fileName, onProgress }) {
  const { doc, autoTable } = await newPdf('l');
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const width = pageWidth - 2 * MARGIN;
  let y = 16;

  const ensure = (height) => {
    if (y + height > pageHeight - 14) {
      doc.addPage();
      y = 16;
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

  write(title, { size: 18, color: BRAND, bold: true, gap: 8 });
  for (const line of lines) write(line);
  y += 3;

  let first = true;
  for (const section of sections) {
    if (section.part) {
      if (!first) {
        doc.addPage();
        y = 16;
      }
      write(section.part, { size: 15, color: BRAND, bold: true, gap: 8 });
    }
    first = false;
    const image = section.chart ? await chartImage(section.chart, section.chartSize) : null;
    const imageHeight = image ? Math.min(80, (width * (section.chartSize?.height || 420)) / (section.chartSize?.width || 1000)) : 0;
    // Keep a title with the start of its content
    ensure(image ? imageHeight + 16 : 24);
    write(section.title, { size: 12, color: TEXT, bold: true, gap: 6 });
    for (const line of section.lines || []) write(line);
    if (image) {
      const imageWidth = (imageHeight * (section.chartSize?.width || 1000)) / (section.chartSize?.height || 420);
      doc.addImage(image, 'PNG', MARGIN, y, Math.min(width, imageWidth), imageHeight);
      y += imageHeight + 6;
    }
    if (section.table) {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [section.table.head],
        body: section.table.body.length ? section.table.body : [[t('analytics.noStatsData'), ...section.table.head.slice(1).map(() => '')]],
        // Short tables stay on one page
        pageBreak: section.table.body.length <= 20 ? 'avoid' : 'auto',
        theme: 'grid',
        styles: { font: 'Quicksand', fontSize: 8, valign: 'middle', textColor: TEXT },
        headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
        columnStyles: section.table.columnStyles || {},
      });
      y = doc.lastAutoTable.finalY + 8;
    }
    if (!image && !section.table && !section.history) {
      write(t('analytics.noStatsData'));
      y += 2;
    }
    if (section.history) {
      y = await addHistoryTable(doc, autoTable, { t, locale, items: section.history, startY: y, onProgress });
    }
    y += 2;
  }

  addPageNumbers(doc, t);
  doc.save(fileName);
}
