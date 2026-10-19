<template>
  <el-card shadow="never" class="history-card">
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="section-title">{{ title || t('analytics.tabHistory') }}</div>
          <div class="section-subtitle">{{ t('history.subtitle') }}</div>
        </div>
        <el-dropdown trigger="click" :disabled="exporting" @command="runExport">
          <el-button type="primary" plain :icon="Download" :loading="exporting">
            {{ exporting ? progressText : t('history.export') }}
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="pdf" :icon="Document" :disabled="!total">{{ t('history.exportPdf') }}</el-dropdown-item>
              <el-dropdown-item command="xlsx" :icon="Grid" :disabled="!total">{{ t('history.exportXlsx') }}</el-dropdown-item>
              <el-dropdown-item command="corrections" :icon="Files" divided>
                <el-tooltip :content="t('analytics.review.exportHint')" placement="left">
                  <span>{{ t('analytics.review.export') }}</span>
                </el-tooltip>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <!-- This table's own filters -->
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <el-select :aria-label="t('analytics.allCameras')"
          v-if="showCameraFilter"
          v-model="filters.cameras"
          multiple
          collapse-tags
          collapse-tags-tooltip
          filterable
          clearable
          :placeholder="t('analytics.allCameras')"
          class="history-cameras"
        >
          <template #prefix><el-icon><VideoCamera /></el-icon></template>
          <el-option v-for="cam in cameraOptions" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial" />
        </el-select>
        <DateRangeFilter v-model="filters.range" />
        <el-select :aria-label="t('history.allStatus')" v-model="filters.risk" clearable :placeholder="t('history.allStatus')" class="history-select">
          <template #prefix><el-icon><Bell /></el-icon></template>
          <el-option v-for="risk in RISKS" :key="risk" :label="t(`history.risk.${risk}`)" :value="risk" />
        </el-select>
        <el-select :aria-label="t('history.allReviews')" v-model="filters.review" clearable :placeholder="t('history.allReviews')" class="history-select">
          <el-option v-for="review in REVIEWS" :key="review" :label="t(`history.review.${review}`)" :value="review" />
        </el-select>
        <el-button v-if="diverged" link type="primary" :icon="RefreshLeft" @click="resetToDefaults">{{ t('filters.useShared') }}</el-button>
      </div>
    </template>

    <el-table
      v-loading="loading"
      :element-loading-text="t('common.loading')"
      :data="records"
      row-key="_id"
      class="history-table w-full"
      @row-click="openModal"
    >
      <template #empty>
        <el-empty :description="t('analytics.noData')" :image-size="80" />
      </template>

      <el-table-column :label="t('analytics.time')" min-width="160">
        <template #default="{ row }">
          <span class="meta-text whitespace-nowrap">{{ formatDate(row.createdAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column v-if="multiCamera" :label="t('history.colCamera')" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="count-text">{{ row.deviceName || row.deviceSerial }}</span>
        </template>
      </el-table-column>

      <el-table-column :label="t('analytics.image')" width="100">
        <template #default="{ row }">
          <el-image :src="api.getImageUrl(row.imageUrl || row.s3Key)" :alt="t('analytics.image')" fit="cover" loading="lazy" class="thumb" />
        </template>
      </el-table-column>

      <el-table-column :label="t('analytics.totalCount')" width="110" align="center">
        <template #default="{ row }">
          <span class="count-text">{{ row.pestCount ?? 0 }}</span>
          <span class="meta-text"> / {{ row.threshold ?? '--' }}</span>
          <!-- A simulated photo: the flies drawn on it, to compare with the AI's count (not a detection) -->
          <el-tooltip v-if="row.simulated" :content="t('simulated.truthHint')" placement="top">
            <div><el-tag type="warning" effect="plain" size="small" class="mt-1" data-test="simulated-truth">{{ t('simulated.truth', { n: row.simulation?.truth ?? '--' }) }}</el-tag></div>
          </el-tooltip>
        </template>
      </el-table-column>

      <el-table-column :label="t('history.colAlarm')" width="130">
        <template #default="{ row }">
          <el-tag :type="RISK_TAG[row.risk] || 'info'" effect="light" size="small" round>{{ t(`history.risk.${row.risk || 'low'}`) }}</el-tag>
        </template>
      </el-table-column>

      <el-table-column :label="t('analytics.speciesBreakdown')" min-width="190">
        <template #default="{ row }">
          <div class="flex flex-wrap gap-1">
            <el-tag v-for="(count, name) in (row.aiResults?.summary || {})" :key="name" type="success" effect="light" size="small" round>
              {{ speciesName(name, t) }}: {{ count }}
            </el-tag>
            <span v-if="!Object.keys(row.aiResults?.summary || {}).length" class="meta-text">--</span>
            <el-tag v-if="row.review?.status" :type="row.review.status === 'corrected' ? 'warning' : 'info'" effect="plain" size="small" round>
              {{ t(`analytics.review.status.${row.review.status}`) }}
            </el-tag>
          </div>
        </template>
      </el-table-column>

      <el-table-column :label="t('analytics.aiRemarks')" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="meta-text">{{ row.aiResults?.raw_description || '--' }}</span>
        </template>
      </el-table-column>

      <el-table-column :label="t('common.actions')" width="80" align="center" fixed="right">
        <template #default="{ row }">
          <el-tooltip :content="t('analytics.inspectSnapshot')" placement="top">
            <el-button :aria-label="t('analytics.inspectSnapshot')" :icon="View" circle size="small" @click.stop="openModal(row)" />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <div class="flex flex-col sm:flex-row items-center justify-between gap-4 mt-4">
      <p class="meta-text">
        {{ t('common.showing') }} <strong>{{ records.length }}</strong> {{ t('common.of') }}
        <strong>{{ total }}</strong> {{ t('dashboard.recordsUnit') }}
      </p>
      <el-pagination
        background
        :layout="isMobile ? 'prev, pager, next' : 'sizes, prev, pager, next'"
        :pager-count="isMobile ? 5 : 7"
        :size="isMobile ? 'small' : 'default'"
        :page-sizes="[10, 20, 50, 100]"
        :current-page="page"
        :page-size="pageSize"
        :total="total"
        :hide-on-single-page="total <= 10"
        @current-change="goToPage"
        @size-change="setPageSize"
      />
    </div>

    <DetectionModal :visible="modalVisible" :item="selectedItem" @close="closeModal" @updated="onSnapshotUpdated" />
  </el-card>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessageBox, ElNotification } from 'element-plus';
import { Bell, Document, Download, Files, Grid, RefreshLeft, VideoCamera, View } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';
import { useBreakpoints } from '@/composables/useBreakpoints';
import DetectionModal from '@/components/modals/DetectionModal.vue';
import DateRangeFilter from '@/components/common/DateRangeFilter.vue';
import { speciesName } from '@/utils/species';
import { rangeDates, sameDateRange, dateRangeLabel } from '@/utils/dateRange';
import { fetchAllHistory, exportHistoryPdf, exportHistoryXlsx, exportCorrectionsJson } from '@/utils/historyExport';

/**
 * Detection history: every analyzed photo, with its own filters (cameras, dates, alarm status,
 * review) and exports of everything that matches them (PDF and Excel with the annotated photos).
 * On the analytics page the filters start from the page filters and follow them until changed here;
 * on a camera page `cameraSerials` fixes the camera.
 */
const props = defineProps({
  title: { type: String, default: '' },
  // Fixed cameras (camera page); null = pick among all cameras
  cameraSerials: { type: Array, default: null },
  // Page filters to start from: camera serial ('all' or one) and date range
  defaultCamera: { type: String, default: 'all' },
  defaultRange: { type: Object, default: () => ({ preset: '30d' }) },
});

const RISKS = ['high', 'moderate', 'low'];
const REVIEWS = ['none', 'confirmed', 'corrected'];
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' };
// Above this many photos, ask first: the export loads every photo
const LARGE_EXPORT = 300;

const { t, locale } = useI18n();
const { cameras } = useCameras();
const { isMobile } = useBreakpoints();

const camerasFromDefault = () => (props.defaultCamera && props.defaultCamera !== 'all' ? [props.defaultCamera] : []);
const filters = reactive({
  cameras: camerasFromDefault(),
  range: { ...props.defaultRange },
  risk: '',
  review: '',
});

const showCameraFilter = computed(() => !props.cameraSerials);
const cameraOptions = computed(() => cameras.value.filter(c => c.deviceSerial && c.deviceSerial !== 'all'));
const scopeSerials = computed(() => props.cameraSerials || filters.cameras);
// Camera column when the table can hold more than one camera
const multiCamera = computed(() => scopeSerials.value.length !== 1);

const diverged = computed(() => showCameraFilter.value && (
  !sameDateRange(filters.range, props.defaultRange)
  || filters.cameras.join(',') !== camerasFromDefault().join(',')
  || !!filters.risk || !!filters.review
));
const resetToDefaults = () => {
  filters.cameras = camerasFromDefault();
  filters.range = { ...props.defaultRange };
  filters.risk = '';
  filters.review = '';
};
// The page filters changed (by value, not just a new object from the parent): follow them
watch(() => [props.defaultCamera, props.defaultRange?.preset, props.defaultRange?.from, props.defaultRange?.to].join('|'), resetToDefaults);

// The request, as a string: refetch only when a filter really changes
const queryKey = computed(() => JSON.stringify([scopeSerials.value, filters.range, filters.risk, filters.review]));
const buildQuery = () => ({
  deviceSerials: scopeSerials.value,
  ...rangeDates(filters.range),
  risk: filters.risk || null,
  review: filters.review || null,
});

const records = ref([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);

const formatDate = (iso) => (iso ? new Date(iso).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US') : '--');

// Only the latest request may fill the table (an older, slower one is ignored)
let requestId = 0;
const fetchHistory = async () => {
  const id = ++requestId;
  loading.value = true;
  try {
    const res = await api.getHistory({ ...buildQuery(), page: page.value, limit: pageSize.value });
    if (id !== requestId) return;
    records.value = res.data?.results || [];
    total.value = res.data?.total || 0;
  } catch {
    if (id !== requestId) return;
    records.value = [];
    total.value = 0;
    ElNotification({ title: t('common.error'), message: t('analytics.historyLoadFailed'), type: 'error' });
  } finally {
    if (id === requestId) loading.value = false;
  }
};

watch(queryKey, () => {
  page.value = 1;
  fetchHistory();
});

const goToPage = (value) => {
  page.value = value;
  fetchHistory();
};
const setPageSize = (value) => {
  pageSize.value = value;
  page.value = 1;
  fetchHistory();
};

// ---------- Detail ----------
const modalVisible = ref(false);
const selectedItem = ref(null);
const openModal = (item) => {
  selectedItem.value = item;
  modalVisible.value = true;
};
const closeModal = () => {
  modalVisible.value = false;
  selectedItem.value = null;
};
const onSnapshotUpdated = (snapshot) => {
  records.value = records.value.map(r => (r._id === snapshot._id ? { ...r, ...snapshot } : r));
  if (selectedItem.value?._id === snapshot._id) selectedItem.value = { ...selectedItem.value, ...snapshot };
};

// ---------- Exports ----------
const exporting = ref(false);
const progress = reactive({ step: '', done: 0, total: 0 });
const progressText = computed(() => (progress.total ? t(`history.progress.${progress.step}`, { done: progress.done, total: progress.total }) : t('common.exporting')));

const cameraLabel = () => {
  if (!scopeSerials.value.length) return t('analytics.allCameras');
  return scopeSerials.value.map(s => cameras.value.find(c => c.deviceSerial === s)?.deviceName || s).join(', ');
};
const filterLines = () => [
  t('history.filterCameras', { cameras: cameraLabel() }),
  t('history.filterRange', { range: dateRangeLabel(t, filters.range) }),
  ...(filters.risk ? [t('history.filterRisk', { risk: t(`history.risk.${filters.risk}`) })] : []),
  ...(filters.review ? [t('history.filterReview', { review: t(`history.review.${filters.review}`) })] : []),
  t('analytics.report.exportedAt', { time: new Date().toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US') }),
];

/** Everything matching the filters, for this table's exports and the full analytics PDF. */
const loadAll = async () => {
  Object.assign(progress, { step: 'records', done: 0, total: total.value });
  return fetchAllHistory(buildQuery(), (done, all) => Object.assign(progress, { done, total: all }));
};

const runExport = async (kind) => {
  if (kind === 'corrections') {
    exporting.value = true;
    try {
      const count = await exportCorrectionsJson(90);
      ElNotification(count
        ? { title: t('common.success'), message: t('analytics.review.exported', { count }), type: 'success' }
        : { title: t('common.notice'), message: t('analytics.review.exportEmpty'), type: 'info' });
    } catch (err) {
      ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' });
    } finally {
      exporting.value = false;
    }
    return;
  }
  if (total.value > LARGE_EXPORT) {
    try {
      await ElMessageBox.confirm(t('history.largeExport', { count: total.value }), t('history.export'), {
        type: 'warning',
        confirmButtonText: t('history.export'),
        cancelButtonText: t('common.cancel'),
      });
    } catch {
      return;
    }
  }
  exporting.value = true;
  try {
    const items = await loadAll();
    Object.assign(progress, { step: 'images', done: 0, total: items.length });
    const onProgress = (done, all) => Object.assign(progress, { done, total: all });
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'pdf') {
      await exportHistoryPdf({
        t, locale: locale.value, items, onProgress,
        title: props.title || t('analytics.tabHistory'),
        lines: filterLines(),
        fileName: `FlyBot_History_${stamp}.pdf`,
      });
    } else {
      await exportHistoryXlsx({ t, locale: locale.value, items, onProgress, fileName: `FlyBot_History_${stamp}.xlsx` });
    }
    ElNotification({ title: t('common.success'), message: t('history.exported', { count: items.length }), type: 'success' });
  } catch (err) {
    console.error('History export failed:', err);
    ElNotification({ title: t('common.error'), message: t('history.exportFailed'), type: 'error' });
  } finally {
    exporting.value = false;
    Object.assign(progress, { step: '', done: 0, total: 0 });
  }
};

onMounted(fetchHistory);

defineExpose({ loadAll, filterLines, fetchHistory, total, LARGE_EXPORT });
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.meta-text strong {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.count-text {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.thumb {
  width: 64px;
  height: 40px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
  background-color: var(--el-fill-color-light);
  display: block;
}
.history-cameras {
  width: 240px;
}
.history-select {
  width: 170px;
}
.history-table :deep(.el-table__row) {
  cursor: pointer;
}
</style>
