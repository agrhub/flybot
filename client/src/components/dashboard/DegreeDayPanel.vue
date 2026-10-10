<template>
  <div class="dd-panel">
    <div class="flex items-center justify-between gap-3 mb-2">
      <h4 class="dd-title flex items-center gap-2">
        <el-icon class="is-primary"><Calendar /></el-icon>
        <span>{{ t('degreeDays.title') }}</span>
      </h4>
      <el-tooltip :content="t('degreeDays.modelNote', { base: model?.model.baseTemp ?? 12, dd: model?.model.generationDd ?? 350 })" placement="top">
        <el-icon class="dd-help"><QuestionFilled /></el-icon>
      </el-tooltip>
    </div>

    <p v-if="!model" class="dd-meta">{{ t('degreeDays.unavailable') }}</p>

    <template v-else>
      <!-- Headline: when the next adults are expected -->
      <div v-if="model.nextWave" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span class="dd-headline">{{ waveHeadline }}</span>
        <span class="dd-meta font-mono">{{ formatDay(model.nextWave.date) }}</span>
        <el-tag v-if="model.nextWave.generation > 1" size="small" effect="light" round>{{ t('degreeDays.generation', { n: model.nextWave.generation }) }}</el-tag>
        <el-tag v-if="model.nextWave.estimated" size="small" type="info" effect="light" round>{{ t('degreeDays.estimated') }}</el-tag>
      </div>
      <p v-else class="dd-meta">{{ t('degreeDays.noPeak') }}</p>

      <div v-if="model.progressPct !== null" class="mt-3">
        <el-progress :percentage="model.progressPct" :stroke-width="10" :status="model.progressPct >= 90 ? 'warning' : ''" />
        <p class="dd-meta mt-1">
          {{ t('degreeDays.progress', { acc: model.accumulated, total: model.model.generationDd }) }}
          · {{ t('degreeDays.fromPeak', { day: formatDay(model.anchor.day), count: model.anchor.catches }) }}
        </p>
      </div>

      <p class="dd-meta mt-2">
        <template v-if="model.generationDays">{{ t('degreeDays.pace', { days: model.generationDays, dd: model.avgDailyDd }) }}</template>
        <template v-else>{{ t('degreeDays.tooCold') }}</template>
      </p>

      <!-- Daily degree-days: past two weeks, then the forecast -->
      <div class="dd-bars mt-3" role="img" :aria-label="t('degreeDays.chartLabel')">
        <el-tooltip
          v-for="d in model.days"
          :key="d.day"
          :content="t('degreeDays.dayTip', { day: formatDay(d.day), dd: d.dd, min: d.min, max: d.max })"
          placement="top"
        >
          <div class="dd-bar-slot">
            <div
              class="dd-bar"
              :class="{ 'is-forecast': d.forecast, 'is-wave': d.day === model.nextWave?.date }"
              :style="{ height: `${Math.max(4, (d.dd / maxDd) * 100)}%` }"
            />
          </div>
        </el-tooltip>
      </div>
      <div class="flex justify-between dd-meta mt-1">
        <span>{{ t('degreeDays.past') }}</span>
        <span>{{ t('degreeDays.forecast') }}</span>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Calendar, QuestionFilled } from '@element-plus/icons-vue';

const props = defineProps({
  model: { type: Object, default: null }
});

const { t } = useI18n();

const formatDay = (key) => (key ? `${key.slice(8, 10)}/${key.slice(5, 7)}` : '');
const maxDd = computed(() => Math.max(1, ...(props.model?.days || []).map(d => d.dd)));

const waveHeadline = computed(() => {
  const days = props.model?.nextWave?.inDays;
  if (days === undefined || days === null) return '';
  if (days <= 0) return t('degreeDays.waveNow');
  return t('degreeDays.waveIn', { days }, days);
});
</script>

<style scoped>
.dd-panel {
  padding: 16px;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
.dd-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.dd-headline {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.dd-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.dd-help {
  color: var(--el-text-color-secondary);
  cursor: help;
}
.dd-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 56px;
}
.dd-bar-slot {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.dd-bar {
  width: 100%;
  border-radius: 2px 2px 0 0;
  background-color: var(--el-color-primary);
}
.dd-bar.is-forecast {
  background-color: var(--el-color-primary-light-5);
}
.dd-bar.is-wave {
  background-color: var(--el-color-warning);
}
.is-primary { color: var(--el-color-primary); }
</style>
