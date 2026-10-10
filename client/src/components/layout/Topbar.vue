<template>
  <header class="h-16 px-6 lg:px-8 flex items-center justify-between shrink-0 border-b border-[var(--el-border-color)] bg-[var(--el-bg-color-page)]/80 backdrop-blur-md z-10 transition-colors select-none">
    <!-- Left: Context / Title -->
    <div class="flex items-center gap-3">
      <span class="text-xs font-bold uppercase tracking-wider text-[var(--el-text-color-secondary)]">
        {{ currentSectionTitle }}
      </span>
      <span class="w-1.5 h-1.5 rounded-full bg-[var(--primary-green)] animate-pulse"></span>
    </div>

    <!-- Right Controls -->
    <div class="flex items-center gap-3">
      <!-- Language Dropdown -->
      <LanguageSelect />

      <!-- Theme Toggle Button -->
      <button
        @click="toggleTheme"
        class="w-9 h-9 rounded-xl bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] flex items-center justify-center text-[var(--el-text-color-regular)] hover:text-[var(--primary-green)] transition-all shadow-sm cursor-pointer"
        :title="isDark ? t('topbar.lightMode') : t('topbar.darkMode')"
      >
        <!-- Sun icon (when dark, click to go light) -->
        <svg v-if="isDark" class="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
        <!-- Moon icon (when light, click to go dark) -->
        <svg v-else class="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      </button>

      <!-- Notifications Popover -->
      <el-popover
        placement="bottom-end"
        :width="320"
        trigger="click"
        popper-class="!p-0 !rounded-2xl !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] shadow-xl"
      >
        <template #reference>
          <button
            class="relative w-9 h-9 rounded-xl bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] flex items-center justify-center text-[var(--el-text-color-regular)] hover:text-[var(--primary-green)] transition-all shadow-sm cursor-pointer"
            :title="t('topbar.notifications')"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            <!-- Unread badge -->
            <span
              v-if="unreadCount > 0"
              class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-slate-950 text-[10px] font-black flex items-center justify-center ring-2 ring-[var(--el-card-bg-color)]"
            >{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
          </button>
        </template>

        <div class="p-4 border-b border-[var(--el-border-color)] flex items-center justify-between gap-2">
          <span class="text-xs font-bold uppercase tracking-wider text-[var(--el-text-color-primary)]">{{ t('topbar.notifications') }}</span>
          <button
            v-if="unreadCount > 0"
            @click="markAllRead"
            class="text-[10px] text-[var(--primary-green)] hover:underline font-bold cursor-pointer"
          >
            {{ t('notifications.markAllRead') }}
          </button>
        </div>
        <div class="p-2 space-y-1.5 max-h-80 overflow-y-auto custom-scrollbar">
          <p v-if="!loading && notificationItems.length === 0" class="py-6 text-center text-xs text-[var(--el-text-color-secondary)]">
            {{ t('topbar.noNotifications') }}
          </p>
          <div
            v-for="n in notificationItems"
            :key="n.id"
            @click="openNotification(n)"
            class="p-2.5 rounded-xl hover:bg-[var(--el-bg-color)] transition-colors cursor-pointer flex items-start gap-2.5"
            :class="n.read ? 'opacity-60' : ''"
          >
            <div class="w-2 h-2 rounded-full mt-1.5 shrink-0" :class="n.read ? 'bg-slate-500' : DOT_CLASS[n.severity]"></div>
            <div class="min-w-0">
              <p class="text-xs font-semibold text-[var(--el-text-color-primary)] truncate">{{ n.title }}</p>
              <p class="text-[11px] text-[var(--el-text-color-secondary)] leading-relaxed mt-0.5">{{ n.desc }}</p>
              <span class="text-[10px] text-[var(--text-muted)] mt-1 block">{{ n.time }}</span>
            </div>
          </div>
          <button
            v-if="hasMore"
            @click="loadMore"
            :disabled="loading"
            class="w-full py-2 text-[11px] font-semibold text-[var(--primary-green)] hover:underline cursor-pointer disabled:opacity-50"
          >
            {{ t('notifications.loadMore') }}
          </button>
        </div>
      </el-popover>

      <!-- AI Assistant Toggle Button -->
      <button
        @click="toggleAssistant"
        class="h-9 px-3.5 rounded-xl border flex items-center gap-2 transition-all shadow-sm cursor-pointer text-xs font-semibold select-none"
        :class="isAssistantOpen
          ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-400 shadow-emerald-500/10'
          : 'bg-[var(--el-card-bg-color)] border-[var(--el-border-color)] text-[var(--el-text-color-regular)] hover:text-[var(--primary-green)] hover:border-emerald-500/40'"
        title="Toggle AI Copilot"
      >
        <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <span class="hidden sm:inline">{{ t('topbar.assistant') }}</span>
        <span class="w-2 h-2 rounded-full bg-emerald-400" :class="isAssistantOpen ? 'animate-pulse' : 'opacity-60'"></span>
      </button>

      <!-- Profile Avatar Popover -->
      <el-popover
        placement="bottom-end"
        :width="230"
        trigger="click"
        popper-class="!p-0 !rounded-2xl !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] shadow-xl"
      >
        <template #reference>
          <div class="relative cursor-pointer select-none">
            <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 text-slate-900 font-black flex items-center justify-center text-sm shadow-sm ring-1 ring-[var(--el-border-color)] hover:ring-[var(--primary-green)] transition-all">
              {{ userInitial }}
            </div>
          </div>
        </template>

        <div class="p-4 border-b border-[var(--el-border-color)] flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 text-slate-900 font-black flex items-center justify-center text-sm shrink-0">
            {{ userInitial }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-[var(--el-text-color-primary)] truncate">{{ userName }}</p>
            <p class="text-[11px] text-[var(--el-text-color-secondary)] truncate">{{ userEmail }}</p>
          </div>
        </div>

        <div class="p-2 space-y-1">
          <button
            @click="goToSection('settings', 'profile')"
            class="w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-xl text-[var(--el-text-color-regular)] hover:text-[var(--el-text-color-primary)] hover:bg-[var(--el-bg-color)] transition-colors cursor-pointer text-left"
          >
            <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span>{{ t('topbar.profileSettings') }}</span>
          </button>

          <button
            @click="goToSection('settings', 'password')"
            class="w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-xl text-[var(--el-text-color-regular)] hover:text-[var(--el-text-color-primary)] hover:bg-[var(--el-bg-color)] transition-colors cursor-pointer text-left"
          >
            <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span>{{ t('topbar.changePassword') }}</span>
          </button>

          <button
            @click="router.push('/manual')"
            class="w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-xl text-[var(--el-text-color-regular)] hover:text-[#3ecf8e] hover:bg-[var(--el-bg-color)] transition-colors cursor-pointer text-left"
          >
            <svg class="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <span>{{ t('nav.manual') }}</span>
          </button>

          <div class="my-1 border-t border-[var(--el-border-color)]"></div>

          <button
            @click="handleLogout"
            class="w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-xl text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer text-left"
          >
            <svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>{{ t('common.logout') }}</span>
          </button>
        </div>
      </el-popover>
    </div>
  </header>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import { useAuth } from '@/composables/useAuth';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';
import { useNotifications } from '@/composables/useNotifications';

const props = defineProps({
  currentSection: {
    type: String,
    default: 'dashboard'
  }
});

const emit = defineEmits(['navigate', 'open-settings-tab']);

const router = useRouter();
const { t, locale } = useI18n();
const { isDark, isAssistantOpen, toggleTheme, toggleAssistant } = useTheme();
const { userName, userEmail, userInitial, logout } = useAuth();

const currentSectionTitle = computed(() => {
  const map = {
    dashboard: t('nav.dashboard'),
    cameras: t('nav.cameras'),
    analytics: t('nav.analytics'),
    map: t('nav.map'),
    settings: t('nav.settings')
  };
  return map[props.currentSection] || t('nav.dashboard');
});

const DOT_CLASS = { critical: 'bg-red-500', warning: 'bg-amber-400', info: 'bg-emerald-400' };
// Where a click on each notification type leads
const TARGET_SECTION = { pest_threshold: 'analytics', camera_offline: 'cameras', camera_online: 'cameras', ai_failure: 'analytics' };

const {
  items, unreadCount, hasMore, loading,
  load, loadMore, markRead, markAllRead, connect, format, relativeTime
} = useNotifications();

const notificationItems = computed(() => {
  locale.value; // re-render text when the language changes
  return items.value.map((n) => ({ ...n, ...format(n), time: relativeTime(n.createdAt) }));
});

const openNotification = (n) => {
  markRead([n.id]);
  const section = TARGET_SECTION[n.type];
  if (section) emit('navigate', section);
};

onMounted(() => {
  load();
  connect();
});

const goToSection = (section, tab = null) => {
  emit('navigate', section);
  if (tab) {
    emit('open-settings-tab', tab);
  }
};

const handleLogout = () => {
  logout();
};
</script>
