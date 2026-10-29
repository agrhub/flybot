<template>
  <div class="flex flex-col gap-3" data-test="camos-power">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span class="camos-power__title">{{ t('camosPower.title') }}</span>
      <div class="flex items-center gap-2">
        <el-segmented v-model="days" :options="rangeOptions" size="small" data-test="power-range" />
        <el-button size="small" :icon="Refresh" circle :loading="loading" :aria-label="t('camosPower.reload')" @click="load" />
      </div>
    </div>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <div v-else v-loading="loading">
      <el-empty v-if="!loading && !points.length" :description="t('camosPower.empty')" :image-size="70" />
      <template v-else-if="points.length">
        <el-alert v-if="inputLow" type="warning" :closable="false" show-icon class="mb-3" :title="t('camosPower.inputLow', { v: fmt(summary.solarMaxMv / 1000, 2) })" data-test="power-input-low" />
        <el-descriptions :column="isMobile ? 1 : 2" border size="small" class="mb-3" data-test="power-summary">
          <el-descriptions-item :label="t('camosPower.drain')">{{ rateText(summary.drainMvPerHour, summary.drainPctPerHour) }}</el-descriptions-item>
          <el-descriptions-item :label="t('camosPower.charge')">{{ rateText(summary.chargeMvPerHour) }}</el-descriptions-item>
          <el-descriptions-item :label="t('camosPower.chargingTime')">{{ t('camosPower.hours', { n: fmt(summary.chargingHours, 1) }) }}</el-descriptions-item>
          <el-descriptions-item :label="t('camosPower.inputMax')">{{ summary.solarMaxMv != null ? `${fmt(summary.solarMaxMv / 1000, 2)} V` : dash }}</el-descriptions-item>
          <el-descriptions-item v-if="summary.hoursLeft != null" :label="t('camosPower.hoursLeft')">{{ t('camosPower.hours', { n: fmt(summary.hoursLeft, 0) }) }}</el-descriptions-item>
        </el-descriptions>
        <div class="relative w-full" :style="{ height: `${isMobile ? 220 : 260}px` }">
          <canvas ref="voltageRef"></canvas>
        </div>
        <p class="camos-power__subtitle">{{ t('camosPower.rateTitle') }}</p>
        <p class="camos-power__hint">{{ t('camosPower.rateHint') }}</p>
        <div class="relative w-full" :style="{ height: `${isMobile ? 150 : 170}px` }">
          <canvas v-show="rates.length" ref="rateRef"></canvas>
          <div v-if="!rates.length" class="h-full flex items-center justify-center camos-power__hint">{{ t('camosPower.noRate') }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Chart from 'chart.js/auto';
import { Refresh } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useTheme } from '@/utils/theme';
import { requestErrorText } from '@/utils/requestError';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { POWER_RANGES, timeTicks, tickLabel, voltageSeries, rateSeries, chargingBands } from '@/utils/powerChart';

/**
 * Battery history of a CamOS camera (GET /api/cameras/:serial/power-history): the cell voltage and percent, the panel /
 * charger input, the periods it charged (shaded), and the rate of change (mV/h): its consumption and its charging.
 */
const props = defineProps({
  camera: { type: Object, required: true },
});
const { t, locale } = useI18n();
const { isDark } = useTheme();
const { isMobile } = useBreakpoints();
const dash = '—';

const days = ref(1);
const loading = ref(false);
const error = ref('');
const data = ref(null);
const voltageRef = ref(null);
const rateRef = ref(null);
let voltageChart = null;
let rateChart = null;

const RANGE_KEYS = { 1: 'day', 7: 'week', 30: 'month' };
const rangeOptions = computed(() => POWER_RANGES.map((d) => ({ value: d, label: t(`camosPower.range.${RANGE_KEYS[d]}`) })));
const points = computed(() => data.value?.battery?.points || []);
const rates = computed(() => data.value?.battery?.rates || []);
const summary = computed(() => data.value?.battery?.summary || {});
// The charger needs about 4.5 V at its input: a panel that never reaches it cannot charge the cell
const inputLow = computed(() => Number.isFinite(summary.value.solarMaxMv) && summary.value.solarMaxMv > 0 && summary.value.solarMaxMv < 4500);

const fmt = (v, digits) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : dash);
const signed = (v, digits) => (v > 0 ? `+${fmt(v, digits)}` : fmt(v, digits));
function rateText(mv, pct) {
  if (!Number.isFinite(mv)) return dash;
  return Number.isFinite(pct) ? t('camosPower.perHourPct', { mv: signed(mv, 0), pct: signed(pct, 1) }) : t('camosPower.perHour', { mv: signed(mv, 0) });
}

async function load() {
  if (!props.camera?.deviceSerial) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await api.getPowerHistory(props.camera.deviceSerial, days.value);
    data.value = res.data;
  } catch (err) {
    data.value = null;
    error.value = requestErrorText(t, err, t('camosPower.loadFailed'));
  } finally {
    loading.value = false;
  }
  render();
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// The charging periods, shaded behind the lines
const bandsPlugin = {
  id: 'chargingBands',
  beforeDatasetsDraw(chart, _args, options) {
    const { ctx, chartArea, scales } = chart;
    if (!options.bands?.length || !chartArea) return;
    ctx.save();
    for (const [from, to, slow] of options.bands) {
      const x1 = Math.max(scales.x.getPixelForValue(from), chartArea.left);
      const x2 = Math.min(scales.x.getPixelForValue(to), chartArea.right);
      if (x2 < chartArea.left || x1 > chartArea.right) continue;
      ctx.fillStyle = slow ? options.slowColor : options.color;
      ctx.fillRect(x1, chartArea.top, Math.max(2, x2 - x1), chartArea.bottom - chartArea.top);
    }
    ctx.restore();
  },
};

function timeAxis(text, grid) {
  const range = data.value;
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const ticks = timeTicks(new Date(from), new Date(to), range.days);
  return {
    type: 'linear',
    min: from,
    max: to,
    afterBuildTicks: (axis) => { axis.ticks = ticks.map((value) => ({ value })); },
    ticks: { color: text, autoSkip: true, maxRotation: 0, callback: (v) => tickLabel(v, range.days, locale.value) },
    grid: { color: grid },
  };
}
const tooltipTitle = (items) => (items.length ? new Date(items[0].parsed.x).toLocaleString(locale.value, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

async function render() {
  await nextTick();
  voltageChart?.destroy();
  rateChart?.destroy();
  voltageChart = null;
  rateChart = null;
  if (!points.value.length || !voltageRef.value) return;
  const text = cssVar('--el-text-color-secondary');
  const grid = cssVar('--el-border-color-lighter');
  const s = voltageSeries(points.value);
  const line = (label, values, color, extra = {}) => ({ type: 'line', label, data: values, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: values.length > 80 ? 0 : 2, tension: 0.2, yAxisID: 'y', ...extra });
  const datasets = [
    line(t('camosPower.cell'), s.cell, cssVar('--el-color-primary')),
    ...(s.input.length ? [line(t('camosPower.input'), s.input, cssVar('--el-color-warning'), { borderWidth: 1.5 })] : []),
    ...(s.measured.length ? [line(t('camosPower.measured'), s.measured, cssVar('--el-color-danger'), { borderWidth: 1, borderDash: [4, 3], showLine: false, pointRadius: 2 })] : []),
    ...(s.pct.length ? [line(t('camosPower.percent'), s.pct, cssVar('--el-color-info'), { borderWidth: 1.5, borderDash: [6, 4], yAxisID: 'y2' })] : []),
  ];
  // Charging shows as a band; its legend entry is an empty dataset in the band's color
  const bands = chargingBands(data.value.battery.charging);
  const bandColor = cssVar('--el-color-success-light-8');
  const slowColor = cssVar('--el-color-warning-light-8');
  if (bands.length) datasets.push({ type: 'bar', label: t('camosPower.charging'), data: [], backgroundColor: bandColor, borderColor: bandColor });
  if (bands.some((b) => b[2])) datasets.push({ type: 'bar', label: t('camosPower.chargingSlow'), data: [], backgroundColor: slowColor, borderColor: slowColor });
  voltageChart = new Chart(voltageRef.value, {
    data: { datasets },
    plugins: [bandsPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        chargingBands: { bands, color: bandColor, slowColor },
        legend: { position: 'bottom', labels: { color: text, boxWidth: 12, usePointStyle: true } },
        tooltip: {
          callbacks: {
            title: tooltipTitle,
            label: (ctx) => (ctx.dataset.yAxisID === 'y2' ? `${ctx.dataset.label}: ${fmt(ctx.parsed.y, 0)}` : `${ctx.dataset.label}: ${fmt(ctx.parsed.y, 2)}`),
          },
        },
      },
      scales: {
        x: timeAxis(text, grid),
        // The legend's bar entries would start the axis at 0: it follows the cell's range instead
        y: { beginAtZero: false, grace: '5%', ticks: { color: text, callback: (v) => fmt(v, 1) }, grid: { color: grid }, title: { display: true, text: 'V', color: text } },
        ...(s.pct.length ? { y2: { position: 'right', min: 0, max: 100, ticks: { color: text }, grid: { display: false }, title: { display: true, text: '%', color: text } } } : {}),
      },
    },
  });
  if (!rates.value.length || !rateRef.value) return;
  const r = rateSeries(rates.value);
  const up = cssVar('--el-color-success');
  const down = cssVar('--el-color-danger');
  rateChart = new Chart(rateRef.value, {
    type: 'bar',
    data: { datasets: [{ label: t('camosPower.rate'), data: r, backgroundColor: r.map((p) => (p.y >= 0 ? up : down)), borderRadius: 2, barPercentage: 0.9, categoryPercentage: 1 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: tooltipTitle,
            label: (ctx) => rateText(ctx.raw.y, ctx.raw.pct),
            afterLabel: (ctx) => (ctx.raw.charging ? t('camosPower.charging') : ''),
          },
        },
      },
      scales: {
        x: timeAxis(text, grid),
        y: { ticks: { color: text, callback: (v) => signed(v, 0) }, grid: { color: grid }, title: { display: true, text: t('camosPower.rateUnit'), color: text } },
      },
    },
  });
}

watch(days, load);
watch(() => props.camera?.deviceSerial, load);
watch([isDark, locale], render);
onMounted(load);
onBeforeUnmount(() => {
  voltageChart?.destroy();
  rateChart?.destroy();
});
</script>

<style scoped>
.camos-power__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.camos-power__subtitle {
  margin: 12px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.camos-power__hint {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
