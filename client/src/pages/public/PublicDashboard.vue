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
          <el-button :icon="isDark ? Sunny : Moon" circle text :aria-label="isDark ? t('topbar.lightMode') : t('topbar.darkMode')" @click="toggleTheme" />
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <el-skeleton v-if="loading && !dashboard" :rows="8" animated />

      <el-result
        v-else-if="notFound"
        icon="warning"
        :title="expired ? t('dashboards.public.expired') : t('dashboards.public.notFound')"
        :sub-title="expired ? t('dashboards.public.expiredDesc') : t('dashboards.public.notFoundDesc')"
      >
        <template #extra>
          <el-button type="primary" @click="router.push('/')">{{ t('dashboards.public.home') }}</el-button>
        </template>
      </el-result>

      <template v-else-if="dashboard">
        <PageHeader :title="dashboard.name" :subtitle="dashboard.description">
          <template #actions>
            <el-button :icon="Refresh" :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
            <el-button :icon="Download" :loading="exporting" :disabled="!widgetData || !dashboard.widgets.length" @click="exportPdf">{{ t('dashboards.exportPdf') }}</el-button>
          </template>
        </PageHeader>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div class="flex flex-wrap items-center gap-2">
            <el-tag type="warning" effect="light" round size="small">{{ t('dashboards.public.badge') }}</el-tag>
            <el-tag v-if="dashboard.expiresAt" type="info" effect="plain" round size="small">
              {{ t('dashboards.expiry.until', { time: formatDateTime(dashboard.expiresAt) }) }}
            </el-tag>
            <span v-if="dashboard.ownerName" class="public-dash__meta">{{ t('dashboards.public.by', { owner: dashboard.ownerName }) }}</span>
            <span v-if="generatedAt" class="public-dash__meta">{{ t('dashboards.updatedAt', { time: formatTime(generatedAt) }) }}</span>
          </div>
          <ReportRangePicker v-model="viewRange" />
        </div>

        <el-card v-if="!dashboard.widgets.length" shadow="never">
          <el-empty :description="t('dashboards.noWidgets')" />
        </el-card>
        <DashboardGrid v-else :widgets="dashboard.widgets" :data="widgetData" :loading="loading" :range-days="dataRange?.days || 0" />
      </template>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Refresh, Sunny, Moon, Download } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import api from '@/services/api';
import { useTheme } from '@/utils/theme';
import PageHeader from '@/components/common/PageHeader.vue';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';
import DashboardGrid from '@/components/dashboards/DashboardGrid.vue';
import ReportRangePicker from '@/components/dashboards/ReportRangePicker.vue';
import { rangeQuery, sameRange } from '@/utils/dashboards';
import { exportReportPdf } from '@/utils/reportPdf';
import { latestOnly } from '@/utils/latestOnly';

const loadRequest = latestOnly();

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
const expired = ref(false);
// null until the report's own range is known; then the range shown
const viewRange = ref(null);
const dataRange = ref(null);
const exporting = ref(false);

const dateLocale = computed(() => (locale.value === 'vi' ? 'vi-VN' : 'en-US'));
const formatTime = (value) => new Date(value).toLocaleTimeString(dateLocale.value, { hour: '2-digit', minute: '2-digit' });
const formatDateTime = (value) => new Date(value).toLocaleString(dateLocale.value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const load = async () => {
  loading.value = true;
  try {
    const query = viewRange.value && dashboard.value && !sameRange(viewRange.value, dashboard.value.range) ? rangeQuery(viewRange.value) : null;
    const isLatest = loadRequest();
    const res = await api.getPublicDashboard(route.params.token, query);
    if (!isLatest()) return;
    dashboard.value = res.data.dashboard;
    widgetData.value = res.data.widgets || {};
    dataRange.value = res.data.range || null;
    generatedAt.value = res.data.generatedAt;
    if (!viewRange.value) viewRange.value = { ...(res.data.dashboard.range || { preset: '7d' }) };
    document.title = `${res.data.dashboard.name} · ${t('common.brandName')}`;
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 410) {
      notFound.value = true;
      expired.value = err.response?.status === 410;
    }
  } finally {
    loading.value = false;
  }
};

watch(viewRange, (value, old) => {
  if (old && !sameRange(value, old)) load();
}, { deep: true });

const exportPdf = async () => {
  exporting.value = true;
  try {
    await exportReportPdf({
      t,
      locale: locale.value,
      report: dashboard.value,
      range: { ...viewRange.value, ...(dataRange.value || {}) },
      widgets: [...dashboard.value.widgets].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x),
      data: widgetData.value,
      generatedAt: generatedAt.value,
    });
  } catch (err) {
    console.error('Report PDF failed:', err);
    ElMessage.error(t('dashboards.pdfFailed'));
  } finally {
    exporting.value = false;
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
