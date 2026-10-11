<template>
  <div class="flex flex-wrap items-center gap-2">
    <el-select
      :model-value="modelValue?.preset || '30d'"
      :size="size"
      :teleported="teleported"
      class="date-range__select"
      :aria-label="t('filters.dateRange')"
      @update:model-value="pickPreset"
    >
      <template #prefix><el-icon><Calendar /></el-icon></template>
      <el-option v-for="preset in presets" :key="preset" :label="t(`filters.ranges.${preset}`)" :value="preset" />
    </el-select>
    <el-date-picker
      v-if="modelValue?.preset === 'custom'"
      :model-value="dates"
      type="daterange"
      value-format="YYYY-MM-DD"
      format="DD/MM/YYYY"
      unlink-panels
      :size="size"
      :teleported="teleported"
      :clearable="false"
      :disabled-date="(date) => date.getTime() > Date.now()"
      :start-placeholder="t('analytics.startDate')"
      :end-placeholder="t('analytics.endDate')"
      class="date-range__dates"
      @update:model-value="pickDates"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Calendar } from '@element-plus/icons-vue';
import { DATE_PRESETS, dayKey } from '@/utils/dateRange';

/**
 * A date filter: today, last 7, 30 or 90 days, or chosen dates.
 * v-model: { preset, from?, to? } (day keys YYYY-MM-DD for a custom range).
 */
const props = defineProps({
  modelValue: { type: Object, default: () => ({ preset: '30d' }) },
  presets: { type: Array, default: () => DATE_PRESETS },
  size: { type: String, default: 'default' },
  // false inside a popover, so choosing does not close it
  teleported: { type: Boolean, default: true },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();

const dates = computed(() => (props.modelValue?.from && props.modelValue?.to ? [props.modelValue.from, props.modelValue.to] : []));

const pickPreset = (preset) => {
  if (preset !== 'custom') {
    emit('update:modelValue', { preset });
    return;
  }
  const today = new Date();
  const start = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  emit('update:modelValue', { preset, from: dayKey(start), to: dayKey(today) });
};

const pickDates = (value) => {
  if (value?.[0] && value?.[1]) emit('update:modelValue', { preset: 'custom', from: value[0], to: value[1] });
};
</script>

<style scoped>
.date-range__select {
  width: 160px;
}
.date-range__dates {
  max-width: 260px;
}
</style>
