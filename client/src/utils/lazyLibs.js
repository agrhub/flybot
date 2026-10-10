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

let xlsx;
export const loadXlsx = () => (xlsx ||= import('xlsx'));
