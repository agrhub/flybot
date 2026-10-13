<template>
  <div id="auth-layout" class="min-h-screen w-screen flex items-center justify-center p-6 relative overflow-hidden select-none">
    <!-- Back to Home link in top left -->
    <div class="absolute top-6 left-6 z-20">
      <router-link to="/" custom v-slot="{ navigate }">
        <el-button :icon="ArrowLeft" @click="navigate">{{ t('nav.home') }}</el-button>
      </router-link>
    </div>

    <!-- Quick language & theme switcher in corner -->
    <div class="absolute top-6 right-6 flex items-center gap-2 z-20">
      <LanguageSelect />
      <el-tooltip :content="isDark ? t('topbar.lightMode') : t('topbar.darkMode')" placement="bottom">
        <el-button :aria-label="isDark ? t('topbar.lightMode') : t('topbar.darkMode')" circle :icon="isDark ? Sunny : Moon" @click="toggleTheme" />
      </el-tooltip>
    </div>

    <!-- Main Auth Content Area -->
    <div class="w-full max-w-md relative z-10">
      <router-view />
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
import { ArrowLeft, Sunny, Moon } from '@element-plus/icons-vue';
import { useTheme } from '@/utils/theme';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';

const { t } = useI18n();
const { isDark, toggleTheme } = useTheme();
</script>

<style scoped>
#auth-layout {
  background-color: var(--el-bg-color-page);
  color: var(--el-text-color-primary);
}
</style>
