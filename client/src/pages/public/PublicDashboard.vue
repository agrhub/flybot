<template>
  <div class="public-dash min-h-screen">
    <header class="public-dash__header">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <router-link to="/" class="flex items-center gap-2 min-w-0">
          <img src="/logo.png" alt="FlyBot Logo" class="w-8 h-8 rounded-lg object-contain shrink-0" />
          <span class="public-dash__brand">{{ t('common.brandName') }}</span>
        </router-link>
        <div class="flex items-center gap-2">
          <LanguageSelect />
          <el-button :icon="isDark ? Sunny : Moon" circle text @click="toggleTheme" />
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <el-skeleton v-if="loading && !dashboard" :rows="8" animated />

      <el-result v-else-if="notFound" icon="warning" :title="t('dashboards.public.notFound')" :sub-title="t('dashboards.public.notFoundDesc')">
        <template #extra>
          <el-button type="primary" @click="router.push('/')">{{ t('dashboards.public.home') }}</el-button>
        </template>
      </el-result>

      <template v-else-if="dashboard">
        <PageHeader :title="dashboard.name" :subtitle="dashboard.description">
          <template #actions>
            <el-button :icon="Refresh" :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
          </template>
        </PageHeader>
        <div class="flex flex-wrap items-center gap-2 mb-4">
          <el-tag type="warning" effect="light" round size="small">{{ t('dashboards.public.badge') }}</el-tag>
          <span v-if="dashboard.ownerName" class="public-dash__meta">{{ t('dashboards.public.by', { owner: dashboard.ownerName }) }}</span>
          <span v-if="generatedAt" class="public-dash__meta">{{ t('dashboards.updatedAt', { time: formatTime(generatedAt) }) }}</span>
        </div>

        <el-card v-if="!dashboard.widgets.length" shadow="never">
          <el-empty :description="t('dashboards.noWidgets')" />
        </el-card>
        <DashboardGrid v-else :widgets="dashboard.widgets" :data="widgetData" :loading="loading" />
      </template>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Refresh, Sunny, Moon } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useTheme } from '@/utils/theme';
import PageHeader from '@/components/common/PageHeader.vue';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';
import DashboardGrid from '@/components/dashboards/DashboardGrid.vue';

const REFRESH_MS = 5 * 60 * 1000;

const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const { isDark, toggleTheme, initTheme } = useTheme();

const dashboard = ref(null);
const widgetData = ref(null);
const generatedAt = ref(null);
const loading = ref(false);
const notFound = ref(false);

const formatTime = (value) => new Date(value).toLocaleTimeString(locale.value === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' });

const load = async () => {
  loading.value = true;
  try {
    const res = await api.getPublicDashboard(route.params.token);
    dashboard.value = res.data.dashboard;
    widgetData.value = res.data.widgets || {};
    generatedAt.value = res.data.generatedAt;
    document.title = `${res.data.dashboard.name} · ${t('common.brandName')}`;
  } catch (err) {
    if (err.response?.status === 404) notFound.value = true;
  } finally {
    loading.value = false;
  }
};

let timer = null;
onMounted(() => {
  initTheme();
  load();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !notFound.value) load();
  }, REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped>
.public-dash {
  background-color: var(--el-bg-color-page);
  color: var(--el-text-color-primary);
}
.public-dash__header {
  background-color: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color);
}
.public-dash__brand {
  font-size: 17px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.public-dash__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
