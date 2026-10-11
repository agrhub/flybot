<template>
  <div class="flex flex-col gap-4 w-full pb-10">
    <el-alert :title="t('insights.howToRead')" type="info" :closable="false" show-icon />
    <!-- Insights cover the last 7, 14 or 30 days, not any chosen dates -->
    <el-alert v-if="!coversPageRange" :title="t('insights.lastDaysNote', { days: pageDays })" type="warning" :closable="false" show-icon />

    <!-- Daily catches per trap -->
    <el-card shadow="never">
      <template #header>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="section-title">{{ t('insights.dailyTitle') }}</div>
            <p class="section-desc">{{ t('insights.dailyDesc', { days: daily.days.length }) }}</p>
          </div>
          <WidgetFilter v-model="dailyFilter" :defaults="pageDefaultsMulti" :fields="['cameras', 'days']" />
        </div>
      </template>
      <div v-loading="daily.loading">
        <CatchBarChart :labels="daily.days.map(shortDay)" :series="dailySeries" :height="300" :y-title="t('insights.catchesAxis')" :empty-text="t('analytics.noStatsData')" />
      </div>
    </el-card>

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <!-- Weather vs catches -->
      <el-card shadow="never">
        <template #header>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="section-title">{{ t('insights.weatherTitle') }}</div>
              <p class="section-desc">{{ weather.data?.weather ? t('insights.weatherDesc') : t('insights.weatherMissing') }}</p>
            </div>
            <WidgetFilter v-model="weatherFilter" :defaults="pageDefaults" :fields="['camera', 'days']" />
          </div>
        </template>
        <div v-loading="weather.loading">
          <CatchBarChart
            :labels="(weather.data?.days || []).map(shortDay)"
            :series="weatherSeries"
            :height="280"
            :y-title="t('insights.catchesAxis')"
            :y2-title="t('insights.tempAxis')"
            :empty-text="t('analytics.noStatsData')"
          />
        </div>
      </el-card>

      <!-- Activity by hour of day -->
      <el-card shadow="never">
        <template #header>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="section-title">{{ t('insights.activityTitle') }}</div>
              <p class="section-desc">{{ peakHour !== null ? t('insights.activityPeak', { from: peakHour, to: peakHour + 1 }) : t('insights.activityDesc') }}</p>
            </div>
            <WidgetFilter v-model="activityFilter" :defaults="pageDefaults" :fields="['camera', 'days']" />
          </div>
        </template>
        <div v-loading="activity.loading">
          <ActivityHeatmap :activity="activity.data?.activity" newest-first :max-height="320" />
        </div>
      </el-card>
    </div>

    <!-- Per-trap summary -->
    <el-card shadow="never">
      <template #header>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="section-title">{{ t('insights.tableTitle') }}</div>
            <p class="section-desc">{{ t('insights.tableDesc') }}</p>
          </div>
          <WidgetFilter v-model="tableFilter" :defaults="tableDefaults" :fields="['cameras', 'days', 'status', 'risk', 'trapKind']" />
        </div>
      </template>
      <el-table v-loading="table.loading" :data="tableRows" size="small" class="w-full" :empty-text="t('analytics.noStatsData')" @row-click="openTrap">
        <el-table-column :label="t('insights.col.trap')" min-width="190" fixed>
          <template #default="{ row }">
            <div class="flex items-center gap-2 min-w-0">
              <span class="status-dot shrink-0" :class="row.online ? 'is-online' : 'is-idle'"></span>
              <div class="min-w-0">
                <div class="font-semibold truncate">{{ row.deviceName }}</div>
                <div class="meta-text truncate">{{ [row.plot, row.farm].filter(Boolean).join(' · ') || row.deviceSerial }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.kind')" min-width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" round>{{ t(`trapKind.${row.trapKind}.short`) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.onTrap')" min-width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="RISK_TAG[row.riskLevel]" effect="light" round size="small">{{ row.onCard }} / {{ row.alertThreshold }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.today')" prop="today" min-width="80" align="right">
          <template #default="{ row }">{{ row.today ?? '--' }}</template>
        </el-table-column>
        <el-table-column :label="t('insights.col.total', { days: table.data?.days?.length || 0 })" prop="total" min-width="90" align="right" sortable />
        <el-table-column :label="t('insights.col.ftd')" prop="ftd" min-width="110" align="right" sortable>
          <template #default="{ row }"><b>{{ row.ftd ?? '--' }}</b></template>
        </el-table-column>
        <el-table-column :label="t('insights.col.change')" min-width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.changePct !== null" :type="row.changePct > 10 ? 'danger' : row.changePct < -10 ? 'success' : 'info'" effect="light" size="small" round>
              {{ row.changePct > 0 ? '+' : '' }}{{ row.changePct }}%
            </el-tag>
            <span v-else class="meta-text">--</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.trend')" min-width="130">
          <template #default="{ row }">
            <div class="spark">
              <div v-for="(v, i) in row.daily" :key="i" class="spark__bar" :style="{ height: `${v ? Math.max(8, (v / sparkMax(row)) * 100) : 4}%`, opacity: v === null ? 0.25 : 1 }"></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.card')" min-width="100" align="center">
          <template #default="{ row }">
            <span v-if="row.trapKind !== 'lure' && row.cardAgeDays !== null">{{ t('insights.days', { n: row.cardAgeDays }) }}</span>
            <span v-else class="meta-text">--</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.photo')" min-width="170">
          <template #default="{ row }">
            <div class="flex flex-wrap gap-1">
              <el-tag v-for="issue in row.imageIssues" :key="issue" type="warning" size="small" effect="light" round>
                {{ t(`cameras.imageQuality.issues.${issue}`) }}
              </el-tag>
              <span v-if="!row.imageIssues.length" class="meta-text">{{ row.lastScanAt ? relative(row.lastScanAt) : '--' }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';
import { useWidgetFilter } from '@/composables/useWidgetFilter';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';
import ActivityHeatmap from '@/components/charts/ActivityHeatmap.vue';
import WidgetFilter from '@/components/common/WidgetFilter.vue';
import { rangeDays } from '@/utils/dateRange';
import { PRINT } from '@/utils/pdfCharts';
import { latestOnly } from '@/utils/latestOnly';

const props = defineProps({
  camera: { type: Object, default: null },
  // Page date filter: { preset, from?, to? }; insights cover 7 to 30 days
  range: { type: Object, default: () => ({ preset: '30d' }) },
  active: { type: Boolean, default: false },
});

const { t, locale } = useI18n();
const { cameras, selectCameraAndGoToLive } = useCameras();
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' };
const DAY_CHOICES = [7, 14, 30];

// Page filters as widget defaults: days snapped to the choices the insights endpoint takes
const pageDays = computed(() => {
  const days = rangeDays(props.range);
  return DAY_CHOICES.find(d => d >= days) || 30;
});
const coversPageRange = computed(() => props.range?.preset !== 'custom' && DAY_CHOICES.includes(rangeDays(props.range)));
const pageCamera = computed(() => props.camera?.deviceSerial || 'all');
const pageDefaults = computed(() => ({ camera: pageCamera.value, days: pageDays.value }));
const pageDefaultsMulti = computed(() => ({ cameras: pageCamera.value === 'all' ? [] : [pageCamera.value], days: pageDays.value }));
const tableDefaults = computed(() => ({ ...pageDefaultsMulti.value, status: 'all', risk: 'all', trapKind: 'all' }));

const dailyFilter = useWidgetFilter(() => pageDefaultsMulti.value);
const weatherFilter = useWidgetFilter(() => pageDefaults.value);
const activityFilter = useWidgetFilter(() => pageDefaults.value);
const tableFilter = useWidgetFilter(() => tableDefaults.value);

// One request per camera and period, shared by the widgets that ask for the same
const cache = new Map();
const fetchInsights = (serial, days) => {
  const key = `${serial}|${days}`;
  if (!cache.has(key)) {
    cache.set(key, api.getInsights(serial, days)
      .then(res => res.data?.insights || {})
      .catch((err) => {
        cache.delete(key);
        throw err;
      }));
  }
  return cache.get(key);
};
// Several cameras: read all, then keep the chosen ones
const serialFor = (list) => (list?.length === 1 ? list[0] : 'all');
const keepTraps = (data, list) => (list?.length > 1 ? (data.traps || []).filter(trap => list.includes(trap.deviceSerial)) : data.traps || []);

const daily = reactive({ loading: false, days: [], traps: [] });
const weather = reactive({ loading: false, data: null });
const activity = reactive({ loading: false, data: null });
const table = reactive({ loading: false, data: null });

const trackers = new Map([daily, weather, activity, table].map(target => [target, latestOnly()]));

// A widget keeps the answer to its latest request only
const loadInto = async (target, serial, days, apply) => {
  const isLatest = trackers.get(target)();
  target.loading = true;
  let data;
  try {
    data = await fetchInsights(serial, days);
  } catch {
    data = {};
  }
  if (!isLatest()) return;
  apply(data);
  target.loading = false;
};
const loadDaily = () => loadInto(daily, serialFor(dailyFilter.value.cameras), dailyFilter.value.days, (data) => {
  daily.days = data.days || [];
  daily.traps = keepTraps(data, dailyFilter.value.cameras);
});
const loadWeather = () => loadInto(weather, weatherFilter.value.camera, weatherFilter.value.days, (data) => { weather.data = data; });
const loadActivity = () => loadInto(activity, activityFilter.value.camera, activityFilter.value.days, (data) => { activity.data = data; });
const loadTable = () => loadInto(table, serialFor(tableFilter.value.cameras), tableFilter.value.days, (data) => {
  table.data = { ...data, traps: keepTraps(data, tableFilter.value.cameras) };
});

const shortDay = (key) => (key ? `${key.slice(8, 10)}/${key.slice(5, 7)}` : '');
const dailySeries = computed(() => daily.traps.map(trap => ({ label: trap.deviceName, data: trap.daily })));

const totalsByDay = (data) => (data?.days || []).map((_, i) => {
  const values = (data.traps || []).map(trap => trap.daily[i]).filter(v => v !== null && v !== undefined);
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 10) / 10 : null;
});
const cssColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const weatherSeries = computed(() => {
  const series = [{ label: t('insights.catchesAxis'), data: totalsByDay(weather.data) }];
  const temps = weather.data?.weather;
  if (temps) {
    series.push(
      { label: t('insights.tempMax'), data: temps.map(w => w.max), type: 'line', axis: 'y2', color: cssColor('--el-color-danger') },
      { label: t('insights.tempMin'), data: temps.map(w => w.min), type: 'line', axis: 'y2', color: cssColor('--el-color-primary') }
    );
  }
  return series;
});

const peakHour = computed(() => {
  const data = activity.data?.activity;
  const byHour = data?.byHour || [];
  const max = Math.max(0, ...byHour);
  return max > 0 ? data.hours[byHour.indexOf(max)] : null;
});

const tableRows = computed(() => (table.data?.traps || []).filter((row) => {
  const f = tableFilter.value;
  if (f.status === 'online' && !row.online) return false;
  if (f.status === 'offline' && row.online) return false;
  if (f.risk && f.risk !== 'all' && row.riskLevel !== f.risk) return false;
  if (f.trapKind && f.trapKind !== 'all' && row.trapKind !== f.trapKind) return false;
  return true;
}));
const sparkMax = (row) => Math.max(1, ...row.daily.filter(v => v !== null));

const relative = (date) => {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' });
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  if (minutes < 1440) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / 1440), 'day');
};

// Open the trap on the Cameras page
const openTrap = (row) => selectCameraAndGoToLive(cameras.value.find(c => c.deviceSerial === row.deviceSerial) || { deviceSerial: row.deviceSerial });

const loadAll = () => {
  cache.clear();
  loadDaily();
  loadWeather();
  loadActivity();
  loadTable();
};
const loaded = { done: false };
watch(() => props.active, (isActive) => {
  if (isActive && !loaded.done) {
    loaded.done = true;
    loadAll();
  }
});
watch(dailyFilter, () => loaded.done && loadDaily(), { deep: true });
watch(weatherFilter, () => loaded.done && loadWeather(), { deep: true });
watch(activityFilter, () => loaded.done && loadActivity(), { deep: true });
watch(tableFilter, () => loaded.done && loadTable(), { deep: true });
onMounted(() => {
  if (props.active) {
    loaded.done = true;
    loadAll();
  }
});

// ---------- PDF ----------
const cameraName = (serial) => (!serial || serial === 'all' ? t('analytics.allCameras') : cameras.value.find(c => c.deviceSerial === serial)?.deviceName || serial);
const camerasLabel = (list) => (list?.length ? list.map(cameraName).join(', ') : t('analytics.allCameras'));
const daysLabel = (days) => t('analytics.compare.days', { days });

const barConfig = (labels, series, { y2 = false } = {}) => ({
  type: 'bar',
  data: {
    labels,
    datasets: series.map((s, i) => ({
      type: s.type || 'bar',
      label: s.label,
      data: s.data,
      yAxisID: s.axis || 'y',
      backgroundColor: PRINT.series[i % PRINT.series.length],
      borderColor: PRINT.series[i % PRINT.series.length],
      borderWidth: s.type === 'line' ? 2 : 0,
      pointRadius: 0,
      stack: s.type === 'line' ? undefined : 'catches',
    })),
  },
  options: {
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
    scales: {
      x: { stacked: true, grid: { display: false } },
      y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
      ...(y2 ? { y2: { position: 'right', grid: { display: false } } } : {}),
    },
  },
});

/** What this tab shows, as PDF sections (utils/analyticsPdf.js). Loads it first if never opened. */
const pdfSections = async () => {
  if (!loaded.done) {
    loaded.done = true;
    await Promise.all([loadDaily(), loadWeather(), loadActivity(), loadTable()]);
  }
  const act = activity.data?.activity;
  return [
    {
      part: t('insights.tab'),
      title: t('insights.dailyTitle'),
      lines: [`${camerasLabel(dailyFilter.value.cameras)} · ${daysLabel(dailyFilter.value.days)}`],
      chart: daily.traps.length ? barConfig(daily.days.map(shortDay), dailySeries.value) : null,
    },
    {
      title: t('insights.weatherTitle'),
      lines: [`${cameraName(weatherFilter.value.camera)} · ${daysLabel(weatherFilter.value.days)}`, ...(weather.data?.weather ? [] : [t('insights.weatherMissing')])],
      chart: weather.data?.days?.length ? barConfig((weather.data.days || []).map(shortDay), weatherSeries.value, { y2: true }) : null,
    },
    {
      title: t('insights.activityTitle'),
      lines: [`${cameraName(activityFilter.value.camera)} · ${daysLabel(activityFilter.value.days)}`, ...(peakHour.value !== null ? [t('insights.activityPeak', { from: peakHour.value, to: peakHour.value + 1 })] : [])],
      table: {
        head: [t('dashboards.pdf.hour'), t('dashboards.kpi.fliesUnit')],
        body: (act?.hours || []).map((h, i) => [`${h}:00 - ${h + 1}:00`, String(Math.round((act.byHour?.[i] || 0) * 10) / 10)]).filter(r => r[1] !== '0'),
      },
    },
    {
      title: t('insights.tableTitle'),
      lines: [`${camerasLabel(tableFilter.value.cameras)} · ${daysLabel(tableFilter.value.days)}`],
      table: {
        head: [t('insights.col.trap'), t('insights.col.kind'), t('insights.col.onTrap'), t('insights.col.today'), t('insights.col.total', { days: table.data?.days?.length || 0 }), t('insights.col.ftd'), t('insights.col.change'), t('insights.col.card')],
        body: tableRows.value.map(r => [
          r.deviceName,
          t(`trapKind.${r.trapKind}.short`),
          `${r.onCard} / ${r.alertThreshold}`,
          r.today ?? '--',
          String(r.total ?? '--'),
          String(r.ftd ?? '--'),
          r.changePct === null ? '--' : `${r.changePct > 0 ? '+' : ''}${r.changePct}%`,
          r.trapKind !== 'lure' && r.cardAgeDays !== null ? t('insights.days', { n: r.cardAgeDays }) : '--',
        ]),
      },
    },
  ];
};

defineExpose({ pdfSections });
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-desc,
.meta-text {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--el-color-info-light-5);
}
.status-dot.is-online {
  background-color: var(--el-color-success);
}
.spark {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 24px;
}
.spark__bar {
  flex: 1;
  min-width: 3px;
  border-radius: 1px;
  background-color: var(--el-color-primary-light-3);
}
</style>
