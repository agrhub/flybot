// Field log import: a CSV or Excel sheet (a paper log typed in once, or another tool's export)
// turned into treatment rows for POST /api/treatments/import. Headers and values are matched
// loosely (Vietnamese or English, with or without accents); anything not understood is reported
// per row, before anything is sent.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 500;
export const TYPES = ['spray', 'bait', 'lure', 'biological', 'sanitation', 'bagging', 'other'];
export const FIELDS = ['date', 'type', 'cameras', 'product', 'activeIngredient', 'dose', 'area', 'operator', 'preHarvestDays', 'note'];

// "Ngày phun" -> "ngay phun": lower case, no accents, single spaces
export const fold = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Header words for each field (folded); the template uses the first label of the current language
const HEADER_WORDS = {
  date: ['ngay', 'ngay phun', 'ngay thuc hien', 'thoi gian', 'date', 'time', 'when'],
  type: ['bien phap', 'loai', 'loai bien phap', 'type', 'kind', 'measure'],
  cameras: ['bay', 'camera', 'cameras', 'trap', 'traps', 'cac bay'],
  product: ['thuoc', 'san pham', 'ten thuoc', 'product'],
  activeIngredient: ['hoat chat', 'active ingredient', 'ingredient'],
  dose: ['lieu', 'lieu luong', 'dose', 'rate'],
  area: ['dien tich', 'khu vuc', 'area'],
  operator: ['nguoi thuc hien', 'nguoi phun', 'operator', 'by'],
  preHarvestDays: ['cach ly', 'thoi gian cach ly', 'so ngay cach ly', 'phi', 'pre harvest days', 'pre harvest interval', 'withholding days'],
  note: ['ghi chu', 'note', 'notes']
};

/** Which field each column holds (null for a column that matches none). */
export function mapHeader(cells) {
  const used = new Set();
  return cells.map((cell) => {
    const name = fold(cell);
    const field = FIELDS.find((f) => !used.has(f) && HEADER_WORDS[f].includes(name));
    if (field) used.add(field);
    return field || null;
  });
}

/** CSV text to rows of cells: quotes, doubled quotes, line breaks inside quotes; "," or ";". */
export function parseCsv(text) {
  const source = String(text).replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// Day first (Vietnamese and most of the world): 13/10/2026, 13-10-2026 07:30, or ISO 2026-10-13 07:30
export function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value ?? '').trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return makeDate(+m[1], +m[2], +m[3], m[4], m[5]);
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) return makeDate(+m[3], +m[2], +m[1], m[4], m[5]);
  return null;
}
function makeDate(y, mo, d, h, mi) {
  // No time given: early morning, when spraying is usually done
  const date = new Date(y, mo - 1, d, h === undefined ? 7 : +h, mi === undefined ? 0 : +mi);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** Type key from a key or a label in any language ("Phun thuốc", "spray"). */
export function parseType(value, labelsByType) {
  const name = fold(value);
  if (!name) return null;
  return TYPES.find((type) => type === name || (labelsByType[type] || []).some((label) => fold(label) === name)) || null;
}

/** Trap serials from names or serials, separated by commas, semicolons or "|". */
export function parseCameras(value, cameras) {
  const names = String(value ?? '').split(/[,;|\n]+/).map((s) => s.trim()).filter(Boolean);
  const found = [];
  const unknown = [];
  for (const name of names) {
    const key = fold(name);
    const cam = cameras.find((c) => fold(c.deviceSerial) === key) || cameras.find((c) => fold(c.deviceName) === key);
    if (cam) found.push(cam.deviceSerial); else unknown.push(name);
  }
  return { serials: [...new Set(found)], unknown };
}

/**
 * Sheet rows (first row: headers) to import rows. Each: { line, body, problems }, where
 * problems are i18n keys found before sending (missing columns, unknown traps...).
 */
export function toImportRows(sheet, { cameras, labelsByType }) {
  const [head = [], ...lines] = sheet;
  const fields = mapHeader(head);
  const missing = ['date', 'type', 'cameras'].filter((f) => !fields.includes(f));
  if (missing.length) return { missing, rows: [] };
  const rows = lines.slice(0, MAX_ROWS).map((cells, index) => {
    const raw = {};
    fields.forEach((field, i) => { if (field) raw[field] = cells[i]; });
    const problems = [];
    const body = {};
    const at = parseDate(raw.date);
    if (at) body.at = at.toISOString(); else problems.push({ key: 'badDate', value: String(raw.date ?? '') });
    const type = parseType(raw.type, labelsByType);
    if (type) body.type = type; else problems.push({ key: 'badType', value: String(raw.type ?? '') });
    const { serials, unknown } = parseCameras(raw.cameras, cameras);
    if (unknown.length) problems.push({ key: 'unknownTraps', value: unknown.join(', ') });
    else if (!serials.length) problems.push({ key: 'noTraps', value: '' });
    body.cameraSerials = serials;
    for (const field of ['product', 'activeIngredient', 'dose', 'area', 'operator', 'note']) {
      const text = String(raw[field] ?? '').trim();
      if (text) body[field] = text;
    }
    const phi = String(raw.preHarvestDays ?? '').trim();
    if (phi) {
      if (/^\d+$/.test(phi)) body.preHarvestDays = Number(phi); else problems.push({ key: 'badPhi', value: phi });
    }
    return { line: index + 2, body, problems, raw };
  });
  return { missing: [], rows, truncated: lines.length > MAX_ROWS };
}

/** The template: headers in the given labels and one example row. */
export function templateCsv(headers, example) {
  const quote = (v) => (/[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return '﻿' + [headers, example].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
