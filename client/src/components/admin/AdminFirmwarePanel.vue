<template>
  <div>
    <PageHeader :title="t('admin.firmware.title')" :subtitle="t('admin.firmware.subtitle')">
      <template #actions>
        <el-button type="primary" :icon="Plus" @click="openAdd">{{ t('admin.firmware.add') }}</el-button>
      </template>
    </PageHeader>

    <!-- Releases -->
    <el-card shadow="never" class="mb-4">
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <span class="admin-title">{{ t('admin.firmware.releases') }}</span>
          <el-button size="small" :icon="Refresh" @click="loadReleases">{{ t('common.refresh') }}</el-button>
        </div>
      </template>
      <el-empty v-if="!loadingReleases && !releases.length" :description="t('admin.firmware.noReleases')" />
      <el-table v-else v-loading="loadingReleases" :data="releases" row-key="id" style="width: 100%" data-test="firmware-releases">
        <el-table-column :label="t('admin.fleet.model')" prop="model" min-width="170" />
        <el-table-column :label="t('admin.firmware.version')" min-width="130">
          <template #default="{ row }">
            <span class="font-mono admin-strong">{{ row.version }}</span>
            <el-tag v-if="row.current" type="success" effect="dark" round size="small" class="ml-2">{{ t('admin.firmware.current') }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.firmware.file')" min-width="200">
          <template #default="{ row }">
            <div class="truncate">{{ formatSize(row.size) }} · {{ t(`admin.firmware.sources.${row.source?.kind || 'upload'}`) }}{{ row.source?.tag ? ` ${row.source.tag}` : '' }}</div>
            <el-tooltip :content="row.sha256" placement="top">
              <div class="admin-meta font-mono truncate">SHA-256 {{ row.sha256.slice(0, 16) }}…</div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.firmware.cameras')" width="110" align="center">
          <template #default="{ row }">{{ row.cameras }}</template>
        </el-table-column>
        <el-table-column :label="t('admin.firmware.added')" width="120">
          <template #default="{ row }"><span class="admin-meta">{{ dateText(row.createdAt) }}</span></template>
        </el-table-column>
        <el-table-column width="70" align="right" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(cmd) => onRelease(cmd, row)">
              <el-button circle size="small" :icon="MoreFilled" :aria-label="t('common.moreActions')" />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="!row.current" command="current" :icon="Star">{{ t('admin.firmware.makeCurrent') }}</el-dropdown-item>
                  <el-dropdown-item command="rollout" :icon="Upload">{{ t('admin.firmware.rolloutModel') }}</el-dropdown-item>
                  <el-dropdown-item command="notes" :icon="Edit">{{ t('admin.firmware.editNotes') }}</el-dropdown-item>
                  <el-dropdown-item v-if="!row.current" command="delete" :icon="Delete" divided>{{ t('common.delete') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Rollouts -->
    <el-card shadow="never">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="admin-title">{{ t('admin.firmware.updates') }}</span>
          <div class="flex flex-wrap items-center gap-2">
            <el-select v-model="updFilters.batchId" :placeholder="t('admin.firmware.batch')" clearable class="!w-64" size="small" @change="loadUpdates">
              <el-option v-for="b in batches" :key="b.batchId" :value="b.batchId" :label="`${b.model} ${b.toVersion} · ${dateText(b.createdAt)}`" />
            </el-select>
            <el-select v-model="updFilters.state" :placeholder="t('admin.fleet.state')" clearable class="!w-40" size="small" @change="loadUpdates">
              <el-option value="open" :label="t('admin.firmware.openOnly')" />
              <el-option v-for="s in UPDATE_STATES" :key="s" :value="s" :label="t(`firmware.states.${s}`)" />
            </el-select>
            <el-button size="small" :icon="Refresh" @click="loadUpdates">{{ t('common.refresh') }}</el-button>
          </div>
        </div>
      </template>

      <div v-if="batches.length" class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div v-for="b in batches.slice(0, 4)" :key="b.batchId" class="fw-batch" @click="selectBatch(b.batchId)">
          <div class="flex items-center justify-between gap-2">
            <span class="admin-strong truncate">{{ b.model }} → {{ b.toVersion }}</span>
            <span class="admin-meta">{{ dateText(b.createdAt) }}</span>
          </div>
          <el-progress :percentage="b.total ? Math.round((b.succeeded / b.total) * 100) : 0" :status="b.failed ? 'warning' : (b.open ? '' : 'success')" class="mt-2" />
          <div class="admin-meta mt-1">{{ t('admin.firmware.batchCounts', { ok: b.succeeded, failed: b.failed, open: b.open, total: b.total }) }}</div>
        </div>
      </div>

      <el-empty v-if="!loadingUpdates && !updates.length" :description="t('admin.firmware.noUpdates')" :image-size="64" />
      <el-table v-else v-loading="loadingUpdates" :data="updates" row-key="id" style="width: 100%" size="small" data-test="firmware-updates">
        <el-table-column :label="t('cameras.deviceName')" min-width="170">
          <template #default="{ row }">
            <div class="truncate">{{ row.deviceName || row.deviceSerial }}</div>
            <div class="admin-meta font-mono">{{ row.deviceSerial }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.firmware.version')" min-width="130">
          <template #default="{ row }"><span class="font-mono">{{ row.fromVersion || '?' }} → {{ row.toVersion }}</span></template>
        </el-table-column>
        <el-table-column :label="t('admin.fleet.state')" min-width="200">
          <template #default="{ row }">
            <el-tag :type="updateTagType(row.state)" effect="light" round size="small">{{ t(`firmware.states.${row.state}`) }}</el-tag>
            <span v-if="row.state === 'pending' && row.waitReason" class="admin-meta ml-2">{{ t(`firmware.wait.${row.waitReason}`) }}</span>
            <el-progress v-if="updateProgress(row) !== null && row.state !== 'succeeded'" :percentage="updateProgress(row)" :stroke-width="6" class="mt-1" />
            <el-tooltip v-if="row.error" :content="row.detail || row.error" placement="top">
              <div class="admin-meta truncate mt-1">{{ errorText(row.error) }}</div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.firmware.source')" width="120">
          <template #default="{ row }">{{ t(`firmware.sources.${row.source}`) }}</template>
        </el-table-column>
        <el-table-column :label="t('admin.firmware.updatedAt')" width="150">
          <template #default="{ row }"><span class="admin-meta">{{ new Date(row.updatedAt || row.createdAt).toLocaleString(locale) }}</span></template>
        </el-table-column>
        <el-table-column width="110" align="right">
          <template #default="{ row }">
            <el-button v-if="['pending', 'sent'].includes(row.state)" link type="danger" size="small" @click="cancel(row)">{{ t('common.cancel') }}</el-button>
            <el-button v-else-if="['failed', 'rolled_back', 'cancelled'].includes(row.state)" link type="primary" size="small" @click="retry(row)">{{ t('admin.firmware.retry') }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="updTotal > updPageSize" class="flex justify-end mt-4">
        <el-pagination v-model:current-page="updPage" :page-size="updPageSize" :total="updTotal" layout="total, prev, pager, next" background size="small" @current-change="loadUpdates" />
      </div>
    </el-card>

    <!-- Add a release -->
    <el-dialog v-model="addVisible" :title="t('admin.firmware.add')" width="min(600px, 96vw)" align-center>
      <el-tabs v-model="addMode">
        <el-tab-pane name="github" :label="t('admin.firmware.fromGithub')">
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="t('admin.firmware.githubTag')">
              <el-input v-model="addForm.githubTag" placeholder="v0.7.0" class="!w-48" />
            </el-form-item>
            <el-form-item :label="t('admin.firmware.repo')">
              <el-input v-model="addForm.repo" placeholder="agrhub/camos-esp32-trap" />
            </el-form-item>
            <el-alert type="info" :closable="false" show-icon :title="t('admin.firmware.githubHint')" />
          </el-form>
        </el-tab-pane>
        <el-tab-pane name="upload" :label="t('admin.firmware.fromFile')">
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="t('admin.firmware.file')">
              <el-upload :auto-upload="false" :limit="1" :on-change="pickFile" :on-remove="() => (addForm.file = null)" accept=".bin,application/octet-stream">
                <el-button :icon="Document">{{ t('admin.firmware.pickFile') }}</el-button>
              </el-upload>
            </el-form-item>
            <el-form-item label="SHA-256">
              <el-input v-model="addForm.sha256" :placeholder="t('admin.firmware.shaOptional')" class="font-mono" maxlength="64" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane name="url" :label="t('admin.firmware.fromUrl')">
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="t('admin.firmware.url')">
              <el-input v-model="addForm.url" placeholder="https://..." />
            </el-form-item>
            <el-form-item label="SHA-256">
              <el-input v-model="addForm.sha256" :placeholder="t('admin.firmware.shaOptional')" class="font-mono" maxlength="64" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
      <el-form v-if="addMode !== 'github'" label-position="top" @submit.prevent>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <el-form-item :label="t('admin.fleet.model')">
            <el-select v-model="addForm.model" filterable allow-create class="w-full">
              <el-option v-for="m in knownModels" :key="m" :value="m" :label="m" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('admin.firmware.version')">
            <el-input v-model="addForm.version" placeholder="0.7.0" />
          </el-form-item>
        </div>
        <el-form-item :label="t('admin.firmware.notesVi')">
          <el-input v-model="addForm.notesVi" type="textarea" :rows="3" maxlength="4000" />
        </el-form-item>
        <el-form-item :label="t('admin.firmware.notesEn')">
          <el-input v-model="addForm.notesEn" type="textarea" :rows="3" maxlength="4000" />
        </el-form-item>
      </el-form>
      <template v-if="githubResults">
        <el-table :data="githubResults" size="small" class="mt-3">
          <el-table-column :label="t('admin.firmware.board')" prop="board" width="110" />
          <el-table-column :label="t('admin.fleet.model')" prop="model" min-width="160" />
          <el-table-column :label="t('admin.firmware.version')" prop="version" width="100" />
          <el-table-column :label="t('admin.fleet.state')" min-width="140">
            <template #default="{ row }">
              <el-tag :type="row.status === 'added' ? 'success' : row.status === 'exists' ? 'info' : 'danger'" effect="light" round size="small">{{ t(`admin.firmware.importStatus.${row.status}`) }}</el-tag>
              <span v-if="row.error" class="admin-meta ml-1">{{ errorText(row.error) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button @click="addVisible = false">{{ t('common.close') }}</el-button>
        <el-button type="primary" :loading="adding" :disabled="!canAdd" data-test="firmware-add" @click="submitAdd">{{ t('admin.firmware.addNow') }}</el-button>
      </template>
    </el-dialog>

    <!-- Release notes -->
    <el-dialog v-model="notesVisible" :title="t('admin.firmware.editNotes')" width="min(560px, 96vw)" align-center>
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('admin.firmware.notesVi')">
          <el-input v-model="notesForm.vi" type="textarea" :rows="4" maxlength="4000" />
        </el-form-item>
        <el-form-item :label="t('admin.firmware.notesEn')">
          <el-input v-model="notesForm.en" type="textarea" :rows="4" maxlength="4000" />
        </el-form-item>
        <el-form-item :label="t('admin.firmware.minBattery')">
          <el-input-number v-model="notesForm.minBatteryPct" :min="0" :max="100" :step="5" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="notesVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="savingNotes" @click="saveNotes">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <FirmwareRolloutDialog v-model="rolloutVisible" :fixed-release="rolloutRelease" @done="onRolloutDone" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh, MoreFilled, Star, Upload, Edit, Delete, Document } from '@element-plus/icons-vue';
import api from '@/services/api';
import PageHeader from '@/components/common/PageHeader.vue';
import FirmwareRolloutDialog from './FirmwareRolloutDialog.vue';
import { adminErrorText } from './adminErrors';
import { formatSize, updateTagType, updateProgress } from '@/utils/firmware';

/**
 * Firmware of the CamOS cameras: builds per model (uploaded, from a URL, or a camos-esp32-trap GitHub release),
 * the current release per model, and the updates of each camera with their progress and result.
 */
const { t, te, locale } = useI18n();
const UPDATE_STATES = ['pending', 'sent', 'installing', 'rebooting', 'succeeded', 'failed', 'rolled_back', 'cancelled'];

const releases = ref([]);
const knownModels = ref([]);
const loadingReleases = ref(false);
const dateText = (d) => (d ? new Date(d).toLocaleDateString(locale.value) : '');
const errorText = (code) => (te(`firmware.errors.${code}`) ? t(`firmware.errors.${code}`) : code);

async function loadReleases() {
  loadingReleases.value = true;
  try {
    const res = await api.adminFirmware();
    releases.value = res.data.releases || [];
    knownModels.value = res.data.models || [];
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loadingReleases.value = false;
  }
}

// ---------- Updates ----------
const updates = ref([]);
const batches = ref([]);
const updTotal = ref(0);
const updPage = ref(1);
const updPageSize = 50;
const loadingUpdates = ref(false);
const updFilters = reactive({ batchId: '', state: '' });

async function loadUpdates({ quiet = false } = {}) {
  if (!quiet) loadingUpdates.value = true;
  try {
    const res = await api.adminFirmwareUpdates({ batchId: updFilters.batchId || undefined, state: updFilters.state || undefined, page: updPage.value, limit: updPageSize });
    updates.value = res.data.updates || [];
    batches.value = res.data.batches || [];
    updTotal.value = res.data.total || 0;
  } catch (err) {
    if (!quiet) ElMessage.error(adminErrorText(t, err));
  } finally {
    loadingUpdates.value = false;
  }
}
const selectBatch = (id) => {
  updFilters.batchId = id;
  updPage.value = 1;
  loadUpdates();
};

// Open updates move on their own: refresh while any is open
let poll = null;
const hasOpen = computed(() => updates.value.some(u => ['pending', 'sent', 'installing', 'rebooting'].includes(u.state)));
onMounted(() => {
  loadReleases();
  loadUpdates();
  poll = setInterval(() => {
    if (hasOpen.value && !document.hidden) loadUpdates({ quiet: true });
  }, 10000);
});
onBeforeUnmount(() => clearInterval(poll));

const cancel = async (row) => {
  try {
    await api.adminCancelFirmwareUpdate(row.id);
    loadUpdates();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  }
};
const retry = async (row) => {
  try {
    await api.adminRetryFirmwareUpdate(row.id);
    ElMessage.success(t('admin.firmware.retried'));
    loadUpdates();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  }
};

// ---------- Release actions ----------
const rolloutVisible = ref(false);
const rolloutRelease = ref(null);
const onRolloutDone = () => {
  updFilters.batchId = '';
  loadUpdates();
};

const notesVisible = ref(false);
const savingNotes = ref(false);
const notesForm = reactive({ id: '', vi: '', en: '', minBatteryPct: 40 });
const saveNotes = async () => {
  savingNotes.value = true;
  try {
    await api.adminUpdateFirmware(notesForm.id, { notes: { vi: notesForm.vi, en: notesForm.en }, minBatteryPct: notesForm.minBatteryPct });
    ElMessage.success(t('admin.saved'));
    notesVisible.value = false;
    loadReleases();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    savingNotes.value = false;
  }
};

async function onRelease(cmd, row) {
  if (cmd === 'rollout') {
    rolloutRelease.value = row;
    rolloutVisible.value = true;
    return;
  }
  if (cmd === 'notes') {
    Object.assign(notesForm, { id: row.id, vi: row.notes.vi, en: row.notes.en, minBatteryPct: row.minBatteryPct });
    notesVisible.value = true;
    return;
  }
  try {
    if (cmd === 'current') {
      await ElMessageBox.confirm(t('admin.firmware.makeCurrentConfirm', { model: row.model, version: row.version }), t('admin.firmware.makeCurrent'), { type: 'warning' });
      const res = await api.adminUpdateFirmware(row.id, { current: true });
      const a = res.data.announced || { notified: 0, scheduled: 0 };
      ElMessage.success(t('admin.firmware.announced', { notified: a.notified, scheduled: a.scheduled }));
    } else if (cmd === 'delete') {
      await ElMessageBox.confirm(t('admin.firmware.deleteConfirm', { model: row.model, version: row.version }), t('common.delete'), { type: 'warning' });
      await api.adminDeleteFirmware(row.id);
      ElMessage.success(t('admin.saved'));
    }
    loadReleases();
    loadUpdates();
  } catch (err) {
    if (err?.response) ElMessage.error(adminErrorText(t, err));
  }
}

// ---------- Add ----------
const addVisible = ref(false);
const addMode = ref('github');
const adding = ref(false);
const githubResults = ref(null);
const addForm = reactive({ githubTag: '', repo: '', file: null, url: '', sha256: '', model: '', version: '', notesVi: '', notesEn: '' });
const openAdd = () => {
  Object.assign(addForm, { githubTag: '', repo: '', file: null, url: '', sha256: '', model: knownModels.value[0] || '', version: '', notesVi: '', notesEn: '' });
  githubResults.value = null;
  addVisible.value = true;
};
const pickFile = (file) => {
  addForm.file = file?.raw || null;
  // camos-esp32-trap-<board>-v<version>-update.bin: fill in the version
  const m = String(file?.name || '').match(/-v(\d+\.\d+\.\d+[A-Za-z0-9.+-]*)-update\.bin$/);
  if (m && !addForm.version) addForm.version = m[1];
};
const canAdd = computed(() => {
  if (addMode.value === 'github') return !!addForm.githubTag.trim();
  const base = addForm.model && addForm.version.trim();
  return addMode.value === 'upload' ? !!(base && addForm.file) : !!(base && addForm.url.trim());
});
async function submitAdd() {
  if (!canAdd.value || adding.value) return;
  adding.value = true;
  try {
    let res;
    if (addMode.value === 'github') {
      res = await api.adminAddFirmware({ githubTag: addForm.githubTag.trim(), ...(addForm.repo.trim() ? { repo: addForm.repo.trim() } : {}) });
      githubResults.value = res.data.results || [];
    } else if (addMode.value === 'upload') {
      const data = new FormData();
      data.append('model', addForm.model);
      data.append('version', addForm.version.trim());
      if (addForm.sha256.trim()) data.append('sha256', addForm.sha256.trim().toLowerCase());
      data.append('notesVi', addForm.notesVi);
      data.append('notesEn', addForm.notesEn);
      data.append('file', addForm.file, addForm.file.name);
      res = await api.adminAddFirmware(data);
    } else {
      res = await api.adminAddFirmware({ url: addForm.url.trim(), model: addForm.model, version: addForm.version.trim(), ...(addForm.sha256.trim() ? { sha256: addForm.sha256.trim().toLowerCase() } : {}), notes: { vi: addForm.notesVi, en: addForm.notesEn } });
    }
    ElMessage.success(t('admin.saved'));
    if (addMode.value !== 'github') addVisible.value = false;
    loadReleases();
    return res;
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    adding.value = false;
  }
}
</script>

<style scoped>
.admin-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.admin-strong {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.admin-meta {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.fw-batch {
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  cursor: pointer;
}
.fw-batch:hover {
  border-color: var(--el-color-primary);
}
</style>
