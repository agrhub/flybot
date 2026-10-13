<template>
  <div v-if="activity && max > 0" class="overflow-auto" :style="maxHeight ? { maxHeight: `${maxHeight}px` } : null">
    <table class="heatmap">
      <thead>
        <tr>
          <th></th>
          <th v-for="h in activity.hours" :key="h" class="heatmap__hour">{{ h }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.day">
          <th class="heatmap__day">{{ shortDay(row.day) }}</th>
          <td v-for="(value, j) in row.cells" :key="j">
            <el-tooltip :content="t('insights.activityCell', { day: shortDay(row.day), hour: activity.hours[j], value })" placement="top" :show-after="200">
              <div class="heatmap__cell" :style="{ opacity: value ? 0.15 + 0.85 * (value / max) : 0.06 }"></div>
            </el-tooltip>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="flex items-center justify-end gap-2 mt-2 heatmap__meta">
      <span>{{ t('insights.less') }}</span>
      <div v-for="o in [0.15, 0.4, 0.65, 1]" :key="o" class="heatmap__cell heatmap__legend" :style="{ opacity: o }"></div>
      <span>{{ t('insights.more') }}</span>
    </div>
  </div>
  <el-empty v-else :description="emptyText || t('analytics.noStatsData')" :image-size="70" />
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * Flies arriving by local hour (rows: days, columns: hours), from catchStats.activityByHour:
 * { days: [dayKey], hours: [h], cells: [[n]], byHour: [n] }.
 */
const props = defineProps({
  activity: { type: Object, default: null },
  maxHeight: { type: Number, default: 0 },
  emptyText: { type: String, default: '' },
  // Today on top (for a scrolling box)
  newestFirst: { type: Boolean, default: false },
});

const { t } = useI18n();
const rows = computed(() => {
  const list = (props.activity?.cells || []).map((cells, i) => ({ day: props.activity.days[i], cells }));
  return props.newestFirst ? list.reverse() : list;
});
const max = computed(() => Math.max(0, ...(props.activity?.cells || []).flat()));
const shortDay = (key) => {
  const [, m, d] = String(key).split('-');
  return `${d}/${m}`;
};
</script>

<style scoped>
.heatmap {
  border-collapse: separate;
  border-spacing: 3px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.heatmap__hour {
  font-weight: 500;
  text-align: center;
  min-width: 22px;
}
.heatmap__day {
  font-weight: 500;
  text-align: right;
  padding-right: 6px;
  white-space: nowrap;
}
.heatmap__cell {
  width: 22px;
  height: 16px;
  border-radius: 3px;
  background-color: var(--el-color-primary);
}
.heatmap__legend {
  width: 14px;
  height: 10px;
}
.heatmap__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
