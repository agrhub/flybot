<template>
  <div class="w-full max-w-7xl mx-auto pb-12" v-loading="loading && !dashboard">
    <el-result v-if="notFound" icon="warning" :title="t('dashboards.notFound')" :sub-title="t('dashboards.notFoundDesc')">
      <template #extra>
        <el-button type="primary" :icon="Back" @click="router.push('/reports')">{{ t('dashboards.backToList') }}</el-button>
      </template>
    </el-result>

    <template v-else-if="dashboard">
      <!-- Header -->
      <PageHeader :title="editing ? t('dashboards.editing', { name: dashboard.name }) : dashboard.name" :subtitle="editing ? '' : dashboard.description">
        <template #actions>
          <template v-if="!editing">
            <el-button :icon="Back" @click="router.push('/reports')">{{ t('dashboards.backToList') }}</el-button>
            <el-button :icon="Refresh" :loading="loadingData" @click="loadData">{{ t('common.refresh') }}</el-button>
            <el-button :icon="Download" :loading="exporting" :disabled="!widgetData || !dashboard.widgets.length" @click="exportPdf">{{ t('dashboards.exportPdf') }}</el-button>
            <template v-if="dashboard.canEdit">
              <el-button :icon="Share" @click="shareVisible = true">{{ t('share.button') }}</el-button>
              <el-button type="primary" :icon="Edit" @click="startEditing">{{ t('dashboards.edit') }}</el-button>
              <el-dropdown trigger="click" @command="onCommand">
                <el-button :icon="MoreFilled" circle />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="delete" :icon="Delete">{{ t('dashboards.delete') }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </template>
          <template v-else>
            <el-button @click="cancelEditing">{{ t('common.cancel') }}</el-button>
            <el-button type="primary" :icon="Check" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
          </template>
        </template>
      </PageHeader>

      <div v-if="!editing" class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <el-tag :type="dashboard.visibility === 'public' ? 'warning' : 'info'" effect="light" round size="small">
            {{ t(`dashboards.visibility.${dashboard.visibility}`) }}
          </el-tag>
          <el-tag v-if="dashboard.access === 'shared'" type="info" effect="plain" round size="small">
            {{ t('dashboards.sharedBy', { owner: dashboard.owner.name || dashboard.owner.email }) }}
          </el-tag>
          <el-tag v-if="dashboard.expiresAt" :type="dashboard.expired ? 'danger' : 'info'" effect="plain" round size="small">
            {{ dashboard.expired ? t('dashboards.expiry.expired') : t('dashboards.expiry.until', { time: formatDateTime(dashboard.expiresAt) }) }}
          </el-tag>
          <span v-if="generatedAt" class="dash-meta">{{ t('dashboards.updatedAt', { time: formatTime(generatedAt) }) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <ReportRangePicker v-model="viewRange" />
          <el-button v-if="dashboard.canEdit && !sameRange(viewRange, dashboard.range)" link type="primary" :loading="savingRange" @click="saveDefaultRange">
            {{ t('dashboards.saveDefaultRange') }}
          </el-button>
        </div>
      </div>

      <!-- Editor: dashboard settings -->
      <el-card v-if="editing" shadow="never" class="mb-4">
        <el-form label-position="top">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6">
            <el-form-item :label="t('dashboards.name')" required>
              <el-input v-model="draft.name" maxlength="80" show-word-limit />
            </el-form-item>
            <el-form-item :label="t('dashboards.cameras')">
              <el-select v-model="draft.cameraSerials" multiple collapse-tags collapse-tags-tooltip filterable class="w-full" :placeholder="t('dashboards.camerasPlaceholder')">
                <el-option v-for="cam in cameraOptions" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial">
                  <div class="flex items-center justify-between gap-3">
                    <span class="truncate">{{ cam.deviceName }}</span>
                    <el-tag v-if="cam.canManage === false" type="info" effect="plain" size="small">{{ t('share.accessShared') }}</el-tag>
                  </div>
                </el-option>
              </el-select>
            </el-form-item>
          </div>
          <el-form-item :label="t('dashboards.description')">
            <el-input v-model="draft.description" type="textarea" :rows="2" maxlength="500" />
          </el-form-item>
        </el-form>
        <el-alert
          v-if="hasSharedCameras"
          type="info"
          :closable="false"
          show-icon
          :title="t('dashboards.sharedCamerasHint')"
        />
        <div class="flex flex-wrap items-center gap-2 mt-4">
          <span class="dash-label">{{ t('dashboards.addWidget') }}:</span>
          <el-button v-for="type in WIDGET_TYPES" :key="type" size="small" :icon="Plus" @click="addWidget(type)">
            {{ t(`dashboards.widgetTypes.${type}`) }}
          </el-button>
        </div>
      </el-card>

      <!-- Widgets -->
      <el-card v-if="!currentWidgets.length" shadow="never">
        <el-empty :description="editing ? t('dashboards.noWidgetsEditing') : t('dashboards.noWidgets')">
          <el-button v-if="!editing && dashboard.canEdit" type="primary" :icon="Edit" @click="startEditing">{{ t('dashboards.edit') }}</el-button>
        </el-empty>
      </el-card>

      <DashboardGrid v-else ref="gridRef" :widgets="currentWidgets" :data="widgetData" :loading="loadingData" :range-days="dataRange?.days || 0">
        <template v-if="editing" #actions="{ widget }">
          <el-tooltip :content="t('dashboards.moveUp')" placement="top">
            <el-button text circle size="small" :icon="Top" :disabled="indexOf(widget) === 0" @click="move(widget, -1)" />
          </el-tooltip>
          <el-tooltip :content="t('dashboards.moveDown')" placement="top">
            <el-button text circle size="small" :icon="Bottom" :disabled="indexOf(widget) === draft.widgets.length - 1" @click="move(widget, 1)" />
          </el-tooltip>
          <el-tooltip :content="t('dashboards.editWidget')" placement="top">
            <el-button text circle size="small" :icon="Setting" @click="openWidget(widget)" />
          </el-tooltip>
          <el-tooltip :content="t('dashboards.removeWidget')" placement="top">
            <el-button text circle size="small" type="danger" :icon="Delete" @click="removeWidget(widget)" />
          </el-tooltip>
        </template>
      </DashboardGrid>
    </template>

    <!-- Widget settings -->
    <el-drawer v-model="widgetDrawer" :title="t('dashboards.editWidget')" size="380px">
      <el-form v-if="editingWidget" label-position="top">
        <el-form-item :label="t('dashboards.widgetType')">
          <el-select v-model="editingWidget.type" class="w-full">
            <el-option v-for="type in WIDGET_TYPES" :key="type" :label="t(`dashboards.widgetTypes.${type}`)" :value="type" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('dashboards.widgetTitle')">
          <el-input v-model="editingWidget.title" maxlength="80" :placeholder="t(`dashboards.widgetTypes.${editingWidget.type}`)" />
        </el-form-item>
        <el-form-item :label="t('dashboards.widgetCameras')">
          <el-select v-model="editingWidget.cameraSerials" multiple collapse-tags collapse-tags-tooltip class="w-full" :placeholder="t('dashboards.allDashboardCameras')">
            <el-option v-for="serial in draft.cameraSerials" :key="serial" :label="cameraName(serial)" :value="serial" />
          </el-select>
        </el-form-item>

        <!-- The widget's own filters -->
        <el-divider content-position="left">{{ t('filters.own') }}</el-divider>
        <el-form-item v-if="editingWidget.type !== 'latestSnapshot'" :label="t('dashboards.range')">
          <div class="flex flex-col gap-2 w-full">
            <el-radio-group :model-value="editingWidget.range ? 'own' : 'report'" @update:model-value="setWidgetRangeMode">
              <el-radio value="report">{{ t('dashboards.widgetRange.report') }}</el-radio>
              <el-radio value="own">{{ t('dashboards.widgetRange.own') }}</el-radio>
            </el-radio-group>
            <ReportRangePicker v-if="editingWidget.range" v-model="editingWidget.range" />
          </div>
        </el-form-item>
        <el-form-item v-if="['trend', 'catchesByTrap', 'dailyTable'].includes(editingWidget.type)" :label="t('filters.granularity')">
          <el-segmented v-model="editingWidget.granularity" :options="granularityOptions" />
        </el-form-item>
        <el-form-item :label="t('filters.status')">
          <el-select v-model="editingWidget.status" class="w-full">
            <el-option v-for="s in ['all', 'online', 'offline']" :key="s" :label="t(`filters.statuses.${s}`)" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('filters.threshold')">
          <el-select v-model="editingWidget.risk" class="w-full">
            <el-option v-for="r in ['all', 'high', 'moderate', 'low']" :key="r" :label="t(`filters.risks.${r}`)" :value="r" />
          </el-select>
        </el-form-item>

        <el-divider />
        <el-form-item :label="t('dashboards.width')">
          <el-segmented v-model="editingWidget.layout.w" :options="widthOptions" />
        </el-form-item>
        <el-form-item :label="t('dashboards.height')">
          <el-segmented v-model="editingWidget.layout.h" :options="heightOptions" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="widgetDrawer = false">{{ t('common.done') }}</el-button>
      </template>
    </el-drawer>

    <DashboardShareDialog v-model="shareVisible" :dashboard="dashboard" @updated="(d) => (dashboard = d)" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Back, Refresh, Share, Edit, Delete, MoreFilled, Check, Plus, Top, Bottom, Setting, Download,
} from '@element-plus/icons-vue';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';
import PageHeader from '@/components/common/PageHeader.vue';
import DashboardGrid from '@/components/dashboards/DashboardGrid.vue';
import DashboardShareDialog from '@/components/dashboards/DashboardShareDialog.vue';
import ReportRangePicker from '@/components/dashboards/ReportRangePicker.vue';
import {
  WIDGET_TYPES, WIDGET_WIDTHS, WIDGET_HEIGHTS, newWidget, dashboardErrorText, rangeQuery, sameRange,
} from '@/utils/dashboards';
import { exportReportPdf } from '@/utils/reportPdf';

const REFRESH_MS = 5 * 60 * 1000;

const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const { cameras } = useCameras();

const dashboard = ref(null);
const dashboardCameras = ref([]);
const widgetData = ref(null);
const generatedAt = ref(null);
const loading = ref(false);
const loadingData = ref(false);
const notFound = ref(false);
const shareVisible = ref(false);
// Range shown now (starts at the report's saved range) and the days the server used
const viewRange = ref({ preset: '7d' });
const dataRange = ref(null);
const savingRange = ref(false);
const exporting = ref(false);
const gridRef = ref(null);

const dateLocale = computed(() => (locale.value === 'vi' ? 'vi-VN' : 'en-US'));
const formatTime = (value) => new Date(value).toLocaleTimeString(dateLocale.value, { hour: '2-digit', minute: '2-digit' });
const formatDateTime = (value) => new Date(value).toLocaleString(dateLocale.value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const load = async () => {
  loading.value = true;
  notFound.value = false;
  try {
    const res = await api.getDashboard(route.params.id);
    dashboard.value = res.data.dashboard;
    dashboardCameras.value = res.data.cameras || [];
    const saved = res.data.dashboard.range || { preset: '7d' };
    // Same range: load here; another one: the watcher below loads
    if (sameRange(viewRange.value, saved)) loadData();
    viewRange.value = { ...saved };
    if (route.query.edit === '1' && dashboard.value.canEdit) startEditing();
  } catch (err) {
    if (err.response?.status === 404) notFound.value = true;
    else ElMessage.error(dashboardErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

const loadData = async () => {
  if (!dashboard.value) return;
  loadingData.value = true;
  try {
    const query = sameRange(viewRange.value, dashboard.value.range) ? null : rangeQuery(viewRange.value);
    const res = await api.getDashboardData(dashboard.value.id, query);
    widgetData.value = res.data.widgets || {};
    dataRange.value = res.data.range || null;
    generatedAt.value = res.data.generatedAt;
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    loadingData.value = false;
  }
};

watch(viewRange, (value, old) => {
  if (dashboard.value && !sameRange(value, old)) loadData();
}, { deep: true });

const saveDefaultRange = async () => {
  savingRange.value = true;
  try {
    const res = await api.updateDashboard(dashboard.value.id, { range: viewRange.value });
    dashboard.value = res.data.dashboard;
    ElMessage.success(t('dashboards.defaultRangeSaved'));
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    savingRange.value = false;
  }
};

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
      root: gridRef.value?.$el,
    });
  } catch (err) {
    console.error('Report PDF failed:', err);
    ElMessage.error(t('dashboards.pdfFailed'));
  } finally {
    exporting.value = false;
  }
};

// ---------- Editing ----------
const editing = ref(false);
const saving = ref(false);
const draft = reactive({ name: '', description: '', cameraSerials: [], widgets: [] });

const clone = (value) => JSON.parse(JSON.stringify(value));
const currentWidgets = computed(() => (editing.value ? draft.widgets.map((w, i) => ({ ...w, layout: { ...w.layout, x: 0, y: i } })) : dashboard.value?.widgets || []));

// Pickable cameras: everything you can see, plus cameras already on the dashboard
const cameraOptions = computed(() => {
  const list = [...cameras.value];
  for (const cam of dashboardCameras.value) {
    if (!list.some(c => c.deviceSerial === cam.deviceSerial)) list.push(cam);
  }
  return list;
});
const cameraName = (serial) => cameraOptions.value.find(c => c.deviceSerial === serial)?.deviceName || serial;
const hasSharedCameras = computed(() => draft.cameraSerials.some(s => cameras.value.find(c => c.deviceSerial === s)?.canManage === false));

const granularityOptions = computed(() => ['auto', 'day', 'week', 'month'].map(g => ({ value: g, label: t(`dashboards.granularity.${g}`) })));
const setWidgetRangeMode = (mode) => {
  editingWidget.value.range = mode === 'own' ? { preset: '30d' } : null;
};
const widthOptions = computed(() => WIDGET_WIDTHS.map(w => ({ value: w, label: t(`dashboards.widths.${w}`) })));
const heightOptions = computed(() => WIDGET_HEIGHTS.map(h => ({ value: h, label: t(`dashboards.heights.${h}`) })));

const startEditing = () => {
  draft.name = dashboard.value.name;
  draft.description = dashboard.value.description || '';
  draft.cameraSerials = [...dashboard.value.cameraSerials];
  draft.widgets = clone(dashboard.value.widgets).map(w => ({ range: null, granularity: 'auto', status: 'all', risk: 'all', ...w })).sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  editing.value = true;
};

const cancelEditing = () => {
  editing.value = false;
  if (route.query.edit) router.replace({ query: {} });
};

// Widget cameras must stay a subset of the dashboard cameras
watch(() => [...draft.cameraSerials], (serials) => {
  for (const w of draft.widgets) w.cameraSerials = w.cameraSerials.filter(s => serials.includes(s));
});

const indexOf = (widget) => draft.widgets.findIndex(w => w.id === widget.id);
const move = (widget, delta) => {
  const i = indexOf(widget);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= draft.widgets.length) return;
  const [item] = draft.widgets.splice(i, 1);
  draft.widgets.splice(j, 0, item);
};
const addWidget = (type) => {
  if (draft.widgets.length >= 20) {
    ElMessage.warning(t('dashboards.maxWidgets'));
    return;
  }
  draft.widgets.push(newWidget(type, draft.widgets.length));
};
const removeWidget = (widget) => {
  draft.widgets.splice(indexOf(widget), 1);
};

const widgetDrawer = ref(false);
const editingWidget = ref(null);
const openWidget = (widget) => {
  editingWidget.value = draft.widgets[indexOf(widget)];
  widgetDrawer.value = true;
};

const save = async () => {
  if (!draft.name.trim()) {
    ElMessage.warning(t('dashboards.nameRequired'));
    return;
  }
  saving.value = true;
  try {
    const res = await api.updateDashboard(dashboard.value.id, {
      name: draft.name.trim(),
      description: draft.description.trim(),
      cameraSerials: draft.cameraSerials,
      widgets: draft.widgets.map((w, i) => ({ ...w, layout: { x: 0, y: i, w: w.layout.w, h: w.layout.h } })),
    });
    dashboard.value = res.data.dashboard;
    editing.value = false;
    if (route.query.edit) router.replace({ query: {} });
    ElMessage.success(t('dashboards.saved'));
    // Camera names for the new selection, then fresh data
    load();
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    saving.value = false;
  }
};

const onCommand = async (command) => {
  if (command !== 'delete') return;
  try {
    await ElMessageBox.confirm(t('dashboards.deleteConfirm', { name: dashboard.value.name }), t('dashboards.delete'), {
      type: 'error',
      confirmButtonText: t('dashboards.delete'),
      cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  try {
    await api.deleteDashboard(dashboard.value.id);
    ElMessage.success(t('dashboards.deleted'));
    router.push('/reports');
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  }
};

// Keep the numbers fresh while the page is open (not while editing)
let timer = null;
onMounted(() => {
  load();
  timer = setInterval(() => {
    if (!editing.value && document.visibilityState === 'visible') loadData();
  }, REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));
watch(() => route.params.id, (id, old) => {
  if (id && id !== old) {
    editing.value = false;
    load();
  }
});
</script>

<style scoped>
.dash-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.dash-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
</style>
