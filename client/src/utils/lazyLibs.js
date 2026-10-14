// Heavy libraries are loaded the first time they are needed, not with the page.
// Each loader is memoized, so later calls reuse the same module.

let ezuikit;
export const loadEzuikit = () => (ezuikit ||= import('ezuikit-js').then((m) => m.default || m));

let hlsPlayers;
export const loadHlsPlayers = () => (hlsPlayers ||= Promise.all([
  import('hls.js'),
  import('@ezuikit/player-hls'),
  import('@ezuikit/player-hls/dist/style/css.css'),
]).then(([hls, ezHls]) => ({ Hls: hls.default || hls, HLSPlayer: ezHls.default || ezHls })));

let pdf;
export const loadPdf = () => (pdf ||= Promise.all([
  import('jspdf'),
  import('jspdf-autotable'),
  import('@/utils/pdfFonts'),
]).then(([jspdf, autotable, fonts]) => ({
  jsPDF: jspdf.jsPDF,
  autoTable: autotable.default || autotable,
  addQuicksandFonts: fonts.addQuicksandFonts,
})));

// Writes .xlsx only (no parsing of untrusted files)
let excel;
export const loadExcelWriter = () => (excel ||= import('write-excel-file/browser').then((m) => m.default));

// Reads the first sheet of an .xlsx the user picked (the field log import), in their own browser;
// the file is at most 2 MB (utils/logImport.js) and its rows are checked again by the server
let excelReader;
export const loadExcelReader = () => (excelReader ||= import('read-excel-file/browser').then((m) => (file) => m.readSheet(file)));
