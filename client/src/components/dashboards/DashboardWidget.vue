<template>
  <el-card shadow="never" class="dash-widget h-full" body-class="dash-widget__body" :data-widget-id="widget.id">
    <template #header>
      <div class="flex items-center justify-between gap-2 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <el-icon class="dash-widget__icon"><component :is="WIDGET_ICONS[widget.type]" /></el-icon>
          <span class="dash-widget__title truncate">{{ widget.title || t(`dashboards.widgetTypes.${widget.type}`) }}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <el-tag v-for="tag in ownTags" :key="tag" type="primary" effect="plain" size="small" class="hidden sm:inline-flex">{{ tag }}</el-tag>
          <el-tooltip v-if="shortWindow" :content="t('dashboards.activityWindow', { days: data.windowDays })" placement="top">
            <el-tag type="info" effect="plain" size="small">{{ t('dashboards.lastDays', { days: data.windowDays }) }}</el-tag>
          </el-tooltip>
          <slot name="actions" />
        </div>
      </div>
    </template>

    <div :style="{ minHeight: `${bodyHeight}px` }" class="h-full">
      <el-skeleton v-if="loading && !data" :rows="3" animated />
      <el-empty v-else-if="!data" :description="t('dashboards.noData')" :image-size="56" />

      <!-- Key figures -->
      <div v-else-if="widget.type === 'kpi'" class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        <StatCard
          :label="t('dashboards.kpi.catches')"
          :value="formatNumber(data.catches)"
          :unit="t('dashboards.kpi.fliesUnit')"
          :icon="DataLine"
          type="primary"
          :description="data.previousCatches === null ? t('dashboards.kpi.noPrevious') : t('dashboards.kpi.vsPrevious', { change: formatChange(data.changePct), previous: formatNumber(data.previousCatches) })"
        />
        <StatCard
          :label="t('dashboards.kpi.ftd')"
          :value="formatNumber(data.ftd)"
          :icon="TrendCharts"
          :description="data.previousFtd === null ? t('dashboards.kpi.noPrevious') : t('dashboards.kpi.previousValue', { value: formatNumber(data.previousFtd) })"
        />
        <StatCard :label="t('dashboards.kpi.avgPerDay')" :value="formatNumber(data.avgPerDay)" :icon="Histogram" :description="t('dashboards.kpi.allTraps')" />
        <StatCard
          :label="t('dashboards.kpi.busiestDay')"
          :value="data.busiestDay ? formatNumber(data.busiestDay.value) : '--'"
          :icon="TopRight"
          :description="data.busiestDay ? formatDayKey(data.busiestDay.day) : ''"
        />
        <StatCard
          :label="t('dashboards.kpi.alertCameras')"
          :value="data.alertCameras"
          :icon="Warning"
          :type="data.alertCameras > 0 ? 'danger' : 'success'"
          :description="t('dashboards.kpi.alertHint')"
        />
        <StatCard :label="t('dashboards.kpi.cameras')" :value="data.cameras" :icon="VideoCamera" :description="t('dashboards.kpi.online', { count: data.online })" />
        <StatCard :label="t('dashboards.kpi.scans')" :value="data.scans" :icon="Camera" />
      </div>

      <!-- Daily catches, with the period before -->
      <template v-else-if="widget.type === 'trend' || widget.type === 'species'">
        <el-empty
          v-if="(widget.type === 'species' && !data.species?.length) || (widget.type === 'trend' && !hasTrend)"
          :description="t('dashboards.noDetections')"
          :image-size="56"
        />
        <div v-else class="dash-widget__chart" :style="{ height: `${bodyHeight}px` }">
          <canvas ref="chartRef"></canvas>
        </div>
      </template>

      <!-- Catches per trap -->
      <CatchBarChart
        v-else-if="widget.type === 'catchesByTrap'"
        :labels="trapLabels"
        :series="trapSeries"
        :height="bodyHeight"
        :y-title="t('dashboards.kpi.fliesUnit')"
        :empty-text="t('dashboards.noDetections')"
      />

      <!-- Trap table -->
      <template v-else-if="widget.type === 'cameraRanking'">
        <el-empty v-if="!data.cameras?.length" :description="t('dashboards.noCameras')" :image-size="56" />
        <el-table v-else :data="data.cameras" size="small" :max-height="bodyHeight" style="width: 100%">
          <el-table-column type="index" width="44" />
          <el-table-column :label="t('dashboards.ranking.trap')" min-width="160">
            <template #default="{ row }">
              <div class="flex items-center gap-2 min-w-0">
                <span class="truncate">{{ row.deviceName }}</span>
                <el-tag type="info" effect="plain" size="small">{{ t(`trapKind.${row.trapKind}.short`) }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.total')" width="100" align="right">
            <template #default="{ row }">{{ formatNumber(row.total) }}</template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.ftd')" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.ftd) }}</template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.change')" width="110" align="right">
            <template #default="{ row }">
              <el-tag :type="changeTagType(row.changePct)" effect="light" size="small">{{ formatChange(row.changePct) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.busiestDay')" width="120" align="right">
            <template #default="{ row }">
              {{ row.busiestDay ? `${formatNumber(row.busiestDay.value)} (${formatDayKey(row.busiestDay.day)})` : '--' }}
            </template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.latest')" width="120" align="right">
            <template #default="{ row }">
              <el-tag :type="RISK_TAG[row.risk]" effect="light" round size="small">{{ row.latestCount }} / {{ row.threshold }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <!-- Catches by day, week or month -->
      <template v-else-if="widget.type === 'dailyTable'">
        <el-empty v-if="!data.rows?.length" :description="t('dashboards.noDetections')" :image-size="56" />
        <el-table v-else :data="data.rows" size="small" :max-height="bodyHeight" style="width: 100%">
          <el-table-column :label="t(`dashboards.periodUnit.${data.unit}`)" min-width="110">
            <template #default="{ row }">{{ formatPeriod(row.from, row.to, data.unit) }}</template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.total')" width="100" align="right">
            <template #default="{ row }">{{ formatNumber(row.total) }}</template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.ftd')" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.ftd) }}</template>
          </el-table-column>
          <el-table-column :label="t('dashboards.topSpecies')" min-width="140">
            <template #default="{ row }">
              <span v-if="row.topSpecies">{{ speciesName(row.topSpecies.label, t) }} ({{ row.topSpecies.value }})</span>
              <span v-else>--</span>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <!-- Flies arriving by hour -->
      <template v-else-if="widget.type === 'activity'">
        <p v-if="peakHour !== null" class="dash-widget__meta mb-2">{{ t('insights.activityPeak', { from: peakHour, to: peakHour + 1 }) }}</p>
        <ActivityHeatmap :activity="data" :max-height="bodyHeight - 24" :empty-text="t('dashboards.noDetections')" newest-first />
      </template>

      <!-- Latest snapshots -->
      <template v-else-if="widget.type === 'latestSnapshot'">
        <el-empty v-if="!data.snapshots?.length" :description="t('dashboards.noCameras')" :image-size="56" />
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 dash-widget__scroll" :style="{ maxHeight: `${bodyHeight}px` }">
          <div v-for="snap in data.snapshots" :key="snap.deviceSerial" class="dash-snap">
            <el-image
              v-if="snap.imageUrl"
              :src="snap.imageUrl"
              :preview-src-list="[snap.imageUrl]"
              preview-teleported
              fit="cover"
              class="dash-snap__image"
              lazy
            >
              <template #error>
                <div class="dash-snap__image dash-snap__image--empty"><el-icon><Picture /></el-icon></div>
              </template>
            </el-image>
            <div v-else class="dash-snap__image dash-snap__image--empty"><el-icon><Picture /></el-icon></div>
            <div class="p-2.5">
              <div class="flex items-center justify-between gap-2 min-w-0">
                <span class="dash-widget__strong truncate">{{ snap.deviceName }}</span>
                <el-tag :type="RISK_TAG[snap.risk]" effect="light" round size="small">{{ snap.count }}</el-tag>
              </div>
              <div class="dash-widget__meta">{{ snap.createdAt ? formatDateTime(snap.createdAt) : t('dashboards.noSnapshot') }}</div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import Chart from 'chart.js/auto';
import {
  Odometer, TrendCharts, PieChart, Histogram, Picture, VideoCamera, Warning, DataLine, TopRight, Camera, Grid, Timer, List,
} from '@element-plus/icons-vue';
import StatCard from '@/components/common/StatCard.vue';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';
import ActivityHeatmap from '@/components/charts/ActivityHeatmap.vue';
import { speciesName } from '@/utils/species';
import { formatDayKey, formatPeriod, formatNumber, formatChange, changeTagType, rangeLabel } from '@/utils/dashboards';

const props = defineProps({
  widget: { type: Object, required: true },
  data: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  // Days in the report's range (the hourly widget may cover fewer)
  rangeDays: { type: Number, default: 0 },
});

const WIDGET_ICONS = {
  kpi: Odometer, trend: TrendCharts, catchesByTrap: Histogram, species: PieChart,
  cameraRanking: List, dailyTable: Grid, activity: Timer, latestSnapshot: Picture,
};
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' };
const ROW_HEIGHT = 80;
const HEADER_HEIGHT = 120;

const { t, locale } = useI18n();
const chartRef = ref(null);
let chart = null;

const bodyHeight = computed(() => Math.max(140, (props.widget.layout?.h || 4) * ROW_HEIGHT - HEADER_HEIGHT));
const shortWindow = computed(() => props.widget.type === 'activity' && props.data?.windowDays && (props.data.range?.days || props.rangeDays) > props.data.windowDays);
// The widget's own filters, shown next to its title
const ownTags = computed(() => [
  ...(props.widget.range?.preset ? [rangeLabel(t, props.widget.range)] : []),
  ...(props.widget.status && props.widget.status !== 'all' ? [t(`filters.statuses.${props.widget.status}`)] : []),
  ...(props.widget.risk && props.widget.risk !== 'all' ? [t(`filters.risks.${props.widget.risk}`)] : []),
]);
const hasTrend = computed(() => (props.data?.points || []).some(p => p.value || p.previous));

const trapLabels = computed(() => (props.data?.labels || []).map(key => formatDayKey(key, props.data.unit === 'month' ? 'month' : 'day')));
const trapSeries = computed(() => (props.data?.series || []).map(s => ({ label: s.deviceName, data: s.data })));

const peakHour = computed(() => {
  const byHour = props.data?.byHour || [];
  const max = Math.max(0, ...byHour);
  return max > 0 ? props.data.hours[byHour.indexOf(max)] : null;
});

const formatDateTime = (value) => new Date(value).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const destroyChart = () => {
  chart?.destroy();
  chart = null;
};

const renderChart = async () => {
  destroyChart();
  await nextTick();
  if (!chartRef.value || !props.data) return;
  const gridColor = cssVar('--el-border-color', 'rgba(128,128,128,0.15)');
  const textColor = cssVar('--el-text-color-secondary', '#888');
  const primary = cssVar('--el-color-primary', '#10b981');
  const muted = cssVar('--el-text-color-placeholder', '#a8abb2');

  if (props.widget.type === 'trend') {
    const points = props.data.points || [];
    const hasPrevious = points.some(p => p.previous !== null && p.previous !== undefined);
    chart = new Chart(chartRef.value, {
      type: 'line',
      data: {
        labels: points.map(p => formatDayKey(p.date, props.data.unit === 'month' ? 'month' : 'day')),
        datasets: [
          {
            label: t('dashboards.thisPeriod'),
            data: points.map(p => p.value),
            borderColor: primary,
            backgroundColor: cssVar('--el-color-primary-light-8', 'rgba(16,185,129,0.15)'),
            borderWidth: 2,
            tension: 0.35,
            fill: true,
            spanGaps: true,
            pointRadius: points.length > 45 ? 0 : 3,
          },
          ...(hasPrevious ? [{
            label: t('dashboards.previousPeriod'),
            data: points.map(p => p.previous),
            borderColor: muted,
            borderDash: [5, 4],
            borderWidth: 1.5,
            tension: 0.35,
            fill: false,
            spanGaps: true,
            pointRadius: 0,
          }] : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { color: textColor, boxWidth: 12, usePointStyle: true } } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0, color: textColor }, grid: { color: gridColor } },
          x: { ticks: { color: textColor, maxTicksLimit: 12 }, grid: { display: false } },
        },
      },
    });
  } else if (props.widget.type === 'species') {
    const species = props.data.species || [];
    if (!species.length) return;
    const total = species.reduce((sum, s) => sum + s.value, 0) || 1;
    const palette = ['primary', 'warning', 'danger', 'info', 'success'].map(c => cssVar(`--el-color-${c}`, primary));
    chart = new Chart(chartRef.value, {
      type: 'bar',
      data: {
        labels: species.map(s => speciesName(s.label, t)),
        datasets: [{
          data: species.map(s => s.value),
          backgroundColor: species.map((_, i) => palette[i % palette.length]),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${ctx.raw} (${Math.round((ctx.raw / total) * 100)}%)` } },
        },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0, color: textColor }, grid: { color: gridColor } },
          y: { ticks: { color: textColor }, grid: { display: false } },
        },
      },
    });
  }
};

watch(
  () => [props.data, props.widget.type, props.widget.layout?.h, locale.value],
  () => {
    if (['trend', 'species'].includes(props.widget.type)) renderChart();
    else destroyChart();
  },
  { immediate: true }
);

onBeforeUnmount(destroyChart);
</script>

<style scoped>
.dash-widget :deep(.dash-widget__body) {
  padding: 14px 16px;
}
.dash-widget__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.dash-widget__icon {
  color: var(--el-color-primary);
}
.dash-widget__strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.dash-widget__meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.dash-widget__chart {
  position: relative;
  width: 100%;
}
.dash-widget__scroll {
  overflow-y: auto;
}
.dash-snap {
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
  background-color: var(--el-bg-color);
}
.dash-snap__image {
  width: 100%;
  aspect-ratio: 16 / 9;
  display: block;
}
.dash-snap__image--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  background-color: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}
</style>
