<template>
  <!-- Phone navigation: native-style bottom tab bar -->
  <nav class="tabbar shrink-0 select-none" :aria-label="t('nav.mainNavigation')">
    <button
      v-for="item in tabs"
      :key="item.id"
      type="button"
      class="tabbar__item"
      :data-tour="`nav-${item.id}`"
      :class="{ 'is-active': isActive(item.id) }"
      :aria-current="isActive(item.id) ? 'page' : undefined"
      @click="item.id === 'more' ? (moreOpen = true) : emit('navigate', item.id)"
    >
      <el-icon :size="22"><component :is="item.icon" /></el-icon>
      <span class="tabbar__label">{{ item.label }}</span>
    </button>
  </nav>

  <!-- "More": bottom sheet with the remaining sections and quick settings -->
  <el-drawer
    v-model="moreOpen"
    direction="btt"
    size="auto"
    :with-header="false"
    class="tabbar-sheet"
    body-class="tabbar-sheet__body"
  >
    <div class="tabbar-sheet__handle"></div>
    <el-menu class="tabbar-sheet__menu" :default-active="activeSection" @select="selectMore">
      <el-menu-item index="reports">
        <el-icon><Document /></el-icon>
        <span>{{ t('nav.reports') }}</span>
      </el-menu-item>
      <el-menu-item index="farms">
        <el-icon><Place /></el-icon>
        <span>{{ t('nav.farms') }}</span>
      </el-menu-item>
      <el-menu-item index="logbook">
        <el-icon><Notebook /></el-icon>
        <span>{{ t('nav.logbook') }}</span>
      </el-menu-item>
      <el-menu-item index="settings">
        <el-icon><Setting /></el-icon>
        <span>{{ t('nav.settings') }}</span>
      </el-menu-item>
      <el-menu-item v-if="canManageCameras" index="add-camera">
        <el-icon><Plus /></el-icon>
        <span>{{ t('cameras.addCameraBtn') }}</span>
      </el-menu-item>
      <el-menu-item index="manual">
        <el-icon><Reading /></el-icon>
        <span>{{ t('nav.manual') }}</span>
      </el-menu-item>
    </el-menu>
    <el-divider class="!my-2" />
    <div class="flex items-center justify-between gap-3 px-5 pb-2">
      <span class="tabbar-sheet__label">{{ t('topbar.appearance') }}</span>
      <div class="flex items-center gap-2">
        <LanguageSelect />
        <el-button circle :icon="isDark ? Sunny : Moon" :title="isDark ? t('topbar.lightMode') : t('topbar.darkMode')" @click="toggleTheme" />
      </div>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  Odometer, VideoCamera, DataAnalysis, MapLocation, MoreFilled, Document, Notebook, Place, Setting, Plus, Reading, Sunny, Moon,
} from '@element-plus/icons-vue';
import { useAuth } from '@/composables/useAuth';
import { useTheme } from '@/utils/theme';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';

const props = defineProps({
  activeSection: { type: String, default: 'dashboard' },
});
const emit = defineEmits(['navigate', 'open-add-camera']);

const { t } = useI18n();
const router = useRouter();
const { canManageCameras } = useAuth();
const { isDark, toggleTheme } = useTheme();
const moreOpen = ref(false);

// Sections reached through "More" light up that tab
const MORE_SECTIONS = ['reports', 'farms', 'logbook', 'settings'];
const isActive = (id) => (id === 'more' ? MORE_SECTIONS.includes(props.activeSection) : props.activeSection === id);

const tabs = computed(() => [
  { id: 'dashboard', label: t('nav.overviewShort'), icon: Odometer },
  { id: 'cameras', label: t('nav.cameras'), icon: VideoCamera },
  { id: 'analytics', label: t('nav.analytics'), icon: DataAnalysis },
  { id: 'map', label: t('nav.map'), icon: MapLocation },
  { id: 'more', label: t('nav.more'), icon: MoreFilled },
]);

const selectMore = (index) => {
  moreOpen.value = false;
  if (index === 'add-camera') emit('open-add-camera');
  else if (index === 'manual') router.push('/manual');
  else emit('navigate', index);
};
</script>

<style scoped>
.tabbar {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  background-color: var(--el-bg-color-overlay);
  border-top: 1px solid var(--el-border-color);
  /* iPhone home indicator */
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.tabbar__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 56px;
  padding: 6px 2px;
  background: none;
  border: 0;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.tabbar__item.is-active {
  color: var(--el-color-primary);
}
.tabbar__item:active {
  background-color: var(--el-fill-color-light);
}
.tabbar__label {
  font-size: 11px;
  line-height: 1.2;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tabbar__item.is-active .tabbar__label {
  font-weight: 600;
}
:deep(.tabbar-sheet__body) {
  padding: 8px 0 calc(12px + env(safe-area-inset-bottom, 0px));
}
.tabbar-sheet__handle {
  width: 40px;
  height: 4px;
  margin: 0 auto 8px;
  border-radius: 2px;
  background-color: var(--el-border-color);
}
.tabbar-sheet__menu {
  border-right: none;
  --el-menu-item-height: 52px;
}
.tabbar-sheet__label {
  font-size: 14px;
  color: var(--el-text-color-regular);
}
</style>
