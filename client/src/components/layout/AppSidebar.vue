<template>
  <aside
    class="app-sidebar flex flex-col relative z-20 shrink-0 h-[100dvh] justify-between transition-all duration-300 ease-in-out select-none"
    :class="isCollapsed ? 'w-16' : 'w-[240px] lg:w-[256px]'"
  >
    <div class="min-h-0 flex flex-col">
      <!-- Logo & collapse toggle -->
      <div class="pt-5 pb-4" :class="isCollapsed ? 'px-2 flex flex-col items-center gap-3' : 'px-5'">
        <template v-if="!isCollapsed">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-3 min-w-0">
              <img src="/logo.png" alt="FlyBot Logo" class="w-9 h-9 rounded-lg object-contain shrink-0" />
              <div class="min-w-0">
                <div class="sidebar-brand truncate">{{ t('common.brandName') }}</div>
                <div class="sidebar-tag truncate">{{ t('common.studioTag') }}</div>
              </div>
            </div>
            <el-tooltip :content="t('common.collapse')" placement="right" :show-after="100">
              <el-button text circle :icon="Fold" @click="toggleCollapse" />
            </el-tooltip>
          </div>
        </template>

        <!-- Collapsed header -->
        <template v-else>
          <el-tooltip :content="t('common.expand')" placement="right" :show-after="100">
            <el-button text circle :icon="Expand" @click="toggleCollapse" />
          </el-tooltip>
          <img
            src="/logo.png"
            alt="FlyBot Logo"
            class="w-9 h-9 rounded-lg object-contain"
            :title="t('common.brandName')"
          />
        </template>
      </div>

      <!-- Navigation items -->
      <el-menu
        class="sidebar-menu"
        :default-active="activeSection"
        :collapse="isCollapsed"
        :collapse-transition="false"
        @select="handleSelect"
      >
        <el-menu-item v-for="item in navItems" :key="item.id" :index="item.id" :data-tour="`nav-${item.id}`">
          <el-icon><component :is="item.icon" /></el-icon>
          <template #title>{{ item.label }}</template>
        </el-menu-item>
      </el-menu>
    </div>

    <!-- Footer: Add Camera Button -->
    <div v-if="canManageCameras" :class="isCollapsed ? 'p-3 flex justify-center' : 'p-4'">
      <el-tooltip
        v-if="isCollapsed"
        :content="t('cameras.addCameraBtn')"
        placement="right"
        :show-after="100"
      >
        <el-button type="primary" circle :icon="Plus" data-tour="add-camera" @click="emit('open-add-camera')" />
      </el-tooltip>

      <el-button
        v-else
        type="primary"
        size="large"
        class="w-full"
        :icon="Plus"
        data-tour="add-camera"
        @click="emit('open-add-camera')"
      >
        {{ t('cameras.addCameraBtn') }}
      </el-button>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuth } from '@/composables/useAuth';
import { useBreakpoints } from '@/composables/useBreakpoints';
import {
  Odometer,
  VideoCamera,
  DataAnalysis,
  MapLocation,
  Setting,
  Document,
  Notebook,
  Place,
  Fold,
  Expand,
  Plus
} from '@element-plus/icons-vue';

const props = defineProps({
  activeSection: {
    type: String,
    default: 'dashboard'
  }
});

const emit = defineEmits(['navigate', 'open-add-camera']);

const { t } = useI18n();
const { canManageCameras } = useAuth();
const { isTablet } = useBreakpoints();
// Desktop: remembered choice. Tablet: icons only by default (not remembered)
const desktopCollapsed = ref(localStorage.getItem('smart_trap_sidebar_collapsed') === 'true');
const tabletCollapsed = ref(true);
const isCollapsed = computed(() => (isTablet.value ? tabletCollapsed.value : desktopCollapsed.value));

const toggleCollapse = () => {
  if (isTablet.value) {
    tabletCollapsed.value = !tabletCollapsed.value;
    return;
  }
  desktopCollapsed.value = !desktopCollapsed.value;
  localStorage.setItem('smart_trap_sidebar_collapsed', String(desktopCollapsed.value));
};

const handleSelect = (sectionId) => {
  emit('navigate', sectionId);
};

const navItems = computed(() => [
  { id: 'dashboard', label: t('nav.dashboard'), icon: Odometer },
  { id: 'cameras', label: t('nav.cameras'), icon: VideoCamera },
  { id: 'reports', label: t('nav.reports'), icon: Document },
  { id: 'analytics', label: t('nav.analytics'), icon: DataAnalysis },
  { id: 'farms', label: t('nav.farms'), icon: Place },
  { id: 'logbook', label: t('nav.logbook'), icon: Notebook },
  { id: 'map', label: t('nav.map'), icon: MapLocation },
  { id: 'settings', label: t('nav.settings'), icon: Setting },
]);
</script>

<style scoped>
.app-sidebar {
  background-color: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color);
}

.sidebar-brand {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--el-text-color-primary);
}

.sidebar-tag {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.sidebar-menu {
  --el-menu-bg-color: transparent;
  --el-menu-hover-bg-color: var(--el-fill-color-light);
  --el-menu-item-height: 44px;
  border-right: none;
  padding: 0 8px;
}

.sidebar-menu.el-menu--collapse {
  width: 100%;
  padding: 0 4px;
}

.sidebar-menu :deep(.el-menu-item) {
  border-radius: var(--el-border-radius-base);
  margin-bottom: 4px;
}

.sidebar-menu.el-menu--collapse :deep(.el-menu-item),
.sidebar-menu.el-menu--collapse :deep(.el-menu-tooltip__trigger) {
  padding: 0 !important;
  width: 100%;
  justify-content: center;
}

.sidebar-menu :deep(.el-menu-item.is-active) {
  background-color: var(--el-color-primary-light-9);
  font-weight: 600;
}
</style>
