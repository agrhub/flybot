// The steps of each page's tour, in screen order. key: text in tour.pages.<page>.<key>; target: the data-tour name
// of the element the step points at (none: centered); inner: a part of it to point at instead (a tall list: its
// first item, so the step fits on a phone screen). A step whose target is not on screen (no rights for that
// control, phone layout, another tab, no data yet) is left out.
export const PAGE_TOURS = {
  cameras: [
    { key: 'intro' },
    { key: 'add', target: 'cameras-add' },
    { key: 'layout', target: 'cameras-layout' },
    { key: 'filters', target: 'cameras-filters' },
    { key: 'grid', target: 'cameras-grid', inner: ':scope > :first-child', placement: 'top' },
    { key: 'pager', target: 'cameras-pager', placement: 'top' },
  ],
  camera: [
    { key: 'intro' },
    { key: 'live', target: 'camera-live' },
    { key: 'switcher', target: 'camera-switcher' },
    { key: 'status', target: 'camera-status' },
    { key: 'actions', target: 'camera-actions' },
    { key: 'playback', target: 'camera-playback', inner: '.el-card__header', placement: 'top' },
    { key: 'upkeep', target: 'camera-upkeep', inner: '.el-card__header', placement: 'top' },
    { key: 'history', target: 'camera-history', inner: '.el-card__header', placement: 'top' },
  ],
  analytics: [
    { key: 'intro' },
    { key: 'filters', target: 'analytics-filters' },
    { key: 'tabs', target: 'analytics-tabs', inner: '.el-tabs__header' },
    { key: 'export', target: 'analytics-export' },
  ],
  reports: [
    { key: 'intro' },
    { key: 'create', target: 'reports-create' },
    { key: 'list', target: 'reports-list', inner: ':scope > :first-child', placement: 'top' },
  ],
  report: [
    { key: 'intro' },
    { key: 'range', target: 'report-range' },
    { key: 'pdf', target: 'report-pdf' },
    { key: 'send', target: 'report-send' },
    { key: 'share', target: 'report-share' },
    { key: 'edit', target: 'report-edit' },
  ],
  farms: [
    { key: 'intro' },
    { key: 'create', target: 'farms-create' },
    { key: 'compare', target: 'farms-compare', inner: '.el-card__header', placement: 'top' },
    { key: 'season', target: 'farms-season', placement: 'top' },
    { key: 'list', target: 'farms-list', inner: ':scope > :first-child', placement: 'top' },
  ],
  logbook: [
    { key: 'intro' },
    { key: 'add', target: 'logbook-add' },
    { key: 'import', target: 'logbook-import' },
    { key: 'export', target: 'logbook-export' },
    { key: 'filters', target: 'logbook-filters' },
    { key: 'list', target: 'logbook-list', inner: '.log-row, .el-table__header-wrapper, .el-empty', placement: 'top' },
    { key: 'ingredients', target: 'logbook-ingredients', inner: '.el-card__header', placement: 'top' },
  ],
  map: [
    { key: 'intro' },
    { key: 'layers', target: 'map-layers' },
    { key: 'legend', target: 'map-legend' },
    { key: 'basemap', target: 'map-basemap', placement: 'top' },
    { key: 'traps', target: 'map-traps', inner: '.el-card__header', placement: 'left' },
  ],
  sentinel: [
    { key: 'intro' },
    { key: 'overview', target: 'sentinel-tab-overview' },
    { key: 'traces', target: 'sentinel-tab-traces' },
    { key: 'approvals', target: 'sentinel-tab-approvals' },
    { key: 'devices', target: 'sentinel-tab-devices' },
    { key: 'refresh', target: 'sentinel-refresh' },
  ],
  settings: [
    { key: 'intro' },
    { key: 'sections', target: 'settings-sections' },
    { key: 'account', target: 'settings-account', placement: 'right' },
    { key: 'system', target: 'settings-system', placement: 'right' },
    { key: 'notifications', target: 'settings-notifications', placement: 'right' },
    { key: 'preferences', target: 'settings-preferences', placement: 'right' },
    { key: 'admin', target: 'settings-admin', placement: 'right' },
  ],
};
