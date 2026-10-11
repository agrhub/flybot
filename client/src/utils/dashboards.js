// Widget types the server accepts (server/src/models/Dashboard.js)
export const WIDGET_TYPES = ['kpi', 'trend', 'catchesByTrap', 'species', 'cameraRanking', 'dailyTable', 'activity', 'latestSnapshot'];

// Grid widths (24-column grid) and heights (rows of 80px)
export const WIDGET_WIDTHS = [6, 8, 12, 16, 24];
export const WIDGET_HEIGHTS = [3, 4, 5, 6, 8];

// Report time ranges (server: RANGE_PRESETS); a custom range covers at most 366 days
export const RANGE_PRESETS = ['7d', '30d', '3m', '6m', '12m', 'custom'];
export const MAX_RANGE_DAYS = 366;

const DEFAULT_SIZE = {
  kpi: { w: 24, h: 4 },
  trend: { w: 16, h: 5 },
  catchesByTrap: { w: 24, h: 5 },
  species: { w: 8, h: 5 },
  cameraRanking: { w: 24, h: 5 },
  dailyTable: { w: 12, h: 5 },
  activity: { w: 12, h: 5 },
  latestSnapshot: { w: 24, h: 5 },
};

export const newWidgetId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newWidget(type, order = 0) {
  const size = DEFAULT_SIZE[type] || { w: 12, h: 4 };
  return { id: newWidgetId(), type, title: '', cameraSerials: [], layout: { x: 0, y: order, ...size } };
}

// Starter layout for a new report
export function overviewWidgets() {
  return ['kpi', 'trend', 'species', 'catchesByTrap', 'cameraRanking', 'dailyTable', 'activity'].map((type, i) => newWidget(type, i));
}

// Range as a query for the data endpoints; null = the report's own range
export function rangeQuery(range) {
  if (!range?.preset) return null;
  return range.preset === 'custom' ? { range: 'custom', from: range.from, to: range.to } : { range: range.preset };
}

export const sameRange = (a, b) => (a?.preset || '7d') === (b?.preset || '7d')
  && (a?.preset !== 'custom' || (a.from === b?.from && a.to === b?.to));

// "dd/mm" for a day key, "mm/yyyy" for a month
export function formatDayKey(key, unit = 'day') {
  if (!key) return '';
  const [y, m, d] = key.split('-');
  return unit === 'month' ? `${m}/${y}` : `${d}/${m}`;
}

// A table or chart period: one day, a week (from - to) or a month
export function formatPeriod(from, to, unit) {
  if (unit === 'month') return formatDayKey(from, 'month');
  if (unit === 'week' && to && to !== from) return `${formatDayKey(from)} - ${formatDayKey(to)}`;
  return formatDayKey(from);
}

// Range shown in the page and in the PDF: "Last 30 days" or "01/09/2026 - 30/09/2026"
export function rangeLabel(t, range) {
  if (!range) return '';
  if (range.preset === 'custom') {
    const full = (key) => key.split('-').reverse().join('/');
    return `${full(range.from)} - ${full(range.to)}`;
  }
  return t(`dashboards.ranges.${range.preset}`);
}

export const formatNumber = (value) => (value === null || value === undefined ? '--' : String(value));
export const formatChange = (pct) => (pct === null || pct === undefined ? '--' : `${pct > 0 ? '+' : ''}${pct}%`);
// More flies is bad news on a trap
export const changeTagType = (pct) => (pct === null || pct === undefined ? 'info' : pct > 10 ? 'danger' : pct < -10 ? 'success' : 'info');

// Error codes from the report API that have a translated message
const KNOWN_CODES = ['PUBLIC_FOREIGN_CAMERA', 'CAMERA_NOT_FOUND', 'SHARE_WITH_OWNER', 'ALREADY_SHARED', 'FORBIDDEN'];

export function dashboardErrorText(t, err) {
  const data = err?.response?.data || {};
  if (KNOWN_CODES.includes(data.code)) return t(`dashboards.errors.${data.code}`, { cameras: (data.cameras || []).join(', ') });
  return data.message || t('common.error');
}
