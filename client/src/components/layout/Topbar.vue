<template>
  <header class="topbar h-14 sm:h-16 px-3 sm:px-6 lg:px-8 flex items-center justify-between gap-2 shrink-0 z-10 transition-colors select-none">
    <!-- Left: logo (phones) and page title -->
    <div class="flex items-center gap-2 min-w-0">
      <img v-if="isMobile" src="/logo.png" alt="FlyBot" class="w-7 h-7 rounded-md object-contain shrink-0" />
      <span class="topbar-title truncate">{{ currentSectionTitle }}</span>
    </div>

    <!-- Right Controls -->
    <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
      <!-- Language and theme: under "More" on phones -->
      <LanguageSelect v-if="!isMobile" />

      <el-tooltip v-if="!isMobile" :content="isDark ? t('topbar.lightMode') : t('topbar.darkMode')" placement="bottom">
        <el-button circle :icon="isDark ? Sunny : Moon" @click="toggleTheme" />
      </el-tooltip>

      <!-- Notifications Popover -->
      <el-popover
        placement="bottom-end"
        :width="isMobile ? 'calc(100vw - 24px)' : 340"
        trigger="click"
        :popper-style="{ padding: 0 }"
      >
        <template #reference>
          <span class="inline-flex">
            <el-badge :value="unreadCount" :max="99" :hidden="unreadCount === 0" type="warning">
              <el-button circle :icon="Bell" :title="t('topbar.notifications')" />
            </el-badge>
          </span>
        </template>

        <div class="notif-header px-4 py-3 flex items-center justify-between gap-2">
          <span class="notif-heading">{{ t('topbar.notifications') }}</span>
          <el-button v-if="unreadCount > 0" link type="primary" size="small" @click="markAllRead">
            {{ t('notifications.markAllRead') }}
          </el-button>
        </div>
        <div class="p-2 max-h-80 overflow-y-auto custom-scrollbar">
          <el-empty
            v-if="!loading && notificationItems.length === 0"
            :image-size="60"
            :description="t('topbar.noNotifications')"
          />
          <div
            v-for="n in notificationItems"
            :key="n.id"
            @click="openNotification(n)"
            class="notif-item p-2.5 cursor-pointer flex items-start gap-2.5"
            :class="{ 'is-read': n.read }"
          >
            <span class="notif-dot mt-1.5 shrink-0" :style="{ backgroundColor: dotColor(n) }"></span>
            <div class="min-w-0">
              <p class="notif-title truncate">{{ n.title }}</p>
              <p class="notif-desc mt-0.5">{{ n.desc }}</p>
              <span class="notif-time mt-1 block">{{ n.time }}</span>
            </div>
          </div>
          <el-button
            v-if="hasMore"
            text
            type="primary"
            class="w-full"
            :disabled="loading"
            @click="loadMore"
          >
            {{ t('notifications.loadMore') }}
          </el-button>
        </div>
      </el-popover>

      <!-- AI Assistant Toggle Button -->
      <el-button
        :type="isAssistantOpen ? 'primary' : 'default'"
        :plain="isAssistantOpen"
        :icon="MagicStick"
        :title="t('topbar.assistant')"
        :circle="isMobile"
        @click="toggleAssistant"
      >
        <span v-if="!isMobile">{{ t('topbar.assistant') }}</span>
      </el-button>

      <!-- Profile menu -->
      <el-dropdown trigger="click" placement="bottom-end">
        <el-avatar shape="square" :size="32" class="profile-avatar cursor-pointer">
          {{ userInitial }}
        </el-avatar>

        <template #dropdown>
          <div class="profile-header px-4 py-3 flex items-center gap-3">
            <el-avatar shape="square" :size="40" class="profile-avatar shrink-0">{{ userInitial }}</el-avatar>
            <div class="min-w-0 flex-1">
              <p class="profile-name truncate">{{ userName }}</p>
              <p class="profile-email truncate">{{ userEmail }}</p>
            </div>
          </div>
          <el-dropdown-menu class="profile-menu">
            <el-dropdown-item :icon="User" @click="goToSection('settings', 'profile')">
              {{ t('topbar.profileSettings') }}
            </el-dropdown-item>
            <el-dropdown-item :icon="Lock" @click="goToSection('settings', 'password')">
              {{ t('topbar.changePassword') }}
            </el-dropdown-item>
            <el-dropdown-item :icon="Reading" @click="router.push('/manual')">
              {{ t('nav.manual') }}
            </el-dropdown-item>
            <el-dropdown-item divided :icon="SwitchButton" class="topbar-logout-item" @click="handleLogout">
              {{ t('common.logout') }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Sunny, Moon, Bell, MagicStick, User, Lock, Reading, SwitchButton } from '@element-plus/icons-vue';
import { useTheme } from '@/utils/theme';
import { useAuth } from '@/composables/useAuth';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';
import { useNotifications } from '@/composables/useNotifications';
import { useBreakpoints } from '@/composables/useBreakpoints';

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
const { isMobile } = useBreakpoints();

const currentSectionTitle = computed(() => {
  const map = {
    dashboard: t('nav.dashboard'),
    cameras: t('nav.cameras'),
    dashboards: t('nav.dashboards'),
    logbook: t('nav.logbook'),
    analytics: t('nav.analytics'),
    map: t('nav.map'),
    settings: t('nav.settings')
  };
  return map[props.currentSection] || t('nav.dashboard');
});

// Severity -> Element Plus theme color
const SEVERITY_COLOR = {
  critical: 'var(--el-color-danger)',
  warning: 'var(--el-color-warning)',
  info: 'var(--el-color-success)'
};
const dotColor = (n) => (n.read ? 'var(--el-color-info)' : SEVERITY_COLOR[n.severity] || 'var(--el-color-info)');
// Where a click on each notification type leads
const TARGET_SECTION = { pest_threshold: 'analytics', camera_offline: 'cameras', camera_online: 'cameras', ai_failure: 'analytics', camera_shared: 'cameras', card_due: 'cameras', card_change_detected: 'cameras' };

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
  if (n.type === 'dashboard_shared' && n.params?.dashboardId) {
    router.push(`/dashboards/${n.params.dashboardId}`);
    return;
  }
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

<style scoped>
.topbar {
  background-color: var(--el-bg-color-page);
  border-bottom: 1px solid var(--el-border-color);
}

.topbar-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.notif-header {
  border-bottom: 1px solid var(--el-border-color);
}

.notif-heading {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.notif-item {
  border-radius: var(--el-border-radius-base);
  transition: background-color 0.15s;
}

.notif-item:hover {
  background-color: var(--el-fill-color-light);
}

.notif-item.is-read {
  opacity: 0.6;
}

.notif-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.notif-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.notif-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}

.notif-time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.profile-avatar {
  background-color: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}

.profile-header {
  border-bottom: 1px solid var(--el-border-color);
  min-width: 220px;
}

.profile-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.profile-email {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

:global(.el-dropdown-menu__item.topbar-logout-item) {
  color: var(--el-color-danger);
}
</style>
