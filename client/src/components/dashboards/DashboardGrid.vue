<template>
  <div class="dash-grid">
    <div
      v-for="widget in orderedWidgets"
      :key="widget.id"
      class="dash-grid__item"
      :style="{
        '--span-lg': widget.layout?.w || 12,
        '--span-md': (widget.layout?.w || 12) < 12 ? 12 : 24,
      }"
    >
      <DashboardWidget :widget="widget" :data="data?.[widget.id] || null" :loading="loading">
        <template v-if="$slots.actions" #actions>
          <slot name="actions" :widget="widget" />
        </template>
      </DashboardWidget>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import DashboardWidget from './DashboardWidget.vue';

const props = defineProps({
  widgets: { type: Array, default: () => [] },
  // Widget data keyed by widget id
  data: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});

// Row-major order (top to bottom, then left to right)
const orderedWidgets = computed(() => [...props.widgets].sort((a, b) =>
  (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0)));
</script>

<style scoped>
.dash-grid {
  display: grid;
  grid-template-columns: repeat(24, minmax(0, 1fr));
  gap: 16px;
}
.dash-grid__item {
  grid-column: span 24;
  min-width: 0;
}
@media (min-width: 768px) {
  .dash-grid__item {
    grid-column: span var(--span-md);
  }
}
@media (min-width: 1280px) {
  .dash-grid__item {
    grid-column: span var(--span-lg);
  }
}
</style>
