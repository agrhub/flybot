<template>
  <!-- Latest AI photos -->
  <div v-if="card.type === 'photos'" class="card-block">
    <div class="photo-grid" :class="{ 'photo-grid--single': card.items.length === 1 }">
      <div v-for="(item, i) in card.items" :key="item.id" class="photo-item">
        <el-image
          :src="api.getImageUrl(item.imageKey)"
          :preview-src-list="previewList"
          :initial-index="i"
          fit="cover"
          preview-teleported
          class="photo-image"
          :alt="item.name"
        />
        <div class="photo-caption">
          <span class="truncate">{{ item.name }}</span>
          <span v-if="item.count !== null && item.count !== undefined" class="photo-count">{{ t('assistant.cards.count', { n: item.count }) }}</span>
        </div>
        <div class="card-meta">{{ formatTime(item.at) }}</div>
      </div>
    </div>
  </div>

  <!-- Catches over time -->
  <div v-else-if="card.type === 'chart'" class="card-block">
    <div class="card-title">{{ t(`assistant.cards.chart.${card.mode}`) }}</div>
    <CatchBarChart
      :labels="card.labels"
      :series="chartSeries"
      :height="170"
      :empty-text="t('assistant.cards.noData')"
    />
  </div>

  <!-- Two periods side by side -->
  <div v-else-if="card.type === 'compare'" class="card-block">
    <div class="card-title">{{ t('assistant.cards.compare', { days: card.days }) }}</div>
    <div class="compare-grid">
      <div v-for="side in ['current', 'previous']" :key="side" class="compare-side">
        <span class="card-meta">{{ t(`assistant.cards.${side}`) }} · {{ dayRange(card[side]) }}</span>
        <span class="compare-value">{{ card[side].caught ?? '--' }}</span>
        <span class="card-meta">{{ t('assistant.cards.ftd', { n: card[side].ftd ?? '--' }) }}</span>
      </div>
    </div>
    <el-tag v-if="card.changePct !== null && card.changePct !== undefined" :type="card.changePct > 0 ? 'danger' : 'success'" size="small" effect="light" class="mt-2">
      {{ t(card.changePct > 0 ? 'assistant.cards.up' : 'assistant.cards.down', { pct: Math.abs(card.changePct) }) }}
    </el-tag>
  </div>

  <!-- A change the assistant proposed: recorded only on Confirm -->
  <div v-else-if="card.type === 'confirm'" class="card-block card-block--confirm">
    <div class="card-title">{{ te(`assistant.cards.confirm.${card.action}`) ? t(`assistant.cards.confirm.${card.action}`) : card.action }}</div>
    <!-- Proposed by FlyBot Sentinel: why, and the pictures it relies on -->
    <div v-if="card.source === 'sentinel'" class="confirm-lines mb-2">
      <div class="card-meta">{{ t('assistant.cards.confirm.sentinel.source') }}</div>
      <div v-if="card.reason"><span class="card-meta">{{ t('assistant.cards.confirm.sentinel.reason') }}</span> {{ card.reason }}</div>
      <div v-if="card.evidence && card.evidence.length" class="photo-grid" :class="{ 'photo-grid--single': card.evidence.length === 1 }">
        <div v-for="(item, i) in card.evidence" :key="i" class="photo-item">
          <el-image
            :src="item.url"
            :preview-src-list="evidenceList"
            :initial-index="i"
            fit="cover"
            preview-teleported
            class="photo-image"
            :alt="item.caption || t('assistant.cards.confirm.sentinel.evidence')"
          />
          <div v-if="item.caption" class="card-meta">{{ item.caption }}</div>
        </div>
      </div>
      <div v-if="card.expiresAt && isOpen" class="card-meta">{{ t('assistant.cards.confirm.sentinel.expires', { time: formatTime(card.expiresAt) }) }}</div>
    </div>
    <div v-if="card.action === 'card_change'" class="confirm-lines">
      <div><span class="card-meta">{{ t('assistant.cards.confirm.trap') }}</span> {{ card.summary.trap }}</div>
      <div><span class="card-meta">{{ t('assistant.cards.confirm.when') }}</span> {{ formatTime(card.summary.at) }}</div>
    </div>
    <div v-else-if="card.action === 'treatment'" class="confirm-lines">
      <div><span class="card-meta">{{ t('assistant.cards.confirm.kind') }}</span> {{ te(`logbook.types.${card.summary.type}`) ? t(`logbook.types.${card.summary.type}`) : card.summary.type }}</div>
      <div v-if="card.summary.product"><span class="card-meta">{{ t('assistant.cards.confirm.product') }}</span> {{ card.summary.product }}</div>
      <div><span class="card-meta">{{ t('assistant.cards.confirm.when') }}</span> {{ formatTime(card.summary.at) }}</div>
      <div><span class="card-meta">{{ t('assistant.cards.confirm.traps') }}</span> {{ (card.summary.traps || []).join(', ') }}</div>
      <div v-if="card.summary.area"><span class="card-meta">{{ t('assistant.cards.confirm.area') }}</span> {{ card.summary.area }}</div>
      <div v-if="card.summary.preHarvestDays !== null && card.summary.preHarvestDays !== undefined"><span class="card-meta">{{ t('assistant.cards.confirm.preHarvest') }}</span> {{ t('assistant.cards.confirm.days', { count: card.summary.preHarvestDays }) }}</div>
    </div>
    <!-- A camera action (extra photo, interval, image settings, review, notification) -->
    <div v-else class="confirm-lines">
      <div v-if="card.summary?.trap"><span class="card-meta">{{ t('assistant.cards.confirm.trap') }}</span> {{ card.summary.trap }}</div>
      <div v-if="actionParams"><span class="card-meta">{{ t('assistant.cards.confirm.params') }}</span> {{ actionParams }}</div>
    </div>
    <div v-if="isOpen" class="flex items-center gap-2 mt-2">
      <el-button size="small" type="primary" :icon="Check" :loading="busy" @click="emit('decide', 'confirm')">{{ t('assistant.cards.confirm.ok') }}</el-button>
      <el-button size="small" :disabled="busy" @click="emit('decide', 'cancel')">{{ t('assistant.cards.confirm.cancel') }}</el-button>
    </div>
    <el-tag v-else :type="{ done: 'success', cancelled: 'info', failed: 'danger', expired: 'info' }[shownState]" size="small" effect="light" class="mt-2">
      {{ t(`assistant.cards.confirm.state.${shownState}`) }}
    </el-tag>
    <div v-if="card.result" class="card-meta mt-1 is-danger">{{ card.result }}</div>
  </div>

  <!-- One report's key figures -->
  <div v-else-if="card.type === 'report'" class="card-block">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="card-title truncate">{{ card.name }}</div>
        <div class="card-meta">{{ dayRange(card) }}</div>
      </div>
      <el-button size="small" type="primary" plain :icon="Document" @click="openReport">{{ t('assistant.cards.openReport') }}</el-button>
    </div>
    <div class="report-figures">
      <div><span class="card-meta">{{ t('assistant.cards.caught') }}</span><span class="figure">{{ card.caught ?? '--' }}</span></div>
      <div><span class="card-meta">{{ t('assistant.cards.ftdShort') }}</span><span class="figure">{{ card.ftd ?? '--' }}</span></div>
      <div><span class="card-meta">{{ t('assistant.cards.overThreshold') }}</span><span class="figure" :class="{ 'is-danger': card.overThreshold }">{{ card.overThreshold }}</span></div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { Document, Check } from '@element-plus/icons-vue';
import api from '@/services/api';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';

/**
 * A result card under an assistant answer, built on the server from the tools it ran:
 * photos, chart, compare or report.
 */
const props = defineProps({
  card: { type: Object, required: true },
  // A confirm card while its decision is being sent
  busy: { type: Boolean, default: false }
});
const emit = defineEmits(['open', 'decide']);

const { t, te } = useI18n();
const router = useRouter();

const previewList = computed(() => (props.card.items || []).map(item => api.getImageUrl(item.imageKey)));
const evidenceList = computed(() => (props.card.evidence || []).map(item => item.url));
// A camera action's parameters (interval minutes, image settings, message), as "key=value"
const actionParams = computed(() => Object.entries(props.card.summary?.params || {}).map(([k, v]) => `${k}=${v}`).join(', '));
// A pending Sentinel proposal past its expiry shows as expired (the server refuses it too)
const expired = computed(() => !!props.card.expiresAt && new Date(props.card.expiresAt) <= new Date());
const shownState = computed(() => ((props.card.state === 'pending' || !props.card.state) && expired.value ? 'expired' : props.card.state));
const isOpen = computed(() => shownState.value === 'pending' || shownState.value === 'running' || !shownState.value);
const chartSeries = computed(() => (props.card.series || []).map(s => ({ label: s.label || t('assistant.cards.caught'), data: s.data })));

// "11/10 18:05"
const formatTime = (value) => {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const day = (key) => (key ? key.split('-').reverse().slice(0, 2).join('/') : '');
const dayRange = (period) => (period?.from ? `${day(period.from)} – ${day(period.to)}` : '');

const openReport = () => {
  router.push(`/reports/${props.card.id}`);
  emit('open');
};
</script>

<style scoped>
.card-block {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-bg-color);
}
.card-block--confirm {
  border-color: var(--el-color-primary-light-5);
}
.confirm-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 6px;
}
.card-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.photo-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.photo-grid--single {
  grid-template-columns: minmax(0, 1fr);
}
.photo-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.photo-image {
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: var(--el-border-radius-small);
  background-color: var(--el-fill-color-light);
  cursor: zoom-in;
}
.photo-caption {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-primary);
}
.photo-count {
  font-weight: 600;
  white-space: nowrap;
}
.compare-grid,
.report-figures {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.report-figures {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 8px;
}
.compare-side,
.report-figures > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.compare-value,
.figure {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}
.is-danger {
  color: var(--el-color-danger);
}
</style>
