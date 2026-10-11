<template>
  <el-popover v-model:visible="open" placement="bottom-end" :width="320" trigger="click">
    <template #reference>
      <span>
        <el-tooltip :content="diverged ? t('filters.ownActive') : t('filters.own')" placement="top">
          <el-badge is-dot :hidden="!diverged" type="primary">
            <el-button :icon="Filter" :type="diverged ? 'primary' : 'default'" :plain="diverged" circle size="small" :aria-label="t('filters.own')" />
          </el-badge>
        </el-tooltip>
      </span>
    </template>

    <div class="widget-filter__title">{{ t('filters.own') }}</div>
    <el-form label-position="top" size="small" class="widget-filter__form">
      <el-form-item v-if="fields.includes('camera')" :label="t('filters.camera')">
        <el-select :teleported="false" :model-value="modelValue.camera || 'all'" filterable class="w-full" @update:model-value="(v) => set('camera', v)">
          <el-option :label="t('analytics.allCameras')" value="all" />
          <el-option v-for="cam in cameraOptions" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="fields.includes('cameras')" :label="t('filters.cameras')">
        <el-select
          :model-value="modelValue.cameras || []"
          multiple
          collapse-tags
          collapse-tags-tooltip
          filterable
          clearable
          :placeholder="t('analytics.allCameras')"
          class="w-full"
          @update:model-value="(v) => set('cameras', v)"
        >
          <el-option v-for="cam in cameraOptions" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="fields.includes('range')" :label="t('filters.dateRange')">
        <DateRangeFilter :model-value="modelValue.range" size="small" :teleported="false" @update:model-value="(v) => set('range', v)" />
      </el-form-item>
      <el-form-item v-if="fields.includes('days')" :label="t('filters.dateRange')">
        <el-segmented :model-value="modelValue.days" :options="dayOptions" size="small" @update:model-value="(v) => set('days', v)" />
      </el-form-item>
      <el-form-item v-if="fields.includes('granularity')" :label="t('filters.granularity')">
        <el-segmented :model-value="modelValue.granularity" :options="granularityOptions" size="small" @update:model-value="(v) => set('granularity', v)" />
      </el-form-item>
      <el-form-item v-if="fields.includes('status')" :label="t('filters.status')">
        <el-select :teleported="false" :model-value="modelValue.status || 'all'" class="w-full" @update:model-value="(v) => set('status', v)">
          <el-option v-for="s in ['all', 'online', 'offline']" :key="s" :label="t(`filters.statuses.${s}`)" :value="s" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="fields.includes('risk')" :label="t('filters.threshold')">
        <el-select :teleported="false" :model-value="modelValue.risk || 'all'" class="w-full" @update:model-value="(v) => set('risk', v)">
          <el-option v-for="r in ['all', 'high', 'moderate', 'low']" :key="r" :label="t(`filters.risks.${r}`)" :value="r" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="fields.includes('trapKind')" :label="t('trapKind.label')">
        <el-select :teleported="false" :model-value="modelValue.trapKind || 'all'" class="w-full" @update:model-value="(v) => set('trapKind', v)">
          <el-option :label="t('filters.allKinds')" value="all" />
          <el-option v-for="k in ['sticky', 'lure']" :key="k" :label="t(`trapKind.${k}.short`)" :value="k" />
        </el-select>
      </el-form-item>
    </el-form>
    <div class="flex items-center justify-between gap-2">
      <el-button link type="primary" :icon="RefreshLeft" :disabled="!diverged" @click="reset">{{ t('filters.useShared') }}</el-button>
      <el-button size="small" @click="open = false">{{ t('common.close') }}</el-button>
    </div>
  </el-popover>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Filter, RefreshLeft } from '@element-plus/icons-vue';
import { useCameras } from '@/composables/useCameras';
import DateRangeFilter from '@/components/common/DateRangeFilter.vue';
import { sameDateRange } from '@/utils/dateRange';

/**
 * A widget's own filters, shown from a filter button in its header. They start from the page
 * filters (`defaults`); a dot on the button shows when this widget no longer follows them.
 * `fields`: camera | cameras | range | days | granularity | status | risk | trapKind
 */
const props = defineProps({
  modelValue: { type: Object, required: true },
  defaults: { type: Object, default: () => ({}) },
  fields: { type: Array, default: () => ['camera', 'range'] },
  dayChoices: { type: Array, default: () => [7, 14, 30] },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();
const { cameras } = useCameras();
const open = ref(false);

const cameraOptions = computed(() => cameras.value.filter(c => c.deviceSerial && c.deviceSerial !== 'all'));
const dayOptions = computed(() => props.dayChoices.map(d => ({ value: d, label: t('analytics.compare.days', { days: d }) })));
const granularityOptions = computed(() => ['hour', 'day', 'month'].map(g => ({ value: g, label: t(`filters.granularities.${g}`) })));

const same = (key, a, b) => {
  if (key === 'range') return sameDateRange(a, b);
  if (Array.isArray(a) || Array.isArray(b)) return (a || []).join(',') === (b || []).join(',');
  return (a ?? 'all') === (b ?? 'all');
};
const diverged = computed(() => props.fields.some(key => key in props.defaults && !same(key, props.modelValue[key], props.defaults[key])));

const set = (key, value) => emit('update:modelValue', { ...props.modelValue, [key]: value });
const reset = () => emit('update:modelValue', { ...props.modelValue, ...JSON.parse(JSON.stringify(props.defaults)) });
</script>

<style scoped>
.widget-filter__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--el-text-color-primary);
}
.widget-filter__form :deep(.el-form-item) {
  margin-bottom: 10px;
}
</style>
