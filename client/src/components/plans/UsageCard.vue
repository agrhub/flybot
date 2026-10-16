<template>
  <el-card shadow="never" class="usage-card" data-test="usage-card">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="usage-card__title truncate">{{ workspace?.name || t('workspace.none') }}</span>
          <el-tag v-if="ent" :type="ent.exempt ? 'success' : 'primary'" effect="dark" round size="small" data-test="usage-plan">{{ ent.exempt ? t('plans.unlimited') : ent.planName }}</el-tag>
          <el-tag v-if="ent?.expired" type="danger" effect="plain" round size="small">{{ t('plans.expired') }}</el-tag>
        </div>
        <div class="flex gap-2">
          <el-button v-if="showPricing" link type="primary" @click="router.push({ name: 'pricing' })">{{ t('plans.seePlans') }}</el-button>
          <el-button v-if="canRequest" type="primary" size="small" data-test="usage-upgrade" @click="openUpgradeDialog({})">{{ t('upgrade.ask') }}</el-button>
        </div>
      </div>
    </template>

    <div v-if="loading" class="py-4"><el-skeleton :rows="3" animated /></div>
    <div v-else-if="ent" class="flex flex-col gap-4">
      <div v-for="row in rows" :key="row.key" class="usage-row">
        <div class="flex items-center justify-between text-sm">
          <span>{{ row.label }}</span>
          <span class="usage-row__value" :data-test="`usage-${row.key}`">{{ row.text }}</span>
        </div>
        <el-progress v-if="row.max" :percentage="Math.min(100, Math.round((row.used / row.max) * 100))" :status="row.used >= row.max ? 'exception' : undefined" :show-text="false" :stroke-width="6" />
      </div>
      <div class="flex flex-wrap gap-2">
        <el-tag v-for="f in features" :key="f.key" :type="f.on ? 'success' : 'info'" effect="plain" round size="small">{{ f.label }}</el-tag>
      </div>
      <p v-if="ent.expiresAt && !ent.exempt" class="usage-muted">{{ t('plans.expiresAt', { date: new Date(ent.expiresAt).toLocaleDateString() }) }}</p>

      <!-- My requests -->
      <div v-if="requests.length" class="flex flex-col gap-2">
        <p class="usage-muted">{{ t('upgrade.myRequests') }}</p>
        <div v-for="r in requests" :key="r.id" class="usage-request flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm">{{ r.type === 'organization' ? (r.organization?.name || t('upgrade.organization')) : r.targetPlan.toUpperCase() }} · {{ new Date(r.createdAt).toLocaleDateString() }}</span>
          <span class="flex items-center gap-2">
            <el-tag size="small" round :type="statusType(r.status)">{{ t(`upgrade.status.${r.status}`) }}</el-tag>
            <el-button v-if="['pending', 'pending_owner'].includes(r.status) && r.requestedBy?.id === user?.id" link size="small" @click="cancel(r)">{{ t('upgrade.cancel') }}</el-button>
            <template v-if="r.status === 'pending_owner' && r.requestedBy?.id !== user?.id">
              <el-button link type="primary" size="small" @click="forward(r, true)">{{ t('upgrade.forward') }}</el-button>
              <el-button link type="danger" size="small" @click="forward(r, false)">{{ t('upgrade.decline') }}</el-button>
            </template>
          </span>
          <p v-if="r.adminNote" class="usage-muted w-full">{{ r.adminNote }}</p>
        </div>
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { openUpgradeDialog, useUpgrade } from '@/composables/useUpgrade';

/** The current workspace's plan and usage ("2/3 cameras", "deep analysis 5/20 this month"). */
const { t } = useI18n();
const router = useRouter();
const { user, capabilities } = useAuth();
const { state } = useUpgrade();

const loading = ref(true);
const ent = ref(null);
const usage = ref(null);
const workspace = ref(null);
const requests = ref([]);

const showPricing = computed(() => capabilities.value.pricing !== false);
const canRequest = computed(() => !ent.value?.exempt && capabilities.value.upgradeRequests !== false);

const limitText = (used, max) => (max === null || max === undefined ? t('plans.usedUnlimited', { used }) : t('plans.usedOf', { used, max }));
const rows = computed(() => {
  if (!ent.value || !usage.value) return [];
  const e = ent.value;
  const u = usage.value;
  return [
    { key: 'cameras', label: t('plans.fields.cameras'), used: u.cameras, max: e.maxCameras, text: limitText(u.cameras, e.maxCameras) },
    { key: 'deep', label: t('plans.fields.deepThisMonth'), used: u.deepAnalyses, max: e.deepAnalysisPerMonth, text: limitText(u.deepAnalyses, e.deepAnalysisPerMonth) },
    { key: 'members', label: t('plans.fields.members'), used: u.members, max: e.maxMembers, text: limitText(u.members, e.maxMembers) },
    { key: 'snapshots', label: t('plans.fields.snapshotsPerDay'), used: 0, max: null, text: e.snapshotsPerDay === null ? t('plans.noLimit') : t('plans.perCameraDay', { n: e.snapshotsPerDay }) },
    { key: 'live', label: t('plans.fields.liveMinutes'), used: 0, max: null, text: e.liveMinutes === null ? t('plans.noLimit') : t('plans.minutes', { n: e.liveMinutes }) },
    { key: 'retention', label: t('plans.fields.retentionDays'), used: 0, max: null, text: e.retentionDays === null ? t('plans.noLimit') : t('plans.days', { n: e.retentionDays }) }
  ];
});
const features = computed(() => ['telegram', 'pdfReports', 'apiAndWebhooks'].map(key => ({ key, on: !!ent.value?.features?.[key], label: t(`plans.features.${key}`) })));
const statusType = (s) => ({ approved: 'success', rejected: 'danger', cancelled: 'info' }[s] || 'warning');

async function load() {
  loading.value = true;
  try {
    const [e, r] = await Promise.all([api.getEntitlements(), api.getUpgradeRequests().catch(() => ({ data: { requests: [] } }))]);
    ent.value = e.data?.entitlements || null;
    usage.value = e.data?.usage || null;
    workspace.value = e.data?.workspace || null;
    requests.value = r.data?.requests || [];
  } catch {
    ent.value = null;
  } finally {
    loading.value = false;
  }
}

async function cancel(r) {
  await api.cancelUpgradeRequest(r.id).catch(() => {});
  load();
}
async function forward(r, yes) {
  await api.forwardUpgradeRequest(r.id, yes).catch(() => {});
  load();
}

onMounted(load);
// A request sent from the dialog shows up here
defineExpose({ reload: load });
watch(() => state.open, (open) => {
  if (!open) load();
});
</script>

<style scoped>
.usage-card__title {
  font-weight: 600;
}
.usage-row__value {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-regular);
}
.usage-muted {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.usage-request {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
</style>
