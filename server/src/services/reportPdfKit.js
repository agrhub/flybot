const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
// Same Vietnamese-capable font as the report PDFs
const { addQuicksandFonts } = require('../../../client/src/utils/pdfFonts.js');
const { FARM_OFFSET_MS, dayMonthYear, farmDateTime } = require('../utils/farmTime');

/**
 * What the A4 landscape reports (season, cooperative) share: farm-time dates (utils/farmTime,
 * passed on), the document with its font, and the table and heading helpers in the FlyBot style.
 */
const BRAND = [16, 185, 129];
const TEXT = [60, 60, 60];
const MUTED = [120, 120, 120];
const MARGIN = 12;

/**
 * A new report: { doc, table(startY, head, body, extra), heading(text, y), after(), value(v), title(text, lines) }.
 * `footer` is printed at the bottom of every page.
 */
function createReport(footer) {
    const doc = new jsPDF({ orientation: 'l', unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
    addQuicksandFonts(doc);
    const table = (startY, head, body, extra = {}) => autoTable(doc, {
        startY,
        margin: { left: MARGIN, right: MARGIN, bottom: 14 },
        head: [head],
        body,
        theme: 'grid',
        headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
        didDrawPage: () => {
            doc.setFontSize(7.5);
            doc.setTextColor(...MUTED);
            doc.text(footer, MARGIN, doc.internal.pageSize.getHeight() - 7);
        },
        ...extra,
        // A table may change the size or padding; the font and color stay
        styles: { font: 'Quicksand', fontSize: 8.5, valign: 'middle', textColor: TEXT, cellPadding: 1.8, ...extra.styles }
    });
    const heading = (text, y) => {
        doc.setFont('Quicksand', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(...TEXT);
        doc.text(text, MARGIN, y);
        doc.setFont('Quicksand', 'normal');
        return y + 3;
    };
    // The page title and the grey lines under it
    const title = (text, lines) => {
        doc.setFont('Quicksand', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(...TEXT);
        doc.text(text, MARGIN, 16);
        doc.setFont('Quicksand', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...MUTED);
        lines.forEach((line, i) => doc.text(line, MARGIN, 22 + i * 5));
    };
    // A grey line of text (e.g. "nothing in this period")
    const note = (text, y) => {
        doc.setFontSize(9);
        doc.setTextColor(...MUTED);
        doc.text(text, MARGIN, y);
    };
    return {
        doc,
        table,
        heading,
        title,
        note,
        after: () => doc.lastAutoTable.finalY + 10,
        value: (v) => (v === null || v === undefined ? '--' : String(v)),
        pdf: () => Buffer.from(doc.output('arraybuffer'))
    };
}

module.exports = {
    FARM_OFFSET_MS,
    MARGIN,
    MUTED,
    dayMonthYear,
    farmDateTime,
    createReport
};
