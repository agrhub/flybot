<template>
  <div id="app-layout" class="bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] font-sans antialiased h-screen w-screen flex overflow-hidden select-none">
    <!-- Left Sidebar: tablet (icons) and desktop; phones use the bottom tab bar -->
    <AppSidebar
      v-if="!isMobile"
      :active-section="currentSection"
      @navigate="handleNavigate"
      @open-add-camera="openAddCameraModal"
    />

    <!-- Center Main Workspace Area -->
    <div class="flex-1 flex flex-col h-[100dvh] overflow-hidden relative min-w-0">
      <!-- Topbar Header -->
      <Topbar
        :current-section="currentSection"
        @navigate="handleNavigate"
        @open-settings-tab="handleOpenSettingsTab"
      />

      <!-- No signal: what is on screen is the last copy saved on this device -->
      <el-alert
        v-if="offline"
        type="info"
        :closable="false"
        show-icon
        class="verify-banner shrink-0"
        :title="savedAt ? t('offline.savedCopy', { time: formatSavedAt(savedAt) }) : t('offline.noSignal')"
      />

      <!-- Field work recorded without signal, waiting to be sent -->
      <el-alert
        v-if="outboxItems.length"
        :type="outboxFailed.length ? 'warning' : 'info'"
        :closable="false"
        show-icon
        class="verify-banner shrink-0"
      >
        <template #title>
          <span class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{{ t('outbox.waiting', { count: outboxPending.length }, outboxPending.length) }}</span>
            <el-button v-if="outboxPending.length" link type="primary" size="small" :loading="outboxSending" @click="sendOutbox">{{ t('outbox.sendNow') }}</el-button>
          </span>
        </template>
        <div v-for="item in outboxFailed" :key="item.id" class="flex flex-wrap items-center gap-x-2 text-xs mt-1">
          <span>{{ t('outbox.refused', { label: item.label, reason: item.error }) }}</span>
          <el-button link type="danger" size="small" @click="removeOutboxItem(item.id)">{{ t('outbox.remove') }}</el-button>
        </div>
      </el-alert>

      <!-- The shared guest account: read-only, and when its session ends -->
      <el-alert
        v-if="user && user.guest"
        type="info"
        :closable="false"
        show-icon
        class="verify-banner shrink-0"
        :title="user.guestUntil ? t('guest.banner', { time: new Date(user.guestUntil).toLocaleTimeString(locale === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' }) }) : t('guest.bannerNoTime')"
        data-test="guest-banner"
      />

      <!-- Simulated demo data in view (scripts/demo_sim.js): always said, never passed off as field data -->
      <el-alert
        v-if="user && user.simulatedData"
        type="warning"
        :closable="false"
        show-icon
        class="verify-banner shrink-0"
        :title="t('simulated.bannerTitle')"
        :description="t('simulated.bannerDesc')"
        data-test="simulated-banner"
      />

      <!-- Email confirmation reminder (alert emails need a confirmed address) -->
      <el-alert
        v-if="user && user.emailVerified === false"
        type="warning"
        :closable="false"
        show-icon
        class="verify-banner shrink-0"
      >
        <template #title>
          <span class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{{ t('auth.verifyBanner', { email: user.email }) }}</span>
            <el-button
              link
              type="warning"
              :disabled="resending"
              :loading="resending"
              @click="resendVerification"
            >
              {{ t('auth.resendVerification') }}
            </el-button>
          </span>
        </template>
      </el-alert>

      <!-- Scrollable Main Content Router View -->
      <main class="flex-1 overflow-y-auto p-3 sm:p-6 lg:p-8 custom-scrollbar">
        <router-view />
      </main>

      <!-- Phones: native-style bottom navigation -->
      <MobileTabBar
        v-if="isMobile"
        :active-section="currentSection"
        @navigate="handleNavigate"
        @open-add-camera="openAddCameraModal"
      />
    </div>

    <!-- Right Sidebar AI Assistant Copilot -->
    <AiAssistantSidebar
      :active-context="currentSection"
      :cameras="cameras"
      :selected-camera="selectedCamera"
      @navigate="handleNavigate"
      @select-camera="selectCamera"
    />

    <!-- Global Add Camera Modal Dialog -->
    <AddCameraModal />

    <!-- Plan limit reached / "Ask for an upgrade" (composables/useUpgrade.js) -->
    <UpgradeDialog />

    <!-- Guided tour: first visit, or "Quick tour" in the profile menu -->
    <AppTour />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { useRouter, useRoute } from 'vue-router';
import { useTheme } from '@/utils/theme';
import { useCameras } from '@/composables/useCameras';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { useNotifications } from '@/composables/useNotifications';
import { useOffline } from '@/composables/useOffline';
import { useOutbox } from '@/composables/useOutbox';

import AppSidebar from '@/components/layout/AppSidebar.vue';
import MobileTabBar from '@/components/layout/MobileTabBar.vue';
import Topbar from '@/components/layout/Topbar.vue';
import AiAssistantSidebar from '@/components/assistant/AiAssistantSidebar.vue';
import AddCameraModal from '@/components/modals/AddCameraModal.vue';
import UpgradeDialog from '@/components/plans/UpgradeDialog.vue';
import AppTour from '@/components/layout/AppTour.vue';
import { useAppTour } from '@/composables/useAppTour';

const router = useRouter();
const route = useRoute();
const { initTheme } = useTheme();
const { t, locale } = useI18n();
const { user, refreshUser } = useAuth();
const { offline, savedAt } = useOffline();
const { items: outboxItems, pending: outboxPending, failed: outboxFailed, sending: outboxSending, flush: flushOutbox, removeItem: removeOutboxItem, reload: reloadOutbox } = useOutbox();
const sendOutbox = async () => {
  const sent = await flushOutbox();
  if (sent) ElNotification({ title: t('common.success'), message: t('outbox.sent', { count: sent }, sent), type: 'success', duration: 3000 });
};
const formatSavedAt = (iso) => new Date(iso).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const resending = ref(false);

const resendVerification = async () => {
  resending.value = true;
  try {
    const res = await api.resendVerification();
    if (res.data?.alreadyVerified) {
      refreshUser();
      return;
    }
    ElNotification({ title: t('common.success'), message: t('auth.verificationSent'), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    resending.value = false;
  }
};
const { cameras, selectedCamera, loadCameras, selectCamera, openAddCameraModal } = useCameras();
const { isMobile } = useBreakpoints();

const currentSection = computed(() => {
  const path = route.path;
  if (path.startsWith('/cameras')) return 'cameras';
  if (path.startsWith('/reports')) return 'reports';
  if (path.startsWith('/logbook')) return 'logbook';
  if (path.startsWith('/farms')) return 'farms';
  if (path.startsWith('/analytics')) return 'analytics';
  if (path.startsWith('/map')) return 'map';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/sentinel')) return 'sentinel';
  return 'dashboard';
});

// A section name, or { tab, subTab } from the assistant (sub-tab: the page's ?tab=)
const handleNavigate = (target) => {
  const { tab, subTab } = typeof target === 'string' ? { tab: target } : (target || {});
  if (!tab) return;
  const targetPath = '/' + tab;
  if (subTab) {
    router.push({ path: targetPath, query: { tab: subTab } });
  } else if (route.path !== targetPath) {
    router.push(targetPath);
  }
};

const handleOpenSettingsTab = (tab) => {
  router.push({ path: '/settings', query: { tab } });
};

// A camera shared with you shows up without a reload
const stopListening = useNotifications().onNotification((n) => {
  if (n.type === 'camera_shared') loadCameras();
});
onUnmounted(stopListening);

onMounted(() => {
  // The person may have changed since the module loaded (sign in): their own queue, then send it
  reloadOutbox();
  sendOutbox();
  setTimeout(() => useAppTour().startIfNew(), 1500);
  const user = localStorage.getItem('user');
  if (!user) {
    router.push('/auth/login');
    return;
  }
  initTheme();
  loadCameras();
  refreshUser();
});
</script>

<style scoped>
#app-layout {
  /* dvh: the visible height on phones, without the browser's address bar */
  height: 100vh;
  height: 100dvh;
  width: 100vw;
  overflow: hidden;
}

.verify-banner {
  border-radius: 0;
  padding-left: 24px;
  padding-right: 24px;
}
</style>
