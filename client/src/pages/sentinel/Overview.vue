<template>
  <div class="flex flex-col gap-4 sm:gap-6" data-test="sentinel-overview">
    <!-- Last 24 hours at a glance -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <StatCard
        :label="t('sentinel.overview.photos')"
        :value="summary ? summary.photos ?? 0 : '--'"
        :icon="Picture"
        type="primary"
        :description="sourcesText"
      />
      <StatCard
        :label="t('sentinel.overview.actions')"
        :value="summary ? actionCount : '--'"
        :icon="Operation"
        :description="summary ? t('sentinel.overview.actionsDesc', { count: summary.decisions?.no_op ?? 0 }) : ''"
      />
      <StatCard
        :label="t('sentinel.overview.pending')"
        :value="summary ? summary.proposals_pending ?? 0 : '--'"
        :icon="Stamp"
        :type="summary?.proposals_pending ? 'warning' : 'default'"
        :description="t('sentinel.overview.pendingDesc')"
      />
      <StatCard
        :label="t('sentinel.overview.devices')"
        :value="summary ? `${summary.devices?.online ?? 0}/${summary.devices?.total ?? 0}` : '--'"
        :icon="VideoCamera"
        :type="summary && summary.devices?.online < summary.devices?.total ? 'warning' : 'success'"
        :description="t('sentinel.overview.devicesDesc')"
      />
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
      <!-- Latest traces -->
      <el-card shadow="never" class="lg:col-span-2 min-w-0">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="section-title">{{ t('sentinel.overview.latest') }}</div>
              <div class="section-subtitle">{{ t('sentinel.overview.latestDesc') }}</div>
            </div>
            <el-button link type="primary" @click="router.push({ name: 'sentinel-traces' })">{{ t('sentinel.overview.allTraces') }}</el-button>
          </div>
        </template>
        <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" class="mb-3" />
        <TraceTable :items="traces" :loading="loading" compact />
      </el-card>

      <div class="flex flex-col gap-4 sm:gap-6 min-w-0">
        <!-- Agent state -->
        <el-card shadow="never">
          <template #header>
            <div class="section-title">{{ t('sentinel.overview.agent') }}</div>
          </template>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item :label="t('sentinel.status.killSwitch')">
              <el-tag :type="kill.global ? 'danger' : kill.cameras.length ? 'warning' : 'success'" effect="light" size="small" round data-test="kill-state">
                {{ kill.global ? t('sentinel.status.killOn') : kill.cameras.length ? t('sentinel.status.killSome', { count: kill.cameras.length }) : t('sentinel.status.killOff') }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item :label="t('sentinel.traces.planner')">
              {{ summary?.planner_mode === 'llm' ? t('sentinel.traces.plannerLlm') : t('sentinel.traces.plannerRule') }}
              <el-tag v-if="summary?.planner_latest?.fallback || summary?.planner_fallbacks" type="warning" effect="light" size="small" round class="ml-1">
                {{ t('sentinel.overview.fallbacks', { count: summary.planner_fallbacks || 1 }) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item :label="t('sentinel.overview.lastPhoto')">
              {{ summary?.last_photo_at ? relative(summary.last_photo_at, locale) : '--' }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('sentinel.overview.access')">
              <el-tag :type="canDecide ? 'primary' : 'info'" effect="plain" size="small" round>{{ canDecide ? t('sentinel.overview.canDecide') : t('sentinel.overview.readOnly') }}</el-tag>
            </el-descriptions-item>
          </el-descriptions>

          <div v-if="decisionRows.length" class="mt-4">
            <div class="section-label">{{ t('sentinel.overview.decisions') }}</div>
            <div v-for="row in decisionRows" :key="row.action" class="decision-row">
              <span class="meta-text truncate">{{ actionName(row.action) }}</span>
              <el-progress :percentage="row.pct" :stroke-width="8" :show-text="false" :status="row.action === 'no_op' ? '' : 'warning'" class="flex-1" />
              <span class="count-text">{{ row.count }}</span>
            </div>
          </div>
        </el-card>

        <!-- Waiting for a person -->
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between gap-2">
              <div class="section-title">{{ t('sentinel.overview.waiting') }}</div>
              <el-button link type="primary" @click="router.push({ name: 'sentinel-approvals' })">{{ t('sentinel.overview.allApprovals') }}</el-button>
            </div>
          </template>
          <el-empty v-if="!pending.length" :description="t('sentinel.approvals.noPending')" :image-size="60" />
          <div
            v-for="a in pending"
            :key="a.approval_id"
            class="pending-item"
            role="button"
            tabindex="0"
            @click="openApproval(a)"
            @keydown.enter.prevent="openApproval(a)"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="count-text truncate">{{ kindName(a.kind) }}<template v-if="describeProposal(a).title !== a.kind">: {{ proposalTitle(a) }}</template></span>
              <el-tag type="warning" effect="light" size="small" round>{{ t('sentinel.approvals.status.pending') }}</el-tag>
            </div>
            <div class="meta-text truncate">{{ (a.cameras || []).join(', ') }} · {{ t('sentinel.approvals.expiresAt', { time: relative(a.expires_at, locale) }) }}</div>
          </div>
        </el-card>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { Picture, Operation, Stamp, VideoCamera } from '@element-plus/icons-vue';
import StatCard from '@/components/common/StatCard.vue';
import TraceTable from '@/components/sentinel/TraceTable.vue';
import { useSentinel, sentinelGet, sentinelErrorKind, items } from '@/composables/useSentinel';
import { describeProposal } from '@/utils/sentinel/approvals';
import { relative } from '@/utils/sentinel/time';

const { t, te, locale } = useI18n();
const router = useRouter();
const { state, canDecide } = useSentinel();

const summary = computed(() => state.summary);
const kill = computed(() => ({ global: !!summary.value?.kill_switch?.global, cameras: summary.value?.kill_switch?.cameras || [] }));
const sourcesText = computed(() => {
  const by = summary.value?.photos_by_source || {};
  return Object.entries(by).map(([k, v]) => `${te(`sentinel.devices.source.${k}`) ? t(`sentinel.devices.source.${k}`) : k}: ${v}`).join(' · ');
});
const actionCount = computed(() => Object.entries(summary.value?.decisions || {})
  .filter(([k]) => k !== 'no_op').reduce((n, [, v]) => n + (v || 0), 0));
const decisionRows = computed(() => {
  const entries = Object.entries(summary.value?.decisions || {});
  const total = entries.reduce((n, [, v]) => n + (v || 0), 0) || 1;
  return entries.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([action, count]) => ({ action, count, pct: Math.round((count / total) * 100) }));
});
const actionName = (a) => (te(`sentinel.actions.${a}`) ? t(`sentinel.actions.${a}`) : a);
const kindName = (k) => (te(`sentinel.approvals.kind.${k}`) ? t(`sentinel.approvals.kind.${k}`) : k);
const proposalTitle = (a) => {
  const k = describeProposal(a).title;
  return te(`sentinel.approvals.action.${k}`) ? t(`sentinel.approvals.action.${k}`) : k;
};
const openApproval = (a) => router.push({ name: 'sentinel-approvals', query: { id: a.approval_id } });

const traces = ref([]);
const pending = ref([]);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  try {
    const [tr, ap] = await Promise.all([sentinelGet('traces', { limit: 8 }), sentinelGet('approvals', { status: 'pending', limit: 5 })]);
    traces.value = items(tr);
    pending.value = items(ap);
    error.value = '';
  } catch (err) {
    error.value = t(`sentinel.errors.${sentinelErrorKind(err)}`);
  } finally {
    loading.value = false;
  }
}

let timer = null;
onMounted(() => {
  load();
  timer = setInterval(load, 30000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.section-label {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.count-text {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.decision-row {
  display: grid;
  grid-template-columns: minmax(0, 9rem) 1fr 2rem;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.decision-row .count-text {
  text-align: right;
}
.pending-item {
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  cursor: pointer;
}
.pending-item:hover,
.pending-item:focus-visible {
  border-color: var(--el-color-primary-light-5);
  background-color: var(--el-fill-color-light);
}
</style>
