<template>
  <div class="w-full max-w-7xl mx-auto pb-12">
    <PageHeader :title="t('sentinel.title')" :subtitle="t(`sentinel.pages.${activeTab}`)">
      <template v-if="enabled" #actions>
        <span v-if="state.loadedAt" class="meta-text hidden sm:inline">{{ t('sentinel.common.updated', { time: relative(state.loadedAt, locale) }) }}</span>
        <el-button :icon="Refresh" :loading="state.loading" data-test="sentinel-refresh" @click="refresh">{{ t('common.refresh') }}</el-button>
      </template>
    </PageHeader>

    <!-- Not set up on this server, or not for this account -->
    <el-card v-if="!enabled" shadow="never" data-test="sentinel-disabled">
      <el-result icon="info" :title="t('sentinel.disabled.title')" :sub-title="t('sentinel.disabled.desc')">
        <template #extra>
          <el-button type="primary" @click="router.push('/dashboard')">{{ t('sentinel.disabled.back') }}</el-button>
        </template>
      </el-result>
    </el-card>

    <template v-else>
      <!-- Agent-wide state everyone should see first -->
      <el-alert
        v-if="kill.global"
        type="error"
        :closable="false"
        show-icon
        class="mb-4"
        :title="t('sentinel.status.killGlobal')"
        data-test="kill-banner"
      />
      <el-alert
        v-else-if="kill.cameras.length"
        type="warning"
        :closable="false"
        show-icon
        class="mb-4"
        :title="t('sentinel.status.killCameras', { cameras: kill.cameras.join(', ') })"
      />
      <el-alert
        v-if="state.summaryError && state.summaryError !== 'disabled'"
        type="warning"
        :closable="false"
        show-icon
        class="mb-4"
        :title="t(`sentinel.errors.${state.summaryError}`)"
      />

      <el-tabs :model-value="activeTab" class="sentinel-tabs" @tab-change="openTab">
        <el-tab-pane v-for="tab in TABS" :key="tab.name" :name="tab.name">
          <template #label>
            <span class="inline-flex items-center gap-1.5" :data-test="`sentinel-tab-${tab.name}`">
              <el-icon><component :is="tab.icon" /></el-icon>
              <span>{{ t(`sentinel.tabs.${tab.name}`) }}</span>
              <el-badge v-if="tab.name === 'approvals' && pendingCount" :value="pendingCount" type="warning" class="tab-badge" />
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <router-view v-slot="{ Component }">
        <component :is="Component" :key="`${activeTab}-${reloadKey}`" />
      </router-view>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { Refresh, Odometer, List, Stamp, VideoCamera } from '@element-plus/icons-vue';
import PageHeader from '@/components/common/PageHeader.vue';
import { useSentinel } from '@/composables/useSentinel';
import { relative } from '@/utils/sentinel/time';

/**
 * Sentinel console: the vision agent's traces, proposals and the cameras, read from FlyBot's own
 * database. One page with tabs (overview, traces, approvals, devices); hidden when the server
 * does not have it on (AI_PROVIDER=opencv-lambda or SENTINEL_CONSOLE=true).
 */
const TABS = [
  { name: 'overview', route: 'sentinel', icon: Odometer },
  { name: 'traces', route: 'sentinel-traces', icon: List },
  { name: 'approvals', route: 'sentinel-approvals', icon: Stamp },
  { name: 'devices', route: 'sentinel-devices', icon: VideoCamera },
];

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const { state, enabled, refreshSummary } = useSentinel();

const activeTab = computed(() => TABS.find((tab) => tab.route === route.name)?.name || 'overview');
const openTab = (name) => {
  const tab = TABS.find((x) => x.name === name);
  if (tab && tab.route !== route.name) router.push({ name: tab.route });
};

const kill = computed(() => {
  const ks = state.summary?.kill_switch;
  return { global: !!ks?.global, cameras: ks?.cameras || [] };
});
const pendingCount = computed(() => state.summary?.proposals_pending || 0);

// Refresh: the summary and the open tab
const reloadKey = ref(0);
const refresh = () => {
  refreshSummary();
  reloadKey.value += 1;
};

// The summary (kill switch, pending count) stays fresh while the console is open
let timer = null;
onMounted(() => {
  refreshSummary();
  timer = setInterval(() => refreshSummary(), 30000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(enabled, (on) => {
  if (on && !state.summary) refreshSummary();
});
</script>

<style scoped>
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.sentinel-tabs :deep(.el-tabs__content) {
  display: none;
}
.sentinel-tabs {
  margin-bottom: 16px;
}
.tab-badge :deep(.el-badge__content) {
  position: static;
  transform: none;
}
</style>
