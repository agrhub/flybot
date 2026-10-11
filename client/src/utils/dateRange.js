// Date filters of the analytics page and its widgets: { preset, from?, to? }
export const DATE_PRESETS = ['today', '7d', '30d', '90d', 'custom'];

const DAYS = { '7d': 7, '30d': 30, '90d': 90 };

// Local calendar day as YYYY-MM-DD
export const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The startDate / endDate the API expects: an ISO start, and an inclusive end day (custom only).
 */
export function rangeDates(range) {
  if (range?.preset === 'custom' && range.from && range.to) return { startDate: range.from, endDate: range.to };
  const start = new Date();
  if (range?.preset === 'today') {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - (DAYS[range?.preset] || 30));
  }
  return { startDate: start.toISOString(), endDate: null };
}

// Days a range covers (for endpoints that take a number of days)
export function rangeDays(range) {
  if (range?.preset === 'custom' && range.from && range.to) {
    return Math.round((new Date(`${range.to}T12:00:00`) - new Date(`${range.from}T12:00:00`)) / 86400000) + 1;
  }
  if (range?.preset === 'today') return 1;
  return DAYS[range?.preset] || 30;
}

export const sameDateRange = (a, b) => (a?.preset || '30d') === (b?.preset || '30d')
  && (a?.preset !== 'custom' || (a.from === b?.from && a.to === b?.to));

// "Last 30 days" or "01/09/2026 - 30/09/2026"
export function dateRangeLabel(t, range) {
  if (range?.preset === 'custom' && range.from && range.to) {
    const full = (key) => key.split('-').reverse().join('/');
    return `${full(range.from)} - ${full(range.to)}`;
  }
  return t(`filters.ranges.${range?.preset || '30d'}`);
}
