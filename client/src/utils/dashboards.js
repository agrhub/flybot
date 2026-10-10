// Widget types the server accepts (server/src/models/Dashboard.js)
export const WIDGET_TYPES = ['kpi', 'trend', 'species', 'cameraRanking', 'latestSnapshot'];

// Grid widths (24-column grid) and heights (rows of 80px)
export const WIDGET_WIDTHS = [6, 8, 12, 16, 24];
export const WIDGET_HEIGHTS = [3, 4, 5, 6, 8];
export const RANGE_OPTIONS = [1, 7, 14, 30, 90, 365];

const DEFAULT_SIZE = {
  kpi: { w: 24, h: 3 },
  trend: { w: 16, h: 5 },
  species: { w: 8, h: 5 },
  cameraRanking: { w: 12, h: 5 },
  latestSnapshot: { w: 12, h: 5 },
};

export const newWidgetId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newWidget(type, order = 0) {
  const size = DEFAULT_SIZE[type] || { w: 12, h: 4 };
  return { id: newWidgetId(), type, title: '', cameraSerials: [], rangeDays: type === 'kpi' ? 1 : 7, layout: { x: 0, y: order, ...size } };
}

// Starter layout for a new dashboard
export function overviewWidgets() {
  return ['kpi', 'trend', 'species', 'cameraRanking', 'latestSnapshot'].map((type, i) => newWidget(type, i));
}

// Error codes from the dashboard API that have a translated message
const KNOWN_CODES = ['PUBLIC_FOREIGN_CAMERA', 'CAMERA_NOT_FOUND', 'SHARE_WITH_OWNER', 'ALREADY_SHARED', 'FORBIDDEN'];

export function dashboardErrorText(t, err) {
  const data = err?.response?.data || {};
  if (KNOWN_CODES.includes(data.code)) return t(`dashboards.errors.${data.code}`, { cameras: (data.cameras || []).join(', ') });
  return data.message || t('common.error');
}
