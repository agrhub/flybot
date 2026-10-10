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
import { computed, onMounted } from 'vue';
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
});
</script>

<style scoped>
#app-layout {
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}
</style>
