<template>
  <div class="trace-list" data-test="trace-list">
  <el-table
    v-if="!isMobile"
    ref="tableRef"
    v-loading="loading && !items.length"
    :element-loading-text="t('common.loading')"
    :data="rows"
    row-key="eventId"
    class="trace-table w-full"
    :expand-row-keys="expandedKeys"
    @row-click="toggle"
    @expand-change="onExpandChange"
  >
    <template #empty>
      <el-empty :description="emptyText || t('sentinel.traces.none')" :image-size="80" />
    </template>

    <!-- Perception → Decision → Action -->
    <el-table-column type="expand" width="36">
      <template #default="{ row }">
        <div class="trace-expand">
          <el-skeleton v-if="detail[row.eventId]?.loading" :rows="5" animated />
          <el-alert v-else-if="detail[row.eventId]?.error" type="error" :closable="false" show-icon :title="detail[row.eventId].error">
            <el-button link type="primary" size="small" @click="loadDetail(row.eventId)">{{ t('sentinel.common.retry') }}</el-button>
          </el-alert>
          <TraceDetail v-else-if="detail[row.eventId]?.trace" :trace="detail[row.eventId].trace" />
        </div>
      </template>
    </el-table-column>

    <el-table-column :label="t('analytics.time')" :min-width="isMobile ? 120 : 140">
      <template #default="{ row }">
        <el-tooltip :content="dateTime(row.createdAt, locale)" placement="top" :show-after="300">
          <span class="meta-text whitespace-nowrap" data-test="trace-time">{{ relative(row.createdAt, locale) }}</span>
        </el-tooltip>
        <div v-if="isMobile" class="count-text truncate">{{ row.camera }}</div>
      </template>
    </el-table-column>

    <el-table-column v-if="!isMobile" :label="t('history.colCamera')" min-width="170">
      <template #default="{ row }">
        <div class="count-text font-mono truncate">{{ row.camera }}</div>
        <div class="flex flex-wrap gap-1 mt-0.5">
          <el-tag v-if="row.source" type="info" effect="plain" size="small" round>{{ sourceName(row.source) }}</el-tag>
          <el-tag v-if="row.trapKind" type="info" effect="plain" size="small" round>{{ trapKindName(row.trapKind) }}</el-tag>
        </div>
      </template>
    </el-table-column>

    <el-table-column v-if="!isMobile && !compact" :label="t('analytics.image')" width="96">
      <template #default="{ row }">
        <el-image v-if="row.image" :src="api.sentinelEvidenceUrl(row.image)" :alt="t('analytics.image')" fit="cover" loading="lazy" class="thumb">
          <template #error><div class="thumb-missing"><el-icon><Picture /></el-icon></div></template>
        </el-image>
        <span v-else class="meta-text">--</span>
      </template>
    </el-table-column>

    <el-table-column :label="compact ? t('sentinel.traces.countsShort') : t('sentinel.traces.counts')" :min-width="compact ? 90 : 130">
      <template #default="{ row }">
        <el-tooltip :content="countsTooltip(row)" placement="top" :show-after="300">
          <span class="whitespace-nowrap">
            <span class="count-text">{{ fmt(row.counts.opencv) }}</span>
            <span v-if="!isMobile" class="meta-text"> · {{ fmt(row.counts.npu) }} · {{ fmt(row.counts.production) }}</span>
          </span>
        </el-tooltip>
      </template>
    </el-table-column>

    <el-table-column :label="t('sentinel.traces.decisionCol')" :min-width="isMobile ? 120 : 170">
      <template #default="{ row }">
        <div class="flex flex-wrap gap-1">
          <el-tag :type="DECISION_TAG[row.type] || 'info'" effect="light" size="small" round data-test="type-pill">{{ t(`sentinel.decision.${row.type}`) }}</el-tag>
          <el-tag v-if="row.approval" :type="STATUS_TAG[row.approval.status] || 'info'" effect="plain" size="small" round>
            {{ t(`sentinel.approvals.status.${row.approval.status}`) }}
          </el-tag>
          <el-tag v-if="row.killSwitch" type="danger" effect="dark" size="small" round>{{ t('sentinel.status.killSwitch') }}</el-tag>
        </div>
      </template>
    </el-table-column>

    <el-table-column v-if="!compact" :label="t('sentinel.traces.quality')" min-width="130">
      <template #default="{ row }">
        <div class="flex flex-wrap gap-1">
          <el-tag v-for="i in row.issues" :key="i" type="danger" effect="light" size="small" round>{{ issueLabel(i) }}</el-tag>
          <el-tag v-if="!row.issues.length" type="success" effect="light" size="small" round>{{ t('sentinel.traces.qualityOk') }}</el-tag>
        </div>
      </template>
    </el-table-column>

    <el-table-column v-if="!isMobile && !compact" :label="t('sentinel.traces.planner')" min-width="120">
      <template #default="{ row }">
        <el-tag v-if="row.planner.fallback" type="warning" effect="light" size="small" round data-test="fallback-pill">{{ t('sentinel.traces.plannerFallbackShort') }}</el-tag>
        <span v-else class="meta-text">{{ row.planner.name === 'llm' ? t('sentinel.traces.plannerLlm') : t('sentinel.traces.plannerRule') }}</span>
      </template>
    </el-table-column>

    <el-table-column :label="t('common.actions')" width="90" align="center">
      <template #default="{ row }">
        <el-tooltip :content="isExpanded(row) ? t('sentinel.common.hideDetails') : t('sentinel.common.showDetails')" placement="top">
          <el-button
            :aria-label="isExpanded(row) ? t('sentinel.common.hideDetails') : t('sentinel.common.showDetails')"
            :aria-expanded="isExpanded(row)"
            :icon="View"
            circle
            size="small"
            data-test="trace-open"
            @click.stop="toggle(row)"
          />
        </el-tooltip>
      </template>
    </el-table-column>
  </el-table>

  <!-- Phones: one card per photo, opening in place -->
  <div v-else v-loading="loading && !items.length" class="trace-cards">
    <el-empty v-if="!loading && !rows.length" :description="emptyText || t('sentinel.traces.none')" :image-size="70" />
    <div v-for="row in rows" :key="row.eventId" class="trace-card" :class="{ 'is-open': isExpanded(row) }" data-test="trace-row">
      <button type="button" class="trace-card__head" :aria-expanded="isExpanded(row)" data-test="trace-open" @click="toggle(row)">
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="count-text truncate font-mono">{{ row.camera }}</span>
            <span class="meta-text whitespace-nowrap">{{ relative(row.createdAt, locale) }}</span>
          </div>
          <div class="flex flex-wrap gap-1 mt-1.5">
            <el-tag :type="DECISION_TAG[row.type] || 'info'" effect="light" size="small" round data-test="type-pill">{{ t(`sentinel.decision.${row.type}`) }}</el-tag>
            <el-tag v-if="row.approval" :type="STATUS_TAG[row.approval.status] || 'info'" effect="plain" size="small" round>{{ t(`sentinel.approvals.status.${row.approval.status}`) }}</el-tag>
            <el-tag v-for="i in row.issues" :key="i" type="danger" effect="light" size="small" round>{{ issueLabel(i) }}</el-tag>
            <el-tag v-if="row.killSwitch" type="danger" effect="dark" size="small" round>{{ t('sentinel.status.killSwitch') }}</el-tag>
          </div>
          <div class="meta-text mt-1.5">{{ countsTooltip(row) }}</div>
        </div>
        <el-image v-if="row.image" :src="api.sentinelEvidenceUrl(row.image)" :alt="t('analytics.image')" fit="cover" loading="lazy" class="thumb shrink-0">
          <template #error><div class="thumb-missing"><el-icon><Picture /></el-icon></div></template>
        </el-image>
      </button>
      <div v-if="isExpanded(row)" class="trace-card__body">
        <el-skeleton v-if="detail[row.eventId]?.loading" :rows="5" animated />
        <el-alert v-else-if="detail[row.eventId]?.error" type="error" :closable="false" show-icon :title="detail[row.eventId].error" />
        <TraceDetail v-else-if="detail[row.eventId]?.trace" :trace="detail[row.eventId].trace" />
      </div>
    </div>
  </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { View, Picture } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { sentinelGet, sentinelErrorKind } from '@/composables/useSentinel';
import TraceDetail from './TraceDetail.vue';
import { summarizeTrace } from '@/utils/sentinel/trace';
import { STATUS_TAG } from '@/utils/sentinel/approvals';
import { relative, dateTime } from '@/utils/sentinel/time';

/**
 * Sentinel traces in FlyBot's detection-history table: one row per photo, newest first; a row opens
 * (click, or the eye button) into Perception → Decision → Action with the evidence pictures.
 */
const props = defineProps({
  items: { type: Array, default: () => [] }, // slim items of GET /ui/traces
  loading: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
  emptyText: { type: String, default: '' },
  // event_id to open on load (links from approvals)
  openId: { type: String, default: '' },
});

const DECISION_TAG = {
  treatment: 'warning', card_change: 'warning', human_review: 'warning',
  isp_fix: 'primary', recapture: 'primary', followup: 'primary',
  kill_switch: 'danger', no_op: 'info',
};

const { t, te, locale } = useI18n();
const { isMobile } = useBreakpoints();
const tableRef = ref(null);

const rows = computed(() => props.items.map((item) => ({ ...summarizeTrace(item), image: item.image || null, raw: item })));
const expanded = ref(props.openId ? [props.openId] : []);
const expandedKeys = computed(() => expanded.value);
const detail = reactive({});

const isExpanded = (row) => expanded.value.includes(row.eventId);

async function loadDetail(id) {
  detail[id] = { loading: true, trace: null, error: '' };
  try {
    const res = await sentinelGet(`traces/${encodeURIComponent(id)}`);
    detail[id] = { loading: false, trace: res?.trace || res, error: '' };
  } catch (err) {
    detail[id] = { loading: false, trace: null, error: t(`sentinel.errors.${sentinelErrorKind(err)}`) };
  }
}

function ensureDetail(id) {
  if (!detail[id] || (!detail[id].trace && !detail[id].loading)) loadDetail(id);
}

function onExpandChange(row, open) {
  const list = Array.isArray(open) ? open.map((r) => r.eventId) : null;
  expanded.value = list || (open ? [...new Set([...expanded.value, row.eventId])] : expanded.value.filter((k) => k !== row.eventId));
  if (expanded.value.includes(row.eventId)) ensureDetail(row.eventId);
}

function toggle(row) {
  if (tableRef.value) {
    tableRef.value.toggleRowExpansion(row);
    return;
  }
  const open = !isExpanded(row);
  expanded.value = open ? [...expanded.value, row.eventId] : expanded.value.filter((k) => k !== row.eventId);
  if (open) ensureDetail(row.eventId);
}

if (props.openId) ensureDetail(props.openId);

const fmt = (v) => (v === null || v === undefined ? '–' : v);
const countsTooltip = (row) => [
  `${t('sentinel.traces.source.opencv')}: ${fmt(row.counts.opencv)}`,
  `${t('sentinel.traces.source.npu')}: ${fmt(row.counts.npu)}`,
  `${t('sentinel.traces.source.production')}: ${fmt(row.counts.production)}`,
].join(' · ');
const issueLabel = (i) => (te(`sentinel.issue.${i}`) ? t(`sentinel.issue.${i}`) : i);
const sourceName = (s) => (te(`sentinel.devices.source.${s}`) ? t(`sentinel.devices.source.${s}`) : s);
const trapKindName = (k) => (te(`sentinel.devices.trapKind.${k}`) ? t(`sentinel.devices.trapKind.${k}`) : k);

defineExpose({ loadDetail });
</script>

<style scoped>
.trace-table :deep(.el-table__row) {
  cursor: pointer;
}
.trace-table :deep(.el-table__expanded-cell) {
  padding: 12px 8px !important;
  background-color: var(--el-fill-color-lighter);
}
.trace-expand {
  min-width: 0;
}
.trace-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 80px;
}
.trace-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-bg-color);
  min-width: 0;
}
.trace-card.is-open {
  border-color: var(--el-color-primary-light-5);
}
.trace-card__head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.trace-card__body {
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 8px 4px;
  background-color: var(--el-fill-color-lighter);
}
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.count-text {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.thumb {
  width: 64px;
  height: 40px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
  background-color: var(--el-fill-color-light);
  display: block;
}
.thumb-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--el-text-color-secondary);
}
</style>
