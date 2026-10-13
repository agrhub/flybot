<template>
  <div class="flex flex-wrap items-center gap-2">
    <el-select :model-value="modelValue?.preset || '7d'" class="range-select" :aria-label="t('dashboards.range')" @update:model-value="pickPreset">
      <template #prefix><el-icon><Calendar /></el-icon></template>
      <el-option v-for="preset in RANGE_PRESETS" :key="preset" :label="t(`dashboards.ranges.${preset}`)" :value="preset" />
    </el-select>
    <template v-if="modelValue?.preset === 'custom' && isMobile">
      <el-date-picker
        :model-value="modelValue.from"
        type="date"
        value-format="YYYY-MM-DD"
        format="DD/MM/YYYY"
        :clearable="false"
        :disabled-date="(date) => date.getTime() > Date.now()"
        :placeholder="t('dashboards.rangeFrom')"
        class="range-day"
        @update:model-value="(v) => pickDates([v, modelValue.to])"
      />
      <el-date-picker
        :model-value="modelValue.to"
        type="date"
        value-format="YYYY-MM-DD"
        format="DD/MM/YYYY"
        :clearable="false"
        :disabled-date="(date) => date.getTime() > Date.now()"
        :placeholder="t('dashboards.rangeTo')"
        class="range-day"
        @update:model-value="(v) => pickDates([modelValue.from, v])"
      />
    </template>
    <el-date-picker
      v-else-if="modelValue?.preset === 'custom'"
      :model-value="dates"
      type="daterange"
      value-format="YYYY-MM-DD"
      format="DD/MM/YYYY"
      unlink-panels
      :clearable="false"
      :disabled-date="disabledDate"
      :start-placeholder="t('dashboards.rangeFrom')"
      :end-placeholder="t('dashboards.rangeTo')"
      class="range-dates"
      @update:model-value="pickDates"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Calendar } from '@element-plus/icons-vue';
import { RANGE_PRESETS, MAX_RANGE_DAYS } from '@/utils/dashboards';
import { useBreakpoints } from '@/composables/useBreakpoints';

/**
 * Time range of a report: last 7 or 30 days, 3, 6 or 12 months, or chosen dates.
 * v-model: { preset, from?, to? } with day keys (YYYY-MM-DD).
 */
const props = defineProps({
  modelValue: { type: Object, default: () => ({ preset: '7d' }) },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();
const { isMobile } = useBreakpoints();

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dates = computed(() => (props.modelValue?.from && props.modelValue?.to ? [props.modelValue.from, props.modelValue.to] : []));
const disabledDate = (date) => date.getTime() > Date.now();

const pickPreset = (preset) => {
  if (preset !== 'custom') {
    emit('update:modelValue', { preset });
    return;
  }
  // Start from the last 30 days, then let the person adjust
  emit('update:modelValue', { preset, from: dayKey(Date.now() - 29 * DAY_MS), to: dayKey(Date.now()) });
};

const pickDates = (value) => {
  if (!value?.[0] || !value?.[1]) return;
  // Picked separately on phones: keep from before to
  const [from, to] = value[0] <= value[1] ? value : [value[1], value[0]];
  const span = Math.round((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / DAY_MS) + 1;
  if (span > MAX_RANGE_DAYS) {
    ElMessage.warning(t('dashboards.rangeTooLong', { days: MAX_RANGE_DAYS }));
    return;
  }
  emit('update:modelValue', { preset: 'custom', from, to });
};
</script>

<style scoped>
.range-select {
  width: 170px;
}
.range-day {
  width: 140px;
}
.range-dates {
  max-width: 280px;
}
</style>
