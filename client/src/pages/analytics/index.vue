<template>
  <div class="w-full max-w-7xl mx-auto pb-12">
    <PageHeader :title="t('analytics.title')" :subtitle="t('analytics.subtitle')">
      <template #actions>
        <el-button type="primary" :icon="Document" :loading="exportingPdf" @click="exportToPdf">
          {{ exportingPdf ? progressText : t('analytics.exportAllPdf') }}
        </el-button>
      </template>
    </PageHeader>

    <!-- Page filters: every widget starts from them and can set its own -->
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <el-select
        v-if="cameras.length > 0"
        :model-value="selectedCamera?.deviceSerial || 'all'"
        :placeholder="t('analytics.selectCamera')"
        class="w-full sm:!w-60"
        @change="handleCameraChange"
      >
        <template #prefix>
          <el-icon><VideoCamera /></el-icon>
        </template>
        <el-option :label="t('analytics.allCameras')" value="all" />
        <el-option v-for="cam in cameras" :key="cam.deviceSerial" :label="`${cam.deviceName} (${cam.deviceSerial})`" :value="cam.deviceSerial" />
      </el-select>
      <DateRangeFilter v-model="range" />
      <span class="filters-hint">{{ t('filters.pageHint') }}</span>
    </div>

    <el-tabs v-model="activeSubTab">
      <el-tab-pane name="trends">
        <template #label>
          <span class="inline-flex items-center gap-1.5">
            <el-icon><TrendCharts /></el-icon>
            <span>{{ t('analytics.tabTrends') }}</span>
          </span>
        </template>
        <StatisticsTab ref="trendsRef" :camera="selectedCamera" :range="range" :active="activeSubTab === 'trends'" />
      </el-tab-pane>

      <el-tab-pane name="insights">
        <template #label>
          <span class="inline-flex items-center gap-1.5">
            <el-icon><DataAnalysis /></el-icon>
            <span>{{ t('insights.tab') }}</span>
          </span>
        </template>
        <InsightsTab ref="insightsRef" :camera="selectedCamera" :range="range" :active="activeSubTab === 'insights'" />
      </el-tab-pane>

      <el-tab-pane name="history">
        <template #label>
          <span class="inline-flex items-center gap-1.5">
            <el-icon><List /></el-icon>
            <span>{{ t('analytics.tabHistory') }}</span>
          </span>
        </template>
        <HistoryTab ref="historyRef" :camera="selectedCamera" :range="range" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessageBox, ElNotification } from 'element-plus';
import { Document, List, TrendCharts, VideoCamera, DataAnalysis } from '@element-plus/icons-vue';
import { useCameras } from '@/composables/useCameras';
import StatisticsTab from './tabs/StatisticsTab.vue';
import HistoryTab from './tabs/HistoryTab.vue';
import InsightsTab from './tabs/InsightsTab.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import DateRangeFilter from '@/components/common/DateRangeFilter.vue';
import { dateRangeLabel } from '@/utils/dateRange';
import { exportAnalyticsPdf } from '@/utils/analyticsPdf';

const { t, locale } = useI18n();
const { cameras, selectedCamera, selectCamera } = useCameras();
const activeSubTab = ref('trends');
const range = ref({ preset: '30d' });

const handleCameraChange = (serial) => {
  if (serial === 'all') {
    selectCamera({ deviceSerial: 'all', deviceName: t('analytics.allCameras') });
    return;
  }
  const found = cameras.value.find(c => c.deviceSerial === serial);
  if (found) selectCamera(found);
};

// ---------- One PDF with the three tabs ----------
const trendsRef = ref(null);
const insightsRef = ref(null);
const historyRef = ref(null);
const exportingPdf = ref(false);
const progress = ref({ done: 0, total: 0 });
const progressText = computed(() => (progress.value.total
  ? t('history.progress.images', progress.value)
  : t('common.exporting')));

const exportToPdf = async () => {
  try {
    await ElMessageBox.confirm(t('analytics.exportAllHint'), t('analytics.exportAllPdf'), {
      type: 'info',
      confirmButtonText: t('analytics.exportAllPdf'),
      cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  exportingPdf.value = true;
  progress.value = { done: 0, total: 0 };
  try {
    const sections = [
      ...(await trendsRef.value.pdfSections()),
      ...(await insightsRef.value.pdfSections()),
      ...(await historyRef.value.pdfSections()),
    ];
    const dateLocale = locale.value === 'vi' ? 'vi-VN' : 'en-US';
    await exportAnalyticsPdf({
      t,
      locale: locale.value,
      title: t('analytics.title'),
      lines: [
        t('analytics.report.device', { name: selectedCamera.value?.deviceSerial && selectedCamera.value.deviceSerial !== 'all' ? selectedCamera.value.deviceName : t('analytics.allCameras') }),
        t('history.filterRange', { range: dateRangeLabel(t, range.value) }),
        t('analytics.report.exportedAt', { time: new Date().toLocaleString(dateLocale) }),
        t('filters.pdfNote'),
      ],
      sections,
      fileName: `FlyBot_Analytics_${new Date().toISOString().slice(0, 10)}.pdf`,
      onProgress: (done, total) => { progress.value = { done, total }; },
    });
    ElNotification({ title: t('common.success'), message: t('analytics.pdfSuccess'), type: 'success' });
  } catch (err) {
    console.error('Analytics PDF failed:', err);
    ElNotification({ title: t('common.error'), message: t('analytics.report.pdfFailed', { error: err.message }), type: 'error' });
  } finally {
    exportingPdf.value = false;
  }
};
</script>

<style scoped>
.filters-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
