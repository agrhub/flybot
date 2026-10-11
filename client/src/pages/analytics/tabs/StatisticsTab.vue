<template>
  <div class="flex flex-col gap-4 w-full pb-10">
    <!-- Summary cards (page filters) -->
    <div class="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
      <StatCard
        :label="isSingleCamera ? t('analytics.realtimeDensityTrap') : t('analytics.realtimeHotspotMax')"
        :value="realtimeInsectCount"
        :unit="t('analytics.insectsUnit')"
        :description="isSingleCamera ? (props.camera?.deviceName || props.camera?.deviceSerial) : t('analytics.peakAcrossTraps')"
        :icon="Aim"
        type="warning"
      />
      <StatCard
        :label="t('analytics.topSpeciesCard')"
        :value="formatSpeciesDisplay(topSpecies)"
        :description="t('analytics.topSpeciesDesc')"
        :icon="PieChart"
        type="primary"
      />
      <StatCard
        :label="t('analytics.catchesInPeriod')"
        :value="periodCatches === null ? '--' : Math.round(periodCatches).toLocaleString()"
        :unit="t('analytics.insectsUnit')"
        :description="t('analytics.catchesInPeriodDesc')"
        :icon="DataLine"
      />
      <StatCard :label="t('analytics.forecastCard')" :description="t('analytics.forecastTrend')" :icon="TrendCharts" :type="forecastType">
        <template #value>
          <span class="inline-flex items-center gap-2">
            <span>{{ forecastText }}</span>
            <el-icon v-if="forecastIconComponent" :size="20"><component :is="forecastIconComponent" /></el-icon>
          </span>
        </template>
      </StatCard>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <!-- Main chart -->
      <el-card shadow="never" class="lg:col-span-2">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="min-w-0">
              <span class="section-title">{{ chartTitle }}</span>
              <p class="metric-hint">{{ chartHint }}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <el-segmented v-if="chartFilter.granularity !== 'hour'" :model-value="metric" :options="metricOptions" size="small" @change="setMetric" />
              <el-segmented :model-value="chartFilter.granularity" :options="modes" size="small" @change="(v) => (chartFilter = { ...chartFilter, granularity: v })" />
              <WidgetFilter v-model="chartFilter" :defaults="pageDefaults" :fields="['camera', 'range']" />
            </div>
          </div>
        </template>
        <div v-loading="loading" :element-loading-text="t('analytics.loadingData')" class="h-[400px] relative">
          <div v-show="statsData.length > 0" class="absolute inset-0"><canvas ref="lineChartRef"></canvas></div>
          <div v-show="!loading && statsData.length === 0" class="h-full flex items-center justify-center">
            <el-empty :description="t('analytics.noStatsData')" :image-size="80" />
          </div>
        </div>
      </el-card>

      <!-- Species ratio -->
      <el-card shadow="never">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <span class="section-title">{{ t('analytics.speciesRatio') }}</span>
            <WidgetFilter v-model="ratioFilter" :defaults="pageDefaults" :fields="['camera', 'range']" />
          </div>
        </template>
        <div v-loading="ratioLoading" class="h-[320px] relative">
          <div v-show="ratioTotals.length > 0" class="absolute inset-0"><canvas ref="pieChartRef"></canvas></div>
          <div v-show="!ratioLoading && ratioTotals.length === 0" class="h-full flex items-center justify-center">
            <el-empty :description="t('analytics.noRatioData')" :image-size="80" />
          </div>
        </div>
      </el-card>
    </div>

    <!-- This period vs the previous one, per camera -->
    <ComparisonCard ref="comparisonRef" :default-camera="props.camera?.deviceSerial || 'all'" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import Chart from 'chart.js/auto';
import api from '@/services/api';
import { useI18n } from 'vue-i18n';
import { Aim, Bottom, DataLine, Minus, PieChart, Top, TrendCharts } from '@element-plus/icons-vue';
import StatCard from '@/components/common/StatCard.vue';
import WidgetFilter from '@/components/common/WidgetFilter.vue';
import ComparisonCard from '@/components/analytics/ComparisonCard.vue';
import { useWidgetFilter } from '@/composables/useWidgetFilter';
import { normalizeSpecies, speciesName, speciesShare } from '@/utils/species';
import { rangeDates, dateRangeLabel } from '@/utils/dateRange';
import { PRINT } from '@/utils/pdfCharts';
import { useCameras } from '@/composables/useCameras';

const { t } = useI18n();
const { cameras } = useCameras();

const props = defineProps({
  camera: Object,
  // Page date filter: { preset, from?, to? }
  range: { type: Object, default: () => ({ preset: '30d' }) },
  active: { type: Boolean, default: true },
});

const formatSpeciesDisplay = (str) => speciesShare(str, t);
const isSingleCamera = computed(() => props.camera?.deviceSerial && props.camera.deviceSerial !== 'all');

const pageDefaults = computed(() => ({ camera: props.camera?.deviceSerial || 'all', range: props.range }));
const chartFilter = useWidgetFilter(() => pageDefaults.value, { granularity: 'day' });
const ratioFilter = useWidgetFilter(() => pageDefaults.value);

const modes = computed(() => ['hour', 'day', 'month'].map(value => ({ value, label: t(`filters.granularities.${value}`) })));
// "catches": insects caught per day (rise of each sticky card; average present for lure traps)
// "card": the count in the photos, what alert thresholds compare. Hourly figures are counts on the trap.
const metric = ref('catches');
const metricOptions = computed(() => [
  { label: t('analytics.metricCatches'), value: 'catches' },
  { label: t('analytics.metricOnTrap'), value: 'card' },
]);
const useCatches = computed(() => metric.value === 'catches' && chartFilter.value.granularity !== 'hour');
const chartTitle = computed(() => {
  if (chartFilter.value.granularity === 'hour') return t('analytics.onTrapHourly');
  return useCatches.value ? t('analytics.catchesChart') : t('analytics.densityChart');
});
const chartHint = computed(() => (useCatches.value ? t('analytics.catchesChartHint') : t('analytics.onTrapChartHint')));
const setMetric = (value) => {
  metric.value = value;
  fetchChart();
};

// ---------- Summary (page filters) ----------
const realtimeInsectCount = ref(0);
const topSpecies = ref('--');
const periodCatches = ref(null);
const forecastStatus = ref('stable');
const forecastIcon = ref('');
const forecastText = computed(() => t(`analytics.forecast${forecastStatus.value === 'up' ? 'Up' : forecastStatus.value === 'down' ? 'Down' : 'Stable'}`));
const forecastIconComponent = computed(() => ({ up: Top, down: Bottom, stable: Minus }[forecastIcon.value] || null));
// Rising insect counts are bad (danger), falling are good (success)
const forecastType = computed(() => (forecastIcon.value === 'up' ? 'danger' : forecastIcon.value === 'down' ? 'success' : 'default'));

const sumInsects = (item) => (item.insects || []).reduce((a, b) => a + (b.value || 0), 0);
const speciesTotalsOf = (data) => {
  const totals = {};
  for (const item of data) {
    for (const ins of item.insects || []) {
      if (ins.value > 0) totals[normalizeSpecies(ins.label)] = (totals[normalizeSpecies(ins.label)] || 0) + ins.value;
    }
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
};

const loadSummary = async () => {
  const serial = pageDefaults.value.camera;
  const { startDate, endDate } = rangeDates(props.range);
  try {
    const [overview, catches] = await Promise.all([
      api.getAiOverview().catch(() => null),
      api.getStatistics(serial, 'day', startDate, endDate, 'catches').catch(() => null),
    ]);
    const ov = overview?.data?.overview;
    if (ov) {
      const found = isSingleCamera.value ? (ov.cameraRealtimeList || []).find(c => c.deviceSerial === serial) : null;
      realtimeInsectCount.value = isSingleCamera.value ? (found?.currentCount || 0) : (ov.peakRealtimeInsects || 0);
    }
    const series = catches?.data?.data || [];
    periodCatches.value = series.reduce((sum, item) => sum + sumInsects(item), 0);
    const totals = speciesTotalsOf(series);
    const all = totals.reduce((a, [, v]) => a + v, 0);
    topSpecies.value = totals.length ? `${totals[0][0]} (${Math.round((totals[0][1] / (all || 1)) * 100)}%)` : (ov?.topSpecies || '--');
    // Short-term trend: the last 3 days against the 3 before
    const daily = series.map(sumInsects);
    if (daily.length < 4) {
      forecastStatus.value = 'stable';
      forecastIcon.value = '';
    } else {
      const recent = daily.slice(-3).reduce((a, b) => a + b, 0);
      const before = daily.slice(-6, -3).reduce((a, b) => a + b, 0);
      const status = recent > before * 1.15 + 1 ? 'up' : recent < before * 0.85 - 1 ? 'down' : 'stable';
      forecastStatus.value = status;
      forecastIcon.value = status;
    }
  } catch (e) {
    console.error('Failed to load analytics summary:', e);
  }
};

// ---------- Main chart (own filters) ----------
const loading = ref(false);
const statsData = ref([]);
const lineChartRef = ref(null);
let lineChartInstance = null;

// Card replacements and treatments of the chosen camera, as period keys matching the chart's dateKey
const cardMarkerKeys = ref(new Set());
const treatmentMarkerKeys = ref(new Set());
const markerFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
const periodKeyOf = (date, mode) => {
  const parts = Object.fromEntries(markerFormat.formatToParts(new Date(date)).map(p => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (mode === 'hour') return `${day} ${parts.hour}:00`;
  return mode === 'month' ? day.slice(0, 7) : day;
};
const loadCardMarkers = async (serial, mode) => {
  if (!serial || serial === 'all') {
    cardMarkerKeys.value = new Set();
    treatmentMarkerKeys.value = new Set();
    return;
  }
  const [maintenance, treatments] = await Promise.allSettled([
    api.getMaintenance(serial, 100),
    api.listTreatments({ deviceSerial: serial, limit: 100 }),
  ]);
  const changes = maintenance.status === 'fulfilled' ? (maintenance.value.data.events || []).filter(e => e.type === 'card_replaced') : [];
  const applied = treatments.status === 'fulfilled' ? (treatments.value.data.treatments || []) : [];
  cardMarkerKeys.value = new Set(changes.map(e => periodKeyOf(e.at, mode)));
  treatmentMarkerKeys.value = new Set(applied.map(e => periodKeyOf(e.at, mode)));
};

// Dashed vertical line at each period where the sticky card was replaced or a treatment applied
const cardMarkerPlugin = {
  id: 'cardMarkers',
  afterDatasetsDraw(chart, _args, opts) {
    const sets = (opts?.sets || []).filter(set => set.indexes.length);
    if (!sets.length) return;
    const { ctx, chartArea: { top, bottom, right }, scales: { x } } = chart;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.font = '11px sans-serif';
    sets.forEach((set, row) => {
      ctx.strokeStyle = set.color;
      ctx.fillStyle = set.color;
      const labelWidth = ctx.measureText(set.label).width;
      for (const i of set.indexes) {
        const px = x.getPixelForValue(i);
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
        ctx.stroke();
        const textX = px + 4 + labelWidth > right ? px - 4 - labelWidth : px + 4;
        ctx.fillText(set.label, textX, top + 12 + row * 13);
      }
    });
    ctx.restore();
  },
};

const cssColor = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Chart.js config of the main chart; `print` uses fixed colors for the PDF. */
const lineConfig = (data, print = false) => {
  const insectMap = new Map();
  data.forEach((item, i) => {
    for (const ins of item.insects || []) {
      const norm = normalizeSpecies(ins.label);
      if (!insectMap.has(norm)) insectMap.set(norm, new Array(data.length).fill(0));
      insectMap.get(norm)[i] += ins.value || 0;
    }
  });
  const colors = PRINT.series;
  const datasets = [...insectMap.entries()].map(([label, values], i) => ({
    label: speciesName(label, t),
    data: values,
    borderColor: colors[i % colors.length],
    backgroundColor: `${colors[i % colors.length]}20`,
    borderWidth: print ? 2 : 3,
    tension: 0.4,
    fill: true,
    pointRadius: data.length > 60 ? 0 : 3,
  }));
  const indexesOf = (keys) => data.map((item, i) => (keys.has(item.dateKey) ? i : -1)).filter(i => i >= 0);
  return {
    type: 'line',
    data: { labels: data.map(item => item._id), datasets },
    plugins: [cardMarkerPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, font: { family: 'Quicksand' } } },
        cardMarkers: {
          sets: [
            { indexes: indexesOf(cardMarkerKeys.value), label: t('maintenance.chartMarker'), color: cssColor('--el-color-warning', '#e6a23c') },
            { indexes: indexesOf(treatmentMarkerKeys.value), label: t('logbook.chartMarker'), color: cssColor('--el-color-danger', '#f56c6c') },
          ],
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: print ? PRINT.grid : cssColor('--el-border-color', 'rgba(128,128,128,0.15)') } },
        x: { grid: { display: false } },
      },
    },
  };
};

const renderLine = async () => {
  lineChartInstance?.destroy();
  lineChartInstance = null;
  await nextTick();
  if (lineChartRef.value && statsData.value.length) lineChartInstance = new Chart(lineChartRef.value, lineConfig(statsData.value));
};

const fetchChart = async () => {
  const { camera, range, granularity } = chartFilter.value;
  const { startDate, endDate } = rangeDates(range);
  loading.value = true;
  try {
    await loadCardMarkers(camera, granularity);
    const res = await api.getStatistics(camera, granularity, startDate, endDate, useCatches.value ? 'catches' : null);
    statsData.value = res.data?.success ? res.data.data || [] : [];
  } catch {
    statsData.value = [];
  } finally {
    loading.value = false;
  }
  renderLine();
};

// ---------- Species ratio (own filters) ----------
const ratioLoading = ref(false);
const ratioTotals = ref([]);
const pieChartRef = ref(null);
let pieChartInstance = null;

const pieConfig = (totals) => ({
  type: 'doughnut',
  data: {
    labels: totals.map(([label]) => speciesName(label, t)),
    datasets: [{ data: totals.map(([, v]) => v), backgroundColor: PRINT.series.slice(0, totals.length), borderWidth: 0, hoverOffset: 16 }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '70%',
    plugins: { legend: { position: 'bottom', labels: { font: { family: 'Quicksand' } } } },
  },
});

const renderPie = async () => {
  pieChartInstance?.destroy();
  pieChartInstance = null;
  await nextTick();
  if (pieChartRef.value && ratioTotals.value.length) pieChartInstance = new Chart(pieChartRef.value, pieConfig(ratioTotals.value));
};

const fetchRatio = async () => {
  const { camera, range } = ratioFilter.value;
  const { startDate, endDate } = rangeDates(range);
  ratioLoading.value = true;
  try {
    const res = await api.getStatistics(camera, 'day', startDate, endDate, 'catches');
    ratioTotals.value = speciesTotalsOf(res.data?.data || []);
  } catch {
    ratioTotals.value = [];
  } finally {
    ratioLoading.value = false;
  }
  renderPie();
};

watch(pageDefaults, loadSummary, { deep: true });
watch(chartFilter, fetchChart, { deep: true });
watch(ratioFilter, fetchRatio, { deep: true });
watch(() => props.active, (isActive) => {
  if (!isActive) return;
  nextTick(() => {
    if (lineChartInstance) lineChartInstance.resize();
    else renderLine();
    if (pieChartInstance) pieChartInstance.resize();
    else renderPie();
  });
});

onMounted(() => {
  loadSummary();
  fetchChart();
  fetchRatio();
});
onUnmounted(() => {
  lineChartInstance?.destroy();
  pieChartInstance?.destroy();
});

// ---------- PDF ----------
const comparisonRef = ref(null);
const cameraName = (serial) => (serial === 'all' ? t('analytics.allCameras') : cameras.value.find(c => c.deviceSerial === serial)?.deviceName || serial);
const filterLine = (filter) => t('filters.summary', { camera: cameraName(filter.camera), range: dateRangeLabel(t, filter.range) });

/** What this tab shows, as PDF sections (utils/analyticsPdf.js). */
const pdfSections = async () => {
  const sections = [{
    part: t('analytics.tabTrends'),
    title: t('analytics.summaryTitle'),
    table: {
      head: [t('dashboards.pdf.figure'), t('dashboards.pdf.value')],
      body: [
        [isSingleCamera.value ? t('analytics.realtimeDensityTrap') : t('analytics.realtimeHotspotMax'), String(realtimeInsectCount.value)],
        [t('analytics.topSpeciesCard'), formatSpeciesDisplay(topSpecies.value)],
        [t('analytics.catchesInPeriod'), periodCatches.value === null ? '--' : String(Math.round(periodCatches.value))],
        [t('analytics.forecastCard'), forecastText.value],
      ],
      columnStyles: { 0: { cellWidth: 90 } },
    },
  }];
  sections.push({
    title: chartTitle.value,
    lines: [filterLine(chartFilter.value), t(`filters.granularities.${chartFilter.value.granularity}`)],
    chart: statsData.value.length ? lineConfig(statsData.value, true) : null,
    table: statsData.value.length ? null : { head: [chartTitle.value], body: [] },
  });
  sections.push({
    title: t('analytics.speciesRatio'),
    lines: [filterLine(ratioFilter.value)],
    table: {
      head: [t('analytics.report.colSpecies'), t('dashboards.kpi.fliesUnit'), '%'],
      body: (() => {
        const all = ratioTotals.value.reduce((a, [, v]) => a + v, 0) || 1;
        return ratioTotals.value.map(([label, v]) => [speciesName(label, t), String(Math.round(v * 10) / 10), `${Math.round((v / all) * 100)}%`]);
      })(),
    },
  });
  if (comparisonRef.value?.pdfSections) sections.push(...comparisonRef.value.pdfSections());
  return sections;
};

defineExpose({ pdfSections });
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.metric-hint {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
