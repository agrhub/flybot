# FlyBot UI guidelines

The app UI is built from **Element Plus components** and **Element Plus icons**, themed by the CSS variables in `src/assets/main.css`. Tailwind (CDN) is only used for layout.

## Components

| Need | Use |
|---|---|
| Page title + actions | `PageHeader` (`@/components/common/PageHeader.vue`) |
| Key number tiles | `StatCard` (`@/components/common/StatCard.vue`) |
| Panels / sections | `el-card shadow="never"` (header via `#header` slot) |
| Buttons | `el-button` with `type` (`primary` for the main action, default otherwise, `danger` for destructive), `plain` / `text` / `link` variants, `:icon` prop, `circle` for icon-only |
| Text inputs, selects, dates, numbers | `el-input`, `el-select`, `el-date-picker`, `el-input-number`, wrapped in `el-form` / `el-form-item` with `label-position="top"` |
| On/off | `el-switch` |
| Mode toggles (hour/day/month, grid/single) | `el-segmented` or `el-radio-group` + `el-radio-button` |
| Status pills (online, risk, encrypted) | `el-tag` with `type` `success` / `warning` / `danger` / `info`, `effect="light"`, `round`, `size="small"` |
| Counters on icons | `el-badge` |
| Lists of records | `el-table` + `el-pagination` |
| Empty states | `el-empty` |
| Loading | `v-loading` on the container, or `el-skeleton` |
| Inline notices / banners | `el-alert` (`:closable="false"`, `show-icon`) |
| Success / failure pages | `el-result` |
| Modals / side panels | `el-dialog`, `el-drawer` |
| Hints | `el-tooltip` |
| Menus | `el-dropdown`, `el-menu` (sidebar) |
| Key/value details | `el-descriptions` |
| Separators | `el-divider` |
| Feedback | `ElNotification` / `ElMessage` / `ElMessageBox.confirm` |

## Icons

- Import per file from `@element-plus/icons-vue` (`import { VideoCamera, Refresh } from '@element-plus/icons-vue'`).
- Buttons: `<el-button :icon="Refresh">`. Elsewhere: `<el-icon><VideoCamera /></el-icon>`.
- No hand-written `<svg>` for UI icons. Exceptions: brand logo image, charts, and HTML strings that Leaflet renders outside Vue (map markers/popups), which should stay minimal.

## Colors and styling

- Use theme variables, never hard-coded colors: `--el-color-primary|success|warning|danger|info`, `--el-text-color-primary|regular|secondary`, `--el-bg-color`, `--el-bg-color-page`, `--el-fill-color-light`, `--el-border-color`.
- Status color comes from the component `type` (tag, alert, button, progress), not from custom classes.
- No gradients, glows, colored shadows, or Tailwind palette colors (`emerald-500`, `red-400`, `slate-900`, `bg-[#...]`) for UI chrome. Chart series colors are the exception.
- Tailwind is fine for layout: `flex`, `grid`, `gap-*`, `p-*`, `m-*`, `w-*`, `min-w-0`, `truncate`, responsive prefixes.
- Typography: page title via `PageHeader`; section titles 15–16px semibold; body 14px; meta/captions 12–13px in `--el-text-color-secondary`. Avoid `font-black`, `uppercase tracking-widest`, and tiny `text-[10px]` labels.
- Light and dark mode must both work: Element Plus dark variables are loaded globally and switched by `html.dark`.

## Code rules (unchanged)

- Code, comments and messages in English; every user-facing string through vue-i18n with keys in both `en.json` and `vi.json`.
- Keep behavior, props, emits, API calls and i18n keys intact when restyling.
