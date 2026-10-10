<template>
  <el-config-provider :locale="elLocale">
    <div class="min-h-screen w-full bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] font-sans antialiased selection:bg-[var(--el-color-primary-light-7)] selection:text-[var(--el-text-color-primary)]">
      <RouterView />
    </div>
  </el-config-provider>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { RouterView } from 'vue-router';
import { useI18n } from 'vue-i18n';
import vi from 'element-plus/es/locale/lang/vi';
import en from 'element-plus/es/locale/lang/en';
import { useTheme } from '@/utils/theme';

const { locale } = useI18n();
const { initTheme } = useTheme();

const elLocale = computed(() => (locale.value === 'vi' ? vi : en));

onMounted(() => {
  initTheme();
});
</script>