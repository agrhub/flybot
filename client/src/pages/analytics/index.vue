<template>
  <div class="w-full max-w-7xl mx-auto pb-12">
    <PageHeader :title="t('analytics.title')" :subtitle="t('analytics.subtitle')">
      <template #actions>
        <!-- Phones: one "Export" menu instead of three buttons -->
        <el-dropdown v-if="isMobile" trigger="click" @command="(cmd) => exportActions[cmd]()">
          <el-button type="primary" :icon="Download" :loading="exportingPdf || exportingXlsx || exportingReviews">
            {{ t('analytics.exportMenu') }}
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="pdf" :icon="Document">{{ t('analytics.exportPdf') }}</el-dropdown-item>
              <el-dropdown-item command="xlsx" :icon="Download">{{ t('analytics.exportExcel') }}</el-dropdown-item>
              <el-dropdown-item command="reviews" :icon="Files">{{ t('analytics.review.export') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <template v-else>
        <el-tooltip :content="t('analytics.review.exportHint')" placement="bottom">
          <el-button :icon="Files" :loading="exportingReviews" @click="exportCorrections">
            {{ t('analytics.review.export') }}
          </el-button>
        </el-tooltip>
        <el-button
          :icon="Download"
          :loading="exportingXlsx"
          :title="t('analytics.exportXlsx')"
          @click="exportToExcel"
        >
          {{ exportingXlsx ? t('analytics.exporting') : t('analytics.exportExcel') }}
        </el-button>
        <el-button
          type="primary"
          :icon="Document"
          :loading="exportingPdf"
          :title="t('analytics.exportPdf')"
          @click="exportToPdf"
        >
          {{ exportingPdf ? t('analytics.exporting') : t('analytics.exportPdf') }}
        </el-button>
        </template>
      </template>
    </PageHeader>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <!-- Camera selector -->
      <el-select
        v-if="cameras.length > 0"
        :model-value="selectedCamera?.deviceSerial || 'all'"
        @change="handleCameraChange"
        :placeholder="t('analytics.selectCamera')"
        class="w-full sm:!w-60"
      >
        <template #prefix>
          <el-icon><VideoCamera /></el-icon>
        </template>
        <el-option :label="t('analytics.allCameras')" value="all" />
        <el-option
          v-for="cam in cameras"
          :key="cam.deviceSerial"
          :label="`${cam.deviceName} (${cam.deviceSerial})`"
          :value="cam.deviceSerial"
        />
      </el-select>

      <!-- Time range selector -->
      <el-select
        v-model="selectedTimeRange"
        @change="handleTimeRangeChange"
        class="w-full sm:!w-44"
      >
        <template #prefix>
          <el-icon><Calendar /></el-icon>
        </template>
        <el-option :label="t('analytics.periodToday')" value="today" />
        <el-option :label="t('analytics.period7Days')" value="7d" />
        <el-option :label="t('analytics.period30Days')" value="30d" />
        <el-option :label="t('analytics.periodCustom')" value="custom" />
      </el-select>

      <!-- Custom date range picker (shown if 'custom' selected) -->
      <el-date-picker
        v-if="selectedTimeRange === 'custom'"
        v-model="customDateRange"
        type="daterange"
        range-separator="→"
        :start-placeholder="t('analytics.startDate')"
        :end-placeholder="t('analytics.endDate')"
        format="YYYY-MM-DD"
        value-format="YYYY-MM-DD"
        class="!w-64"
      />
    </div>

    <el-tabs v-model="activeSubTab">
      <!-- Tab 1: Charts & Trends -->
      <el-tab-pane name="trends">
        <template #label>
          <span class="inline-flex items-center gap-1.5">
            <el-icon><TrendCharts /></el-icon>
            <span>{{ t('analytics.tabTrends') }}</span>
          </span>
        </template>
        <StatisticsTab
          :camera="selectedCamera"
          :time-range="selectedTimeRange"
          :start-date="effectiveStartDate"
          :end-date="effectiveEndDate"
          :active="activeSubTab === 'trends'"
        />
      </el-tab-pane>

      <!-- Tab 2: Insights (per-trap table, daily catches, activity by hour, weather) -->
      <el-tab-pane name="insights">
        <template #label>
          <span class="inline-flex items-center gap-1.5">
            <el-icon><DataAnalysis /></el-icon>
            <span>{{ t('insights.tab') }}</span>
          </span>
        </template>
        <InsightsTab :camera="selectedCamera" :active="activeSubTab === 'insights'" />
      </el-tab-pane>

      <!-- Tab 3: Snapshot History & Inspection -->
      <el-tab-pane name="history">
        <template #label>
          <span class="inline-flex items-center gap-1.5">
            <el-icon><List /></el-icon>
            <span>{{ t('analytics.tabHistory') }}</span>
          </span>
        </template>
        <HistoryTab
          ref="historyTabRef"
          :camera="selectedCamera"
          :start-date="effectiveStartDate"
          :end-date="effectiveEndDate"
        />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCameras } from '@/composables/useCameras';
import StatisticsTab from './tabs/StatisticsTab.vue';
import HistoryTab from './tabs/HistoryTab.vue';
import InsightsTab from './tabs/InsightsTab.vue';
import api from '@/services/api';
import { loadPdf, loadExcelWriter } from '@/utils/lazyLibs';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { formatSummary, normalizeSummary } from '@/utils/species';
import { ElNotification } from 'element-plus';
import { Calendar, Document, Download, Files, List, TrendCharts, VideoCamera, DataAnalysis } from '@element-plus/icons-vue';
import PageHeader from '@/components/common/PageHeader.vue';

const { t, locale } = useI18n();
const { cameras, selectedCamera, selectCamera } = useCameras();
const activeSubTab = ref('trends'); // 'trends' | 'history'
const selectedTimeRange = ref('30d'); // 'today' | '7d' | '30d' | 'custom'
const customDateRange = ref(null); // [ 'YYYY-MM-DD', 'YYYY-MM-DD' ]

const exportingXlsx = ref(false);
const exportingReviews = ref(false);

// Human-corrected snapshots (model output vs corrected counts) as JSON, to retrain the detector
const exportCorrections = async () => {
  exportingReviews.value = true;
  try {
    const res = await api.exportReviews(90);
    const items = res.data?.items || [];
    if (items.length === 0) {
      ElNotification({ title: t('common.notice'), message: t('analytics.review.exportEmpty'), type: 'info' });
      return;
    }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `FlyBot_Corrections_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    ElNotification({ title: t('common.success'), message: t('analytics.review.exported', { count: items.length }), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    exportingReviews.value = false;
  }
};
const exportingPdf = ref(false);
const historyTabRef = ref(null);

const effectiveStartDate = computed(() => {
  if (selectedTimeRange.value === 'custom' && customDateRange.value && customDateRange.value[0]) {
    return customDateRange.value[0];
  }
  const d = new Date();
  if (selectedTimeRange.value === 'today') {
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (selectedTimeRange.value === '7d') {
    d.setDate(d.getDate() - 7);
    return d.toISOString();
  }
  if (selectedTimeRange.value === '30d') {
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  }
  return null;
});

const effectiveEndDate = computed(() => {
  if (selectedTimeRange.value === 'custom' && customDateRange.value && customDateRange.value[1]) {
    return customDateRange.value[1];
  }
  return null;
});

const handleCameraChange = (serial) => {
  if (serial === 'all') {
    selectCamera({ deviceSerial: 'all', deviceName: t('analytics.allCameras') });
    return;
  }
  const found = cameras.value.find(c => c.deviceSerial === serial);
  if (found) {
    selectCamera(found);
  }
};

const handleTimeRangeChange = (val) => {
  if (val !== 'custom') {
    customDateRange.value = null;
  }
};

const exportToPdf = async () => {
  exportingPdf.value = true;
  try {
    const serial = selectedCamera.value?.deviceSerial || 'all';
    const deviceName = selectedCamera.value?.deviceName || t('analytics.report.allCameras');
    const dateLocale = locale.value === 'vi' ? 'vi-VN' : 'en-US';

    // Fetch records to export
    const res = await api.getAiResults(serial, 1, 100, effectiveStartDate.value, effectiveEndDate.value);
    const results = res.data?.results || [];

    const { jsPDF, autoTable, addQuicksandFonts } = await loadPdf();
    const doc = new jsPDF({
      orientation: 'p',
      unit: 'mm',
      format: 'a4',
      putOnlyUsedFonts: true
    });

    addQuicksandFonts(doc);
    try {
      doc.setFont('Quicksand', 'normal');
    } catch (e) {
      console.warn('Fallback font', e);
    }

    // Title & Metadata
    doc.setFontSize(18);
    doc.setTextColor(16, 185, 129); // Emerald
    doc.text('FLYBOT INSECT SURVEILLANCE REPORT', 14, 20);

    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(t('analytics.report.device', { name: deviceName }), 14, 28);
    doc.text(t('analytics.report.serial', { serial: serial === 'all' ? t('analytics.report.wholeSystem') : serial }), 14, 33);
    doc.text(t('analytics.report.timeRange', { range: selectedTimeRange.value.toUpperCase() }), 14, 38);
    doc.text(t('analytics.report.exportedAt', { time: new Date().toLocaleString(dateLocale) }), 14, 43);

    const tableData = results.map(item => {
      const speciesDetail = formatSummary(item.aiResults?.summary, t) || t('analytics.report.notIdentified');
      const totalCount = Object.values(normalizeSummary(item.aiResults?.summary)).reduce((a, b) => a + b, 0);
      const timeStr = new Date(item.createdAt).toLocaleString(dateLocale);
      const desc = item.aiResults?.raw_description || '--';
      return [timeStr, item.deviceSerial, totalCount, speciesDetail, desc];
    });

    autoTable(doc, {
      startY: 48,
      head: [[
        t('analytics.report.colTime'),
        t('analytics.report.colSerial'),
        t('analytics.report.colCount'),
        t('analytics.report.colSpecies'),
        t('analytics.report.colAiAssessment')
      ]],
      body: tableData.length > 0 ? tableData : [['--', '--', '0', t('analytics.report.noDataInRange'), '--']],
      theme: 'grid',
      styles: {
        font: 'Quicksand',
        fontSize: 8,
        valign: 'middle'
      },
      headStyles: {
        fillColor: [16, 185, 129],
        textColor: [255, 255, 255],
        fontStyle: 'bold'
      },
      columnStyles: {
        0: { cellWidth: 35 },
        1: { cellWidth: 25 },
        2: { cellWidth: 16, halign: 'center' },
        3: { cellWidth: 45 },
        4: { cellWidth: 'auto' }
      }
    });

    const fileName = `FlyBot_Report_${serial}_${Date.now()}.pdf`;
    doc.save(fileName);
    ElNotification({ title: t('common.success'), message: t('analytics.report.pdfExported', { count: results.length }), type: 'success' });
  } catch (err) {
    console.error('PDF export error:', err);
    ElNotification({ title: t('common.error'), message: t('analytics.report.pdfFailed', { error: err.message }), type: 'error' });
  } finally {
    exportingPdf.value = false;
  }
};

const { isMobile } = useBreakpoints();
const exportActions = {
  pdf: () => exportToPdf(),
  xlsx: () => exportToExcel(),
  reviews: () => exportCorrections()
};

const exportToExcel = async () => {
  const serial = selectedCamera.value?.deviceSerial || 'all';
  exportingXlsx.value = true;
  try {
    const res = await api.getAiResults(serial, 1, 500, effectiveStartDate.value, effectiveEndDate.value);
    const results = res.data?.results || [];

    if (results.length === 0) {
      ElNotification({ title: t('common.notice'), message: t('analytics.report.noDataToExport'), type: 'info' });
      return;
    }

    const dateLocale = locale.value === 'vi' ? 'vi-VN' : 'en-US';
    // Localized header row, then one row per scan (cells are written as plain values, never formulas)
    const header = [
      t('analytics.report.colIndex'),
      t('analytics.report.colDevice'),
      'Serial Number',
      t('analytics.report.colScanTime'),
      t('analytics.report.colInsectCount'),
      t('analytics.report.colSpecies'),
      t('analytics.report.colAiAssessment'),
      t('analytics.report.colProvider'),
      t('analytics.report.colImageUrl')
    ].map((value) => ({ value, fontWeight: 'bold' }));
    const rows = results.map((item, index) => {
      const speciesDetail = formatSummary(item.aiResults?.summary, t) || t('analytics.report.notIdentified');
      const totalCount = Object.values(normalizeSummary(item.aiResults?.summary)).reduce((a, b) => a + b, 0);
      return [
        index + 1,
        selectedCamera.value?.deviceName || item.deviceSerial,
        item.deviceSerial,
        new Date(item.createdAt).toLocaleString(dateLocale),
        totalCount,
        speciesDetail,
        item.aiResults?.raw_description || '',
        item.aiProvider || 'Vertex AI Gemini',
        item.imageUrl || ''
      ];
    });

    const writeExcelFile = await loadExcelWriter();
    const fileName = `FlyBot_Surveillance_${serial}_${Date.now()}.xlsx`;
    await writeExcelFile([header, ...rows], {
      sheet: t('analytics.report.sheetName').slice(0, 31),
      columns: [6, 20, 16, 22, 18, 30, 40, 18, 35].map((width) => ({ width })),
      stickyRowsCount: 1
    }).toFile(fileName);
    ElNotification({ title: t('common.success'), message: t('analytics.report.excelExported', { count: results.length }), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: t('analytics.report.excelFailed', { error: err.message }), type: 'error' });
  } finally {
    exportingXlsx.value = false;
  }
};
</script>
