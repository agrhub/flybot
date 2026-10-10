<template>
  <div class="space-y-6 w-full max-w-7xl mx-auto pb-12 select-none">
    <!-- Top Action Bar -->
    <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-5 shadow-soft flex flex-col justify-between gap-4">
      <div class="flex flex-row gap-4 justify-between items-center w-full">
        <div>
          <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">
            {{ t('analytics.title') }}
          </h3>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-0.5">
            {{ t('analytics.subtitle') }}
          </p>
        </div>
        <div>
          <!-- Sub Tab Switcher -->
          <div class="flex bg-[var(--el-bg-color)] p-1 rounded-2xl border border-[var(--el-border-color)]">
            <button
              @click="activeSubTab = 'trends'"
              class="px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
              :class="activeSubTab === 'trends'
                ? 'bg-[var(--el-card-bg-color)] text-[var(--primary-green)] shadow-sm'
                : 'text-[var(--el-text-color-secondary)] hover:text-[var(--el-text-color-primary)]'"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" />
              </svg>
              <span>{{ t('analytics.tabTrends') }}</span>
            </button>

            <button
              @click="activeSubTab = 'history'"
              class="px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
              :class="activeSubTab === 'history'
                ? 'bg-[var(--el-card-bg-color)] text-[var(--primary-green)] shadow-sm'
                : 'text-[var(--el-text-color-secondary)] hover:text-[var(--el-text-color-primary)]'"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <span>{{ t('analytics.tabHistory') }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <!-- Camera Selector Dropdown -->
        <el-select
          v-if="cameras.length > 0"
          :model-value="selectedCamera?.deviceSerial || 'all'"
          @change="handleCameraChange"
          :placeholder="t('analytics.selectCamera')"
          size="default"
          class="!w-52"
        >
          <el-option
            :label="`🌐 ${t('analytics.allCameras')}`"
            value="all"
          />
          <el-option
            v-for="cam in cameras"
            :key="cam.deviceSerial"
            :label="`${cam.deviceName} (${cam.deviceSerial})`"
            :value="cam.deviceSerial"
          />
        </el-select>

        <!-- Time Range Selector (Requirement #2) -->
        <el-select
          v-model="selectedTimeRange"
          @change="handleTimeRangeChange"
          size="default"
          class="!w-40"
        >
          <el-option :label="`📅 ${t('analytics.periodToday')}`" value="today" />
          <el-option :label="`📅 ${t('analytics.period7Days')}`" value="7d" />
          <el-option :label="`📅 ${t('analytics.period30Days')}`" value="30d" />
          <el-option :label="`📆 ${t('analytics.periodCustom')}`" value="custom" />
        </el-select>

        <!-- Custom Date Range Picker (shown if 'custom' selected) -->
        <el-date-picker
          v-if="selectedTimeRange === 'custom'"
          v-model="customDateRange"
          type="daterange"
          range-separator="→"
          :start-placeholder="t('analytics.startDate')"
          :end-placeholder="t('analytics.endDate')"
          size="default"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          class="!w-64"
        />

        <!-- Export Excel (XLSX) Button -->
        <button
          @click="exportToExcel"
          :disabled="exportingXlsx"
          class="flex items-center gap-1.5 px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-xl text-xs font-bold transition-all border border-emerald-500/30 cursor-pointer disabled:opacity-50"
          :title="t('analytics.exportXlsx')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span>{{ exportingXlsx ? t('analytics.exporting') : t('analytics.exportExcel') }}</span>
        </button>

        <!-- Export PDF Button -->
        <button
          @click="exportToPdf"
          :disabled="exportingPdf"
          class="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl text-xs font-bold transition-all border border-red-500/30 cursor-pointer disabled:opacity-50"
          :title="t('analytics.exportPdf')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span>{{ exportingPdf ? t('analytics.exporting') : t('analytics.exportPdf') }}</span>
        </button>
      </div>
    </div>

    <!-- Tab 1: Charts & Trends -->
    <div v-show="activeSubTab === 'trends'" class="w-full">
      <StatisticsTab
        :camera="selectedCamera"
        :time-range="selectedTimeRange"
        :start-date="effectiveStartDate"
        :end-date="effectiveEndDate"
        :active="activeSubTab === 'trends'"
      />
    </div>

    <!-- Tab 2: Snapshot History & Inspection -->
    <div v-show="activeSubTab === 'history'" class="w-full">
      <HistoryTab
        ref="historyTabRef"
        :camera="selectedCamera"
        :start-date="effectiveStartDate"
        :end-date="effectiveEndDate"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCameras } from '@/composables/useCameras';
import StatisticsTab from './tabs/StatisticsTab.vue';
import HistoryTab from './tabs/HistoryTab.vue';
import api from '@/services/api';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { addQuicksandFonts } from '@/utils/pdfFonts';
import { formatSummary, normalizeSummary } from '@/utils/species';
import { ElNotification } from 'element-plus';

const { t, locale } = useI18n();
const { cameras, selectedCamera, selectCamera } = useCameras();
const activeSubTab = ref('trends'); // 'trends' | 'history'
const selectedTimeRange = ref('30d'); // 'today' | '7d' | '30d' | 'custom'
const customDateRange = ref(null); // [ 'YYYY-MM-DD', 'YYYY-MM-DD' ]

const exportingXlsx = ref(false);
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
