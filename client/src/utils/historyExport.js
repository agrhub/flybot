import api from '@/services/api';
import { loadPdf, loadExcelWriter } from '@/utils/lazyLibs';
import { formatSummary } from '@/utils/species';
import { annotatedImage, mapLimit } from '@/utils/detectionImage';

// PDF colors (printed on white)
const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const PAGE_SIZE = 500;
const IMAGE_CONCURRENCY = 4;

const dateLocaleOf = (locale) => (locale === 'vi' ? 'vi-VN' : 'en-US');

/**
 * Every record matching the history filters (not only the page on screen), newest first.
 * `query`: the api.getHistory filters without page and limit.
 */
export async function fetchAllHistory(query, onProgress) {
  const items = [];
  let page = 1;
  let total = Infinity;
  while (items.length < total) {
    const res = await api.getHistory({ ...query, page, limit: PAGE_SIZE });
    const results = res.data?.results || [];
    total = res.data?.total ?? results.length;
    items.push(...results);
    onProgress?.(items.length, total);
    if (!results.length) break;
    page++;
  }
  return items;
}

const riskText = (t, item) => t(`history.risk.${item.risk || 'low'}`);
const reviewText = (t, item) => (item.review?.status ? t(`analytics.review.status.${item.review.status}`) : '');
const speciesText = (t, item) => formatSummary(item.aiResults?.summary, t) || t('analytics.report.notIdentified');

/**
 * Write the history table, one row per photo with the photo and its detection boxes, into `doc`
 * from `startY`. Returns the y after the table.
 */
export async function addHistoryTable(doc, autoTable, { t, locale, items, startY = 20, onProgress }) {
  const dateLocale = dateLocaleOf(locale);
  const images = await mapLimit(items, IMAGE_CONCURRENCY, item => annotatedImage(item, { t, maxWidth: 560 }), onProgress);
  const IMAGE_W = 62;

  autoTable(doc, {
    startY,
    margin: { left: 12, right: 12 },
    head: [[
      '#',
      t('analytics.report.colTime'),
      t('history.colCamera'),
      t('analytics.report.colSnapshot'),
      t('analytics.report.colCount'),
      t('history.colAlarm'),
      t('analytics.report.colSpecies'),
      t('history.colReview'),
      t('analytics.report.colAiAssessment'),
    ]],
    body: items.length
      ? items.map((item, i) => [
        i + 1,
        new Date(item.createdAt).toLocaleString(dateLocale),
        item.deviceName || item.deviceSerial,
        '',
        `${item.pestCount ?? 0} / ${item.threshold ?? '--'}`,
        riskText(t, item),
        speciesText(t, item),
        reviewText(t, item),
        item.aiResults?.raw_description || '--',
      ])
      : [['', t('analytics.report.noDataInRange'), '', '', '', '', '', '', '']],
    theme: 'grid',
    // A row never splits across pages, so each photo keeps its size
    rowPageBreak: 'avoid',
    styles: { font: 'Quicksand', fontSize: 7.5, valign: 'middle', textColor: TEXT, overflow: 'linebreak' },
    headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      1: { cellWidth: 26 },
      2: { cellWidth: 26 },
      3: { cellWidth: IMAGE_W + 4, minCellHeight: 44 },
      4: { cellWidth: 16, halign: 'center' },
      5: { cellWidth: 20 },
      6: { cellWidth: 34 },
      7: { cellWidth: 18 },
      8: { cellWidth: 'auto' },
    },
    didParseCell: (data) => {
      // Alarm status in color
      if (data.section === 'body' && data.column.index === 5 && items[data.row.index]) {
        const risk = items[data.row.index].risk;
        if (risk === 'high') data.cell.styles.textColor = [220, 38, 38];
        else if (risk === 'moderate') data.cell.styles.textColor = [217, 119, 6];
      }
    },
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 3) return;
      const image = images[data.row.index];
      if (!image) return;
      const height = Math.min(data.cell.height - 4, (IMAGE_W * image.height) / image.width);
      const width = (height * image.width) / image.height;
      try {
        doc.addImage(image.dataUrl, 'JPEG', data.cell.x + 2, data.cell.y + 2, width, height);
      } catch {
        // A broken photo leaves the cell empty
      }
    },
  });
  return doc.lastAutoTable.finalY + 8;
}

function writeHeader(doc, { title, lines }) {
  doc.setFont('Quicksand', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...BRAND);
  doc.text(title, 12, 16);
  doc.setFont('Quicksand', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  let y = 23;
  for (const line of lines) {
    doc.text(line, 12, y);
    y += 5;
  }
  return y + 2;
}

export function addPageNumbers(doc, t) {
  const pages = doc.getNumberOfPages();
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('Quicksand', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(t('common.brandName'), 12, height - 6);
    doc.text(`${i} / ${pages}`, width - 12, height - 6, { align: 'right' });
  }
}

export async function newPdf(orientation = 'l') {
  const { jsPDF, autoTable, addQuicksandFonts } = await loadPdf();
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
  addQuicksandFonts(doc);
  doc.setFont('Quicksand', 'normal');
  return { doc, autoTable };
}

/**
 * History as a PDF (landscape A4): filters on top, then every record with its annotated photo.
 */
export async function exportHistoryPdf({ t, locale, items, title, lines = [], fileName, onProgress }) {
  const { doc, autoTable } = await newPdf('l');
  const startY = writeHeader(doc, { title, lines: [...lines, t('history.exportCount', { count: items.length })] });
  await addHistoryTable(doc, autoTable, { t, locale, items, startY, onProgress });
  addPageNumbers(doc, t);
  doc.save(fileName);
}

// Excel sheet names: at most 31 characters, none of : \ / ? * [ ], unique in the file
function sheetNames(names) {
  const used = new Set();
  return names.map((name) => {
    const base = String(name || 'Sheet').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28) || 'Sheet';
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base.slice(0, 26)} ${n}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * History as an .xlsx: one sheet per camera (one sheet when there is a single camera), each row
 * with its annotated photo next to the figures.
 */
export async function exportHistoryXlsx({ t, locale, items, fileName, onProgress }) {
  const dateLocale = dateLocaleOf(locale);
  const images = await mapLimit(items, IMAGE_CONCURRENCY, item => annotatedImage(item, { t, maxWidth: 220, quality: 0.7 }), onProgress);
  const imageOf = new Map(items.map((item, i) => [item, images[i]]));

  // Camera order: as they first appear (newest record first)
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.deviceSerial)) groups.set(item.deviceSerial, { name: item.deviceName || item.deviceSerial, items: [] });
    groups.get(item.deviceSerial).items.push(item);
  }
  if (!groups.size) groups.set('none', { name: t('analytics.report.sheetName'), items: [] });
  const names = sheetNames([...groups.values()].map(g => g.name));

  const header = [
    '#',
    t('analytics.report.colScanTime'),
    t('history.colCamera'),
    'Serial',
    t('analytics.report.colInsectCount'),
    t('history.colThreshold'),
    t('history.colAlarm'),
    t('analytics.report.colSpecies'),
    t('history.colReview'),
    t('analytics.report.colAiAssessment'),
    t('analytics.report.colSnapshot'),
  ].map(value => ({ value, fontWeight: 'bold' }));
  const IMAGE_COLUMN = header.length;
  const rowHeightOf = (image) => Math.ceil((image.height + 6) * 0.75);

  const sheets = [...groups.values()].map((group, g) => {
    const sheetImages = [];
    const rows = group.items.map((item, i) => {
      const image = imageOf.get(item);
      if (image?.blob) {
        sheetImages.push({
          content: image.blob,
          contentType: 'image/jpeg',
          width: image.width,
          height: image.height,
          dpi: 96,
          anchor: { row: i + 2, column: IMAGE_COLUMN },
          offsetX: 2,
          offsetY: 2,
          title: `${item.deviceName || item.deviceSerial} ${new Date(item.createdAt).toLocaleString(dateLocale)}`,
        });
      }
      return [
        { value: i + 1, height: image ? rowHeightOf(image) : undefined },
        { value: new Date(item.createdAt).toLocaleString(dateLocale) },
        { value: item.deviceName || item.deviceSerial },
        { value: item.deviceSerial },
        { value: item.pestCount ?? 0 },
        { value: item.threshold ?? null },
        { value: riskText(t, item) },
        { value: speciesText(t, item) },
        { value: reviewText(t, item) },
        { value: item.aiResults?.raw_description || '' },
        { value: '' },
      ];
    });
    return {
      data: [header, ...rows],
      sheet: names[g],
      columns: [5, 20, 20, 14, 10, 10, 14, 28, 14, 40, 32].map(width => ({ width })),
      stickyRowsCount: 1,
      images: sheetImages,
    };
  });

  const writeExcelFile = await loadExcelWriter();
  await writeExcelFile(sheets).toFile(fileName);
}

/** Download the human-corrected snapshots (model output vs corrected counts) as JSON. */
export async function exportCorrectionsJson(days = 90) {
  const res = await api.exportReviews(days);
  const items = res.data?.items || [];
  if (!items.length) return 0;
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `FlyBot_Corrections_${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  return items.length;
}
