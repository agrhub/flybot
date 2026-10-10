<template>
  <aside
    class="bg-[var(--el-bg-color)] border-r border-[var(--el-border-color)] flex flex-col relative z-20 shrink-0 h-screen justify-between transition-all duration-300 ease-in-out select-none"
    :class="isCollapsed ? 'w-[76px]' : 'w-[260px] lg:w-[280px]'"
  >
    <div>
      <!-- Logo & Studio Tag & Collapse Toggle -->
      <div class="pt-7 pb-6" :class="isCollapsed ? 'px-3 flex flex-col items-center' : 'px-6'">
        <!-- Top Tag & Collapse Button (Expanded) -->
        <div v-if="!isCollapsed" class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-bold tracking-[0.25em] uppercase text-[var(--el-text-color-secondary)]">
              {{ t('common.studioTag') }}
            </span>
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--primary-green)] ring-4 ring-[var(--primary-green)]/20"></span>
          </div>

          <!-- Collapse toggle button -->
          <button
            @click="toggleCollapse"
            class="w-8 h-8 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] flex items-center justify-center text-[var(--el-text-color-secondary)] hover:text-[var(--primary-green)] transition-all cursor-pointer shadow-sm"
            :title="t('common.collapse')"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" />
            </svg>
          </button>
        </div>

        <!-- Expanded Brand Name -->
        <div v-if="!isCollapsed" class="flex items-center gap-3">
          <img
            src="/logo.png"
            alt="FlyBot Logo"
            class="w-9 h-9 rounded-xl object-contain shadow-md shadow-emerald-500/20"
          />
          <div>
            <h1 class="text-2xl font-black tracking-tight text-[var(--el-text-color-primary)]">
              {{ t('common.brandName') }}<span class="text-[var(--primary-green)]">.</span>
            </h1>
          </div>
        </div>

        <!-- Collapsed Header -->
        <div v-else class="flex flex-col items-center gap-4">
          <button
            @click="toggleCollapse"
            class="w-9 h-9 rounded-xl bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] flex items-center justify-center text-[var(--el-text-color-secondary)] hover:text-[var(--primary-green)] transition-all cursor-pointer shadow-sm"
            :title="t('common.expand')"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <img
            src="/logo.png"
            alt="FlyBot Logo"
            class="w-10 h-10 rounded-2xl object-contain shadow-md shadow-emerald-500/20"
            :title="t('common.brandName')"
          />
        </div>
      </div>

      <!-- Navigation items -->
      <nav :class="isCollapsed ? 'px-2 space-y-2' : 'px-4 space-y-1.5'">
        <template v-for="item in navItems" :key="item.id">
          <!-- Collapsed Mode with Tooltip -->
          <el-tooltip
            v-if="isCollapsed"
            :content="item.label"
            placement="right"
            :show-after="100"
          >
            <button
              @click="handleSelect(item.id)"
              class="flex items-center justify-center w-12 h-12 mx-auto rounded-2xl transition-all relative font-medium cursor-pointer"
              :class="activeSection === item.id
                ? 'bg-[var(--el-card-bg-color)] shadow-sm border border-[var(--el-border-color)] text-[var(--primary-green)]'
                : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)]/60 hover:text-[var(--el-text-color-primary)]'"
            >
              <span
                v-if="activeSection === item.id"
                class="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-[var(--primary-green)] rounded-r-full"
              ></span>
              <component :is="item.icon" class="w-5 h-5" />
            </button>
          </el-tooltip>

          <!-- Expanded Mode -->
          <button
            v-else
            @click="handleSelect(item.id)"
            class="w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl transition-all relative font-semibold text-sm cursor-pointer text-left"
            :class="activeSection === item.id
              ? 'bg-[var(--el-card-bg-color)] shadow-sm border border-[var(--el-border-color)] text-[var(--el-text-color-primary)]'
              : 'text-[var(--el-text-color-secondary)] hover:bg-[var(--el-card-bg-color)]/60 hover:text-[var(--el-text-color-primary)]'"
          >
            <span
              v-if="activeSection === item.id"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-6 bg-[var(--primary-green)] rounded-r-full"
            ></span>
            <component
              :is="item.icon"
              class="w-5 h-5 shrink-0"
              :class="activeSection === item.id ? 'text-[var(--primary-green)]' : 'text-[var(--el-text-color-secondary)]'"
            />
            <span class="truncate">{{ item.label }}</span>
          </button>
        </template>
      </nav>
    </div>

    <!-- Footer: Add Camera Button -->
    <div :class="isCollapsed ? 'p-3 flex justify-center' : 'p-5'">
      <!-- Collapsed Add Camera Button -->
      <el-tooltip
        v-if="isCollapsed"
        :content="t('cameras.addCameraBtn')"
        placement="right"
        :show-after="100"
      >
        <button
          @click="emit('open-add-camera')"
          class="w-12 h-12 rounded-2xl bg-[var(--primary-green)] hover:bg-emerald-400 text-slate-950 flex items-center justify-center shadow-lg shadow-emerald-500/25 transition-transform active:scale-95 cursor-pointer font-bold"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </el-tooltip>

      <!-- Expanded Add Camera Button -->
      <button
        v-else
        @click="emit('open-add-camera')"
        class="w-full h-12 rounded-2xl bg-[var(--primary-green)] hover:bg-emerald-400 text-slate-950 font-bold text-sm flex items-center justify-between px-5 shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] cursor-pointer"
      >
        <span>{{ t('cameras.addCameraBtn') }}</span>
        <svg class="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3" />
        </svg>
      </button>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, h } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  activeSection: {
    type: String,
    default: 'dashboard'
  }
});

const emit = defineEmits(['navigate', 'open-add-camera']);

const { t } = useI18n();
const isCollapsed = ref(localStorage.getItem('smart_trap_sidebar_collapsed') === 'true');

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
  localStorage.setItem('smart_trap_sidebar_collapsed', String(isCollapsed.value));
};

const handleSelect = (sectionId) => {
  emit('navigate', sectionId);
};

// SVG Icon Components
const DashboardIcon = {
  render() {
    return h('svg', { fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
      h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: '2', d: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' })
    ]);
  }
};

const CameraIcon = {
  render() {
    return h('svg', { fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
      h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: '2', d: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' })
    ]);
  }
};

const AnalyticsIcon = {
  render() {
    return h('svg', { fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
      h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: '2', d: 'M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z' })
    ]);
  }
};

const MapIcon = {
  render() {
    return h('svg', { fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
      h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: '2', d: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7' })
    ]);
  }
};

const SettingsIcon = {
  render() {
    return h('svg', { fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
      h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: '2', d: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z' }),
      h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: '2', d: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z' })
    ]);
  }
};

const navItems = computed(() => [
  { id: 'dashboard', label: t('nav.dashboard'), icon: DashboardIcon },
  { id: 'cameras', label: t('nav.cameras'), icon: CameraIcon },
  { id: 'analytics', label: t('nav.analytics'), icon: AnalyticsIcon },
  { id: 'map', label: t('nav.map'), icon: MapIcon },
  { id: 'settings', label: t('nav.settings'), icon: SettingsIcon },
]);
</script>
