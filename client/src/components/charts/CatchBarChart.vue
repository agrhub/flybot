<template>
  <div class="relative w-full" :style="{ height: `${height}px` }">
    <canvas v-show="hasData" ref="canvasRef"></canvas>
    <div v-if="!hasData" class="h-full flex items-center justify-center">
      <el-empty :description="emptyText" :image-size="70" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Chart from 'chart.js/auto';
import { useTheme } from '@/utils/theme';

/**
 * Stacked bars of daily values, one series per trap (or any group), with an optional line
 * series on a second axis (e.g. temperature). Colors come from the Element Plus theme.
 */
const props = defineProps({
  labels: { type: Array, default: () => [] },
  // [{ label, data: [number|null], type?: 'bar' | 'line', axis?: 'y' | 'y2' }]
  series: { type: Array, default: () => [] },
  height: { type: Number, default: 300 },
  yTitle: { type: String, default: '' },
  y2Title: { type: String, default: '' },
  emptyText: { type: String, default: '' },
  stacked: { type: Boolean, default: true }
});

const { isDark } = useTheme();
const canvasRef = ref(null);
let chart = null;

const hasData = computed(() => props.series.some(s => (s.data || []).some(v => v !== null && v !== undefined && v !== 0)));

const PALETTE = ['primary', 'success', 'warning', 'danger', 'info'];
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colorOf = (i) => {
  const base = PALETTE[i % PALETTE.length];
  // Further series use lighter shades of the same theme colors
  const shade = Math.floor(i / PALETTE.length);
  return cssVar(shade ? `--el-color-${base}-light-${Math.min(7, shade * 3)}` : `--el-color-${base}`) || '#409eff';
};

const render = async () => {
  await nextTick();
  if (chart) {
    chart.destroy();
    chart = null;
  }
  if (!hasData.value || !canvasRef.value) return;
  const text = cssVar('--el-text-color-secondary');
  const grid = cssVar('--el-border-color-lighter');
  const hasY2 = props.series.some(s => s.axis === 'y2');
  let barIndex = 0;
  chart = new Chart(canvasRef.value, {
    data: {
      labels: props.labels,
      datasets: props.series.map((s) => {
        const color = s.color || colorOf(s.type === 'line' ? props.series.length + barIndex : barIndex++);
        return {
          type: s.type || 'bar',
          label: s.label,
          data: s.data,
          yAxisID: s.axis || 'y',
          backgroundColor: s.type === 'line' ? color : color,
          borderColor: color,
          borderWidth: s.type === 'line' ? 2 : 0,
          borderRadius: s.type === 'line' ? 0 : 3,
          pointRadius: s.type === 'line' ? 2 : 0,
          tension: 0.3,
          spanGaps: true,
          stack: s.type === 'line' ? undefined : (props.stacked ? 'catches' : s.label),
          order: s.type === 'line' ? 0 : 1
        };
      })
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: text, boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw ?? '--'}` } }
      },
      scales: {
        x: { stacked: props.stacked, ticks: { color: text }, grid: { display: false } },
        y: {
          stacked: props.stacked,
          beginAtZero: true,
          ticks: { color: text, precision: 0 },
          grid: { color: grid },
          title: { display: !!props.yTitle, text: props.yTitle, color: text }
        },
        ...(hasY2 ? {
          y2: {
            position: 'right',
            ticks: { color: text },
            grid: { display: false },
            title: { display: !!props.y2Title, text: props.y2Title, color: text }
          }
        } : {})
      }
    }
  });
};

watch(() => [props.labels, props.series, isDark.value], render, { deep: true });
onMounted(render);
onBeforeUnmount(() => chart?.destroy());
</script>
