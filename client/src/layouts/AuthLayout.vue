<template>
  <div id="auth-layout" class="min-h-screen w-screen flex items-center justify-center p-6 bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] relative overflow-hidden select-none">
    <!-- Ambient Green Glows -->
    <div class="absolute -top-32 -left-32 w-96 h-96 bg-[var(--primary-green)]/15 rounded-full blur-[100px] pointer-events-none"></div>
    <div class="absolute -bottom-32 -right-32 w-96 h-96 bg-teal-500/15 rounded-full blur-[100px] pointer-events-none"></div>

    <!-- Back to Home link in top left -->
    <div class="absolute top-6 left-6 z-20">
      <router-link
        to="/"
        class="flex items-center gap-2 px-3.5 py-1.5 rounded-xl border border-[var(--el-border-color)] bg-[var(--el-bg-color-overlay)] hover:border-[#3ecf8e] hover:text-[#3ecf8e] text-xs font-semibold text-[var(--el-text-color-secondary)] transition-all shadow-sm cursor-pointer"
      >
        <span>&larr;</span>
        <span>{{ t('nav.home') }}</span>
      </router-link>
    </div>

    <!-- Quick language & theme switcher in corner -->
    <div class="absolute top-6 right-6 flex items-center gap-2 z-20">
      <LanguageSelect />
      <button
        @click="toggleTheme"
        class="w-9 h-9 rounded-xl border border-[var(--el-border-color)] bg-[var(--el-bg-color-overlay)] hover:bg-[var(--el-border-color-extra-light)] flex items-center justify-center text-xs transition-colors cursor-pointer"
        :title="isDark ? t('topbar.lightMode') : t('topbar.darkMode')"
      >
        <span v-if="isDark">☀️</span>
        <span v-else>🌙</span>
      </button>
    </div>

    <!-- Main Auth Content Area -->
    <div class="w-full max-w-md relative z-10">
      <router-view />
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';

const { t } = useI18n();
const { isDark, toggleTheme } = useTheme();
</script>
