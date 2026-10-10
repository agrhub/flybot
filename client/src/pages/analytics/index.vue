<template>
  <div class="w-full max-w-7xl mx-auto pb-12">
    <PageHeader :title="t('analytics.title')" :subtitle="t('analytics.subtitle')">
      <template #actions>
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
    </PageHeader>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <!-- Camera selector -->
      <el-select
        v-if="cameras.length > 0"
        :model-value="selectedCamera?.deviceSerial || 'all'"
        @change="handleCameraChange"
        :placeholder="t('analytics.selectCamera')"
        class="!w-60"
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
        class="!w-44"
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

      <!-- Tab 2: Snapshot History & Inspection -->
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
import api from '@/services/api';
import { loadPdf, loadXlsx } from '@/utils/lazyLibs';
import { formatSummary, normalizeSummary } from '@/utils/species';
import { ElNotification } from 'element-plus';
import { Calendar, Document, Download, Files, List, TrendCharts, VideoCamera } from '@element-plus/icons-vue';
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
    const rows = results.map((item, index) => {
      const speciesDetail = formatSummary(item.aiResults?.summary, t) || t('analytics.report.notIdentified');
      const totalCount = Object.values(normalizeSummary(item.aiResults?.summary)).reduce((a, b) => a + b, 0);

      // Column headers are localized; keys of this object become the sheet header row
      return {
        [t('analytics.report.colIndex')]: index + 1,
        [t('analytics.report.colDevice')]: selectedCamera.value?.deviceName || item.deviceSerial,
        'Serial Number': item.deviceSerial,
        [t('analytics.report.colScanTime')]: new Date(item.createdAt).toLocaleString(dateLocale),
        [t('analytics.report.colInsectCount')]: totalCount,
        [t('analytics.report.colSpecies')]: speciesDetail,
        [t('analytics.report.colAiAssessment')]: item.aiResults?.raw_description || '',
        [t('analytics.report.colProvider')]: item.aiProvider || 'Vertex AI Gemini',
        [t('analytics.report.colImageUrl')]: item.imageUrl || ''
      };
    });

    const XLSX = await loadXlsx();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, t('analytics.report.sheetName'));

    worksheet['!cols'] = [
      { wch: 6 },
      { wch: 20 },
      { wch: 16 },
      { wch: 22 },
      { wch: 18 },
      { wch: 30 },
      { wch: 40 },
      { wch: 18 },
      { wch: 35 }
    ];

    const fileName = `FlyBot_Surveillance_${serial}_${Date.now()}.xlsx`;
    XLSX.writeFile(workbook, fileName);
    ElNotification({ title: t('common.success'), message: t('analytics.report.excelExported', { count: results.length }), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: t('analytics.report.excelFailed', { error: err.message }), type: 'error' });
  } finally {
    exportingXlsx.value = false;
  }
};
</script>
