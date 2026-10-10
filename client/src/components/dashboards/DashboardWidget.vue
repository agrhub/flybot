<template>
  <el-card shadow="never" class="dash-widget h-full" body-class="dash-widget__body">
    <template #header>
      <div class="flex items-center justify-between gap-2 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <el-icon class="dash-widget__icon"><component :is="WIDGET_ICONS[widget.type]" /></el-icon>
          <span class="dash-widget__title truncate">{{ widget.title || t(`dashboards.widgetTypes.${widget.type}`) }}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <el-tag v-if="widget.type !== 'latestSnapshot'" type="info" effect="plain" size="small">
            {{ t('dashboards.lastDays', { days: widget.rangeDays }) }}
          </el-tag>
          <slot name="actions" />
        </div>
      </div>
    </template>

    <div :style="{ minHeight: `${bodyHeight}px` }" class="h-full">
      <el-skeleton v-if="loading && !data" :rows="3" animated />
      <el-empty v-else-if="!data" :description="t('dashboards.noData')" :image-size="56" />

      <!-- KPI tiles -->
      <div v-else-if="widget.type === 'kpi'" class="grid grid-cols-2 xl:grid-cols-3 gap-3">
        <StatCard :label="t('dashboards.kpi.cameras')" :value="data.cameras" :icon="VideoCamera" :description="t('dashboards.kpi.online', { count: data.online })" />
        <StatCard :label="t('dashboards.kpi.alertCameras')" :value="data.alertCameras" :icon="Warning" :type="data.alertCameras > 0 ? 'danger' : 'success'" />
        <StatCard :label="t('dashboards.kpi.totalPests')" :value="data.totalPests" :icon="DataLine" type="primary" />
        <StatCard :label="t('dashboards.kpi.peak')" :value="data.peak" :icon="TopRight" />
        <StatCard :label="t('dashboards.kpi.scans')" :value="data.scans" :icon="Camera" />
      </div>

      <!-- Trend / species charts -->
      <template v-else-if="widget.type === 'trend' || widget.type === 'species'">
        <el-empty
          v-if="widget.type === 'species' && !data.species?.length"
          :description="t('dashboards.noDetections')"
          :image-size="56"
        />
        <div v-else class="dash-widget__chart" :style="{ height: `${bodyHeight}px` }">
          <canvas ref="chartRef"></canvas>
        </div>
      </template>

      <!-- Camera ranking -->
      <template v-else-if="widget.type === 'cameraRanking'">
        <el-empty v-if="!data.cameras?.length" :description="t('dashboards.noCameras')" :image-size="56" />
        <el-table v-else :data="data.cameras" size="small" :max-height="bodyHeight" style="width: 100%">
          <el-table-column type="index" width="44" />
          <el-table-column :label="t('cameras.deviceName')" min-width="140">
            <template #default="{ row }">
              <span class="truncate">{{ row.deviceName }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('dashboards.ranking.total')" prop="total" width="90" align="right" />
          <el-table-column :label="t('dashboards.ranking.peak')" prop="peak" width="80" align="right" />
          <el-table-column :label="t('dashboards.ranking.latest')" width="120" align="right">
            <template #default="{ row }">
              <el-tag :type="RISK_TAG[row.risk]" effect="light" round size="small">{{ row.latestCount }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
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
  Odometer, TrendCharts, PieChart, Histogram, Picture, VideoCamera, Warning, DataLine, TopRight, Camera,
} from '@element-plus/icons-vue';
import StatCard from '@/components/common/StatCard.vue';
import { speciesName } from '@/utils/species';

const props = defineProps({
  widget: { type: Object, required: true },
  data: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});

const WIDGET_ICONS = { kpi: Odometer, trend: TrendCharts, species: PieChart, cameraRanking: Histogram, latestSnapshot: Picture };
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' };
// Chart series colors (allowed exception to the theme-only rule)
const SERIES_COLORS = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
const ROW_HEIGHT = 80;
const HEADER_HEIGHT = 120;

const { t, locale } = useI18n();
const chartRef = ref(null);
let chart = null;

const bodyHeight = computed(() => Math.max(140, (props.widget.layout?.h || 4) * ROW_HEIGHT - HEADER_HEIGHT));

const formatDateTime = (value) => new Date(value).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const formatDay = (date) => {
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
};
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

  if (props.widget.type === 'trend') {
    const points = props.data.points || [];
    chart = new Chart(chartRef.value, {
      type: 'line',
      data: {
        labels: points.map(p => formatDay(p.date)),
        datasets: [{
          label: t('dashboards.kpi.totalPests'),
          data: points.map(p => p.value),
          borderColor: SERIES_COLORS[0],
          backgroundColor: `${SERIES_COLORS[0]}20`,
          borderWidth: 2,
          tension: 0.35,
          fill: true,
          pointRadius: points.length > 45 ? 0 : 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0, color: textColor }, grid: { color: gridColor } },
          x: { ticks: { color: textColor, maxTicksLimit: 12 }, grid: { display: false } },
        },
      },
    });
  } else if (props.widget.type === 'species') {
    const species = props.data.species || [];
    if (!species.length) return;
    chart = new Chart(chartRef.value, {
      type: 'bar',
      data: {
        labels: species.map(s => speciesName(s.label, t)),
        datasets: [{
          data: species.map(s => s.value),
          backgroundColor: species.map((_, i) => SERIES_COLORS[i % SERIES_COLORS.length]),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
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
