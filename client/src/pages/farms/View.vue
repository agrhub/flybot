<template>
  <div class="w-full max-w-7xl mx-auto pb-12" v-loading="loading && !farm">
    <el-result v-if="notFound" icon="warning" :title="t('farms.notFound')">
      <template #extra>
        <el-button type="primary" :icon="Back" @click="router.push('/farms')">{{ t('farms.backToList') }}</el-button>
      </template>
    </el-result>

    <template v-else-if="farm">
      <PageHeader :title="farm.name" :subtitle="farm.description">
        <template #actions>
          <el-button :icon="Back" @click="router.push('/farms')">{{ t('farms.backToList') }}</el-button>
          <template v-if="farm.canEdit">
            <el-button :icon="Share" @click="shareVisible = true">{{ t('share.button') }}</el-button>
            <el-button type="primary" :icon="Plus" @click="openPlot()">{{ t('farms.addPlot') }}</el-button>
            <el-dropdown trigger="click" @command="onCommand">
              <el-button :icon="MoreFilled" circle />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename" :icon="Edit">{{ t('farms.rename') }}</el-dropdown-item>
                  <el-dropdown-item command="delete" :icon="Delete">{{ t('farms.delete') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </template>
      </PageHeader>

      <el-alert v-if="!farm.canEdit" type="info" :closable="false" show-icon class="mb-4" :title="t('farms.sharedHint', { owner: farm.owner.name || farm.owner.email })" />

      <el-card v-if="!plots.length" shadow="never">
        <el-empty :description="t('farms.noPlots')">
          <el-button v-if="farm.canEdit" type="primary" :icon="Plus" @click="openPlot()">{{ t('farms.addPlot') }}</el-button>
        </el-empty>
      </el-card>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <el-card v-for="plot in plots" :key="plot.id" shadow="never" class="plot-card" :style="{ '--plot-color': plot.color }">
          <template #header>
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="plot-swatch"></span>
                <span class="plot-title truncate">{{ plot.name }}</span>
                <el-tag :type="RISK_TAG[plot.stats?.risk || 'low']" effect="light" round size="small">{{ riskLabel(plot.stats?.risk) }}</el-tag>
              </div>
              <div v-if="farm.canEdit" class="flex items-center shrink-0">
                <el-button link :icon="VideoCamera" :title="t('farms.assignCameras')" @click="openAssign(plot)" />
                <el-button link :icon="Edit" :title="t('common.edit')" @click="openPlot(plot)" />
                <el-button link type="danger" :icon="Delete" :title="t('farms.deletePlot')" @click="removePlot(plot)" />
              </div>
            </div>
          </template>
          <p class="plot-meta">{{ [plot.crop, plot.areaHa ? `${plot.areaHa} ha` : ''].filter(Boolean).join(' · ') || '--' }}</p>
          <div class="grid grid-cols-3 gap-2 mt-3 text-center">
            <div>
              <div class="plot-value">{{ plot.stats?.cameras ?? 0 }}</div>
              <div class="plot-meta">{{ t('farms.stats.traps') }}</div>
            </div>
            <div>
              <div class="plot-value">{{ plot.stats?.latestAverage ?? 0 }}</div>
              <div class="plot-meta">{{ t('farms.stats.average') }}</div>
            </div>
            <div>
              <div class="plot-value">{{ plot.stats?.insects7d ?? 0 }}</div>
              <div class="plot-meta">{{ t('farms.stats.week') }}</div>
            </div>
          </div>
          <el-divider class="!my-3" />
          <div class="flex flex-wrap gap-1.5">
            <el-tag v-for="cam in camerasOf(plot)" :key="cam.deviceSerial" :type="cam.status === 1 ? 'success' : 'info'" effect="plain" size="small">{{ cam.deviceName }}</el-tag>
            <span v-if="!camerasOf(plot).length" class="plot-meta">{{ t('farms.noCameras') }}</span>
          </div>
          <p v-if="plot.alertThreshold" class="plot-meta mt-2">{{ t('farms.alertAt', { count: plot.alertThreshold }) }}</p>
        </el-card>
      </div>
    </template>

    <!-- Plot form -->
    <el-dialog v-model="plotVisible" :title="editingPlot ? t('farms.editPlot') : t('farms.addPlot')" width="640px" align-center destroy-on-close>
      <el-form label-position="top">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <el-form-item :label="t('farms.plotName')" required>
            <el-input v-model="plotForm.name" maxlength="80" />
          </el-form-item>
          <el-form-item :label="t('farms.crop')">
            <el-input v-model="plotForm.crop" maxlength="80" />
          </el-form-item>
          <el-form-item :label="t('farms.areaHa')">
            <el-input-number v-model="plotForm.areaHa" :min="0" :precision="2" :step="0.1" class="!w-full" />
          </el-form-item>
          <el-form-item :label="t('farms.alertThreshold')">
            <el-input-number v-model="plotForm.alertThreshold" :min="1" :max="10000" :step="1" step-strictly class="!w-full" :placeholder="t('farms.alertOff')" />
          </el-form-item>
        </div>
        <el-form-item :label="t('farms.color')">
          <el-color-picker v-model="plotForm.color" :predefine="COLORS" />
        </el-form-item>
        <el-form-item :label="t('farms.boundary.title')">
          <PlotBoundaryEditor
            v-if="plotVisible"
            v-model="plotForm.boundary"
            :color="plotForm.color"
            :cameras="cameras"
            :others="plots.filter(p => p.id !== editingPlot?.id)"
            class="w-full"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="plotVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" :disabled="!plotForm.name.trim()" @click="savePlot">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- Assign cameras -->
    <el-dialog v-model="assignVisible" :title="t('farms.assignTitle', { name: assignPlot?.name || '' })" width="520px" align-center>
      <p class="plot-meta mb-3">{{ t('farms.assignHint') }}</p>
      <el-select v-model="assignSerials" multiple filterable class="w-full" :placeholder="t('logbook.camerasPlaceholder')">
        <el-option v-for="cam in assignable" :key="cam.deviceSerial" :value="cam.deviceSerial" :label="cam.deviceName">
          <div class="flex items-center justify-between gap-3">
            <span class="truncate">{{ cam.deviceName }}</span>
            <span v-if="cam.plotId && cam.plotId !== assignPlot?.id" class="plot-meta">{{ placeOf(cam) }}</span>
          </div>
        </el-option>
      </el-select>
      <template #footer>
        <el-button @click="assignVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="saveAssign">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <EmailShareDialog
      v-if="farm?.canEdit"
      v-model="shareVisible"
      :title="t('farms.shareTitle', { name: farm.name })"
      :description="t('farms.shareDesc')"
      :shares="farm.sharedWith || []"
      :on-add="addShare"
      :on-remove="removeShare"
      @changed="(shares) => (farm.sharedWith = shares)"
    />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Back, Share, Plus, MoreFilled, Edit, Delete, VideoCamera } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';
import PageHeader from '@/components/common/PageHeader.vue';
import EmailShareDialog from '@/components/common/EmailShareDialog.vue';
import PlotBoundaryEditor from '@/components/farms/PlotBoundaryEditor.vue';

const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' };
// Plot colors (map overlays; the theme-only rule applies to UI chrome, not map data)
const COLORS = ['#3ecf8e', '#e6a23c', '#f56c6c', '#409eff', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { loadCameras } = useCameras();

const farm = ref(null);
const plots = ref([]);
const cameras = ref([]);
const assignable = ref([]);
const loading = ref(false);
const notFound = ref(false);
const saving = ref(false);

const riskLabel = (risk) => t(`farms.risk.${risk || 'low'}`);
const camerasOf = (plot) => cameras.value.filter(c => c.plotId === plot.id);
const placeOf = (cam) => (cam.farmId === farm.value?.id ? plots.value.find(p => p.id === cam.plotId)?.name : t('farms.otherFarm')) || '';
const errorText = (err) => err.response?.data?.message || t('common.error');

const load = async () => {
  loading.value = true;
  notFound.value = false;
  try {
    const res = await api.getFarm(route.params.id);
    farm.value = res.data.farm;
    plots.value = res.data.plots || [];
    cameras.value = res.data.cameras || [];
    assignable.value = res.data.assignable || [];
  } catch (err) {
    if (err.response?.status === 404) notFound.value = true;
    else ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
};

// ---------- Plots ----------
const plotVisible = ref(false);
const editingPlot = ref(null);
const plotForm = reactive({ name: '', crop: '', areaHa: null, alertThreshold: null, color: COLORS[0], boundary: [] });
const openPlot = (plot = null) => {
  editingPlot.value = plot;
  Object.assign(plotForm, plot
    ? { name: plot.name, crop: plot.crop, areaHa: plot.areaHa, alertThreshold: plot.alertThreshold, color: plot.color, boundary: [...(plot.boundary || [])] }
    : { name: '', crop: '', areaHa: null, alertThreshold: null, color: COLORS[plots.value.length % COLORS.length], boundary: [] });
  plotVisible.value = true;
};
const savePlot = async () => {
  if (plotForm.boundary.length > 0 && plotForm.boundary.length < 3) {
    ElMessage.warning(t('farms.boundary.needThree'));
    return;
  }
  saving.value = true;
  try {
    const body = {
      ...plotForm,
      name: plotForm.name.trim(),
      areaHa: typeof plotForm.areaHa === 'number' ? plotForm.areaHa : null,
      alertThreshold: Number.isInteger(plotForm.alertThreshold) ? plotForm.alertThreshold : null,
      color: (plotForm.color || COLORS[0]).toLowerCase()
    };
    if (editingPlot.value) await api.updatePlot(farm.value.id, editingPlot.value.id, body);
    else await api.createPlot(farm.value.id, body);
    plotVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
  }
};
const removePlot = async (plot) => {
  try {
    await ElMessageBox.confirm(t('farms.deletePlotConfirm', { name: plot.name }), t('farms.deletePlot'), { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') });
  } catch {
    return;
  }
  try {
    await api.deletePlot(farm.value.id, plot.id);
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  }
};

// ---------- Cameras in a plot ----------
const assignVisible = ref(false);
const assignPlot = ref(null);
const assignSerials = ref([]);
const openAssign = (plot) => {
  assignPlot.value = plot;
  assignSerials.value = camerasOf(plot).map(c => c.deviceSerial);
  assignVisible.value = true;
};
const saveAssign = async () => {
  saving.value = true;
  try {
    await api.setPlotCameras(farm.value.id, assignPlot.value.id, assignSerials.value);
    assignVisible.value = false;
    await load();
    loadCameras();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
  }
};

// ---------- Farm ----------
const onCommand = async (command) => {
  if (command === 'rename') {
    try {
      const { value } = await ElMessageBox.prompt(t('farms.name'), t('farms.rename'), {
        inputValue: farm.value.name, confirmButtonText: t('common.save'), cancelButtonText: t('common.cancel'),
        inputValidator: (v) => !!v && v.trim().length > 0 && v.length <= 80
      });
      await api.updateFarm(farm.value.id, { name: value.trim() });
      await load();
    } catch {}
    return;
  }
  try {
    await ElMessageBox.confirm(t('farms.deleteConfirm', { name: farm.value.name }), t('farms.delete'), { type: 'error', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') });
  } catch {
    return;
  }
  try {
    await api.deleteFarm(farm.value.id);
    loadCameras();
    router.push('/farms');
  } catch (err) {
    ElMessage.error(errorText(err));
  }
};

const addShare = async (email) => (await api.shareFarm(farm.value.id, email)).data;
const removeShare = async (email) => (await api.unshareFarm(farm.value.id, email)).data.shares;

onMounted(load);
watch(() => route.params.id, (id, old) => { if (id && id !== old) load(); });
</script>

<style scoped>
.plot-card :deep(.el-card__header) {
  border-top: 3px solid var(--plot-color);
}
.plot-swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
  background-color: var(--plot-color);
}
.plot-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.plot-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.plot-meta {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
