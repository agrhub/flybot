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

import AppSidebar from '@/components/layout/AppSidebar.vue';
import MobileTabBar from '@/components/layout/MobileTabBar.vue';
import Topbar from '@/components/layout/Topbar.vue';
import AiAssistantSidebar from '@/components/assistant/AiAssistantSidebar.vue';
import AddCameraModal from '@/components/modals/AddCameraModal.vue';
import AppTour from '@/components/layout/AppTour.vue';
import { useAppTour } from '@/composables/useAppTour';

const router = useRouter();
const route = useRoute();
const { initTheme } = useTheme();
const { t, locale } = useI18n();
const { user, refreshUser } = useAuth();
const { offline, savedAt } = useOffline();
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
