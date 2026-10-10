<template>
  <div id="app-layout" class="bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] font-sans antialiased h-screen w-screen flex overflow-hidden select-none">
    <!-- Left Sidebar (Collapsible) -->
    <AppSidebar
      :active-section="currentSection"
      @navigate="handleNavigate"
      @open-add-camera="openAddCameraModal"
    />

    <!-- Center Main Workspace Area -->
    <div class="flex-1 flex flex-col h-screen overflow-hidden relative min-w-0">
      <!-- Topbar Header -->
      <Topbar
        :current-section="currentSection"
        @navigate="handleNavigate"
        @open-settings-tab="handleOpenSettingsTab"
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
      <main class="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 custom-scrollbar">
        <router-view />
      </main>
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
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { useRouter, useRoute } from 'vue-router';
import { useTheme } from '@/utils/theme';
import { useCameras } from '@/composables/useCameras';

import AppSidebar from '@/components/layout/AppSidebar.vue';
import Topbar from '@/components/layout/Topbar.vue';
import AiAssistantSidebar from '@/components/assistant/AiAssistantSidebar.vue';
import AddCameraModal from '@/components/modals/AddCameraModal.vue';

const router = useRouter();
const route = useRoute();
const { initTheme } = useTheme();
const { t } = useI18n();
const { user, refreshUser } = useAuth();
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

const currentSection = computed(() => {
  const path = route.path;
  if (path.startsWith('/cameras')) return 'cameras';
  if (path.startsWith('/analytics')) return 'analytics';
  if (path.startsWith('/map')) return 'map';
  if (path.startsWith('/settings')) return 'settings';
  return 'dashboard';
});

const handleNavigate = (section) => {
  const targetPath = '/' + section;
  if (route.path !== targetPath) {
    router.push(targetPath);
  }
};

const handleOpenSettingsTab = (tab) => {
  router.push({ path: '/settings', query: { tab } });
};

onMounted(() => {
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
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

.verify-banner {
  border-radius: 0;
  padding-left: 24px;
  padding-right: 24px;
}
</style>
