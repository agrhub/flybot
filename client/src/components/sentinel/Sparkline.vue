<template>
  <figure class="spark">
    <svg :width="w" :height="h" :viewBox="`0 0 ${w} ${h}`" role="img" :aria-label="desc" focusable="false">
      <polyline v-if="path" :points="path" class="spark__line" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <line v-else x1="2" :x2="w - 2" :y1="h / 2" :y2="h / 2" class="spark__empty" stroke-dasharray="3 3" />
    </svg>
    <figcaption>
      {{ label }}
      <strong v-if="stats">{{ stats.last }}{{ unit }}</strong>
      <span v-else>{{ t('sentinel.devices.sparkNone') }}</span>
    </figcaption>
  </figure>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { sparkPath } from '@/utils/sentinel/devices';

// Small line chart of a telemetry value (battery, signal) over the recent photos
const props = defineProps({
  points: { type: Array, default: () => [] }, // [{ at, v }]
  label: { type: String, required: true },
  unit: { type: String, default: '' },
  w: { type: Number, default: 150 },
  h: { type: Number, default: 36 },
});
const { t } = useI18n();
const path = computed(() => sparkPath(props.points, props.w, props.h));
const stats = computed(() => {
  if (!props.points.length) return null;
  const vs = props.points.map((p) => p.v);
  return { min: Math.min(...vs), max: Math.max(...vs), last: vs[vs.length - 1] };
});
const desc = computed(() => (stats.value
  ? t('sentinel.devices.sparkDesc', { label: props.label, last: `${stats.value.last}${props.unit}`, min: stats.value.min, max: stats.value.max, count: props.points.length })
  : `${props.label}: ${t('sentinel.devices.sparkNone')}`));
</script>

<style scoped>
.spark {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.spark__line {
  stroke: var(--el-color-primary);
}
.spark__empty {
  stroke: var(--el-border-color);
}
figcaption {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
figcaption strong {
  color: var(--el-text-color-primary);
  font-weight: 600;
}
</style>
