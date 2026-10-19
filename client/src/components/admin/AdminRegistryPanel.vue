<template>
  <div>
    <PageHeader :title="t('admin.registry.title')" :subtitle="t('admin.registry.subtitle')">
      <template #actions>
        <el-button :icon="Upload" @click="openImport">{{ t('admin.registry.import') }}</el-button>
        <el-button type="primary" :icon="Plus" @click="openAdd">{{ t('admin.registry.add') }}</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never" class="mb-4">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-3">
            <span class="admin-strong">{{ t('admin.registry.strict') }}</span>
            <el-switch :model-value="mode === 'strict'" :loading="savingMode" data-test="registry-strict" @change="setMode" />
          </div>
          <p class="admin-meta mt-1">{{ mode === 'strict' ? t('admin.registry.strictOn') : t('admin.registry.strictOff') }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <el-tag effect="plain" round>{{ t('admin.registry.countTotal', { n: counts.total }) }}</el-tag>
          <el-tag type="success" effect="light" round>{{ t('admin.registry.countAvailable', { n: counts.available }) }}</el-tag>
          <el-tag type="info" effect="light" round>{{ t('admin.registry.countClaimed', { n: counts.claimed }) }}</el-tag>
          <el-tag v-if="counts.disabled" type="danger" effect="light" round>{{ t('admin.registry.countDisabled', { n: counts.disabled }) }}</el-tag>
          <el-button size="small" :icon="Connection" :loading="backfilling" @click="backfill">{{ t('admin.registry.backfill') }}</el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <el-input v-model="filters.q" :placeholder="t('admin.registry.search')" :prefix-icon="Search" clearable class="!w-64" @input="debouncedLoad" @clear="reload" />
        <el-select v-model="filters.status" :placeholder="t('admin.registry.status')" clearable class="!w-40" @change="reload">
          <el-option v-for="s in STATUSES" :key="s" :value="s" :label="t(`admin.registry.statuses.${s}`)" />
        </el-select>
        <el-select v-model="filters.batch" :placeholder="t('admin.registry.batch')" clearable filterable class="!w-44" @change="reload">
          <el-option v-for="b in batches" :key="b" :value="b" :label="b" />
        </el-select>
        <el-button :icon="Refresh" @click="load">{{ t('common.refresh') }}</el-button>
      </div>

      <el-empty v-if="!loading && !entries.length" :description="t('admin.registry.empty')" />
      <el-table v-else v-loading="loading" :data="entries" row-key="serial" style="width: 100%" data-test="registry-table">
        <el-table-column :label="t('cameras.serialNumber')" min-width="170">
          <template #default="{ row }">
            <div class="font-mono admin-strong">{{ row.serial }}</div>
            <div v-if="row.model" class="admin-meta">{{ row.model }}<span v-if="row.hwVersion"> · {{ t('admin.fleet.hwVersion', { v: row.hwVersion }) }}</span></div>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.fleet.verifyCode')" width="130">
          <template #default="{ row }">
            <div class="flex items-center gap-1">
              <span class="font-mono">{{ row.verifyCodeMasked }}</span>
              <el-button link :icon="View" :aria-label="t('admin.fleet.reveal')" :title="t('admin.fleet.reveal')" @click="reveal(row)" />
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.registry.batch')" min-width="110">
          <template #default="{ row }">
            <span>{{ row.batch || '--' }}</span>
            <div v-if="row.note" class="admin-meta truncate">{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.registry.status')" min-width="190">
          <template #default="{ row }">
            <el-tag :type="STATUS_TYPES[row.status]" effect="light" round size="small">{{ t(`admin.registry.statuses.${row.status}`) }}</el-tag>
            <div v-if="row.claimedBy" class="admin-meta truncate mt-1">{{ row.claimedBy }} · {{ dateText(row.claimedAt) }}</div>
            <div v-if="row.disabled && row.disabledReason" class="admin-meta truncate mt-1">{{ row.disabledReason }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.registry.camera')" min-width="160">
          <template #default="{ row }">
            <template v-if="row.camera">
              <div class="truncate">{{ row.camera.deviceName }}</div>
              <div class="admin-meta truncate">{{ row.camera.owner || t('admin.fleet.states.unclaimed') }}</div>
            </template>
            <span v-else class="admin-meta">{{ t('admin.registry.notConnected') }}</span>
          </template>
        </el-table-column>
        <el-table-column width="70" align="right" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(cmd) => onCommand(cmd, row)">
              <el-button circle size="small" :icon="MoreFilled" :aria-label="t('common.moreActions')" />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit" :icon="Edit">{{ t('common.edit') }}</el-dropdown-item>
                  <el-dropdown-item v-if="!row.disabled" command="block" :icon="Lock">{{ t('admin.registry.block') }}</el-dropdown-item>
                  <el-dropdown-item v-else command="unblock" :icon="Unlock">{{ t('admin.registry.unblock') }}</el-dropdown-item>
                  <el-dropdown-item v-if="row.status !== 'claimed' && !row.camera?.owner" command="delete" :icon="Delete" divided>{{ t('common.delete') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="total > pageSize" class="flex justify-end mt-4">
        <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next" background size="small" @current-change="load" />
      </div>
    </el-card>

    <!-- Add / edit one serial -->
    <el-dialog v-model="formVisible" :title="editing ? t('admin.registry.editTitle', { serial: form.serial }) : t('admin.registry.add')" width="min(520px, 96vw)" align-center>
      <el-form label-position="top" @submit.prevent="submitForm">
        <el-form-item :label="t('cameras.serialNumber')">
          <el-input v-model="form.serial" :disabled="editing" placeholder="ESP1234567890AB" class="font-mono" />
        </el-form-item>
        <el-form-item :label="t('admin.fleet.verifyCode')">
          <el-input v-model="form.verifyCode" :placeholder="editing ? t('admin.registry.keepCode') : 'K7Q2MX'" class="font-mono" maxlength="32" />
        </el-form-item>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <el-form-item :label="t('admin.fleet.model')">
            <el-input v-model="form.model" placeholder="AIC-FREENOVE-S3CAM" maxlength="64" />
          </el-form-item>
          <el-form-item :label="t('admin.registry.hwVersion')">
            <el-input v-model="form.hwVersion" maxlength="32" />
          </el-form-item>
        </div>
        <el-form-item :label="t('admin.registry.batch')">
          <el-input v-model="form.batch" maxlength="64" />
        </el-form-item>
        <el-form-item :label="t('admin.registry.note')">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="300" />
        </el-form-item>
        <el-alert v-if="!editing" type="info" :closable="false" show-icon :title="t('admin.registry.labelHint')" />
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" :disabled="!form.serial.trim() || (!editing && !form.verifyCode.trim())" @click="submitForm">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- CSV / label import -->
    <el-dialog v-model="importVisible" :title="t('admin.registry.import')" width="min(680px, 96vw)" align-center>
      <p class="admin-meta mb-3">{{ t('admin.registry.importHint') }}</p>
      <el-upload :auto-upload="false" :show-file-list="false" accept=".csv,.txt,text/csv,text/plain" :on-change="readFile" class="mb-3">
        <el-button :icon="Document">{{ t('admin.registry.pickFile') }}</el-button>
      </el-upload>
      <el-input v-model="importText" type="textarea" :rows="8" class="font-mono" :placeholder="IMPORT_SAMPLE" data-test="registry-csv" @input="preview = null" />
      <div class="flex flex-wrap items-center gap-4 mt-3">
        <el-input v-model="importBatch" :placeholder="t('admin.registry.batchForAll')" class="!w-56" maxlength="64" />
        <el-checkbox v-model="importOverwrite">{{ t('admin.registry.overwrite') }}</el-checkbox>
      </div>
      <template v-if="preview">
        <el-alert :type="preview.errorCount ? 'warning' : 'success'" :closable="false" show-icon class="mt-3"
          :title="t(preview.dryRun ? 'admin.registry.previewResult' : 'admin.registry.importResult', { created: preview.created, updated: preview.updated, skipped: preview.skipped, errors: preview.errorCount })" />
        <el-table v-if="preview.errors.length" :data="preview.errors" size="small" max-height="200" class="mt-2">
          <el-table-column :label="t('admin.registry.line')" prop="line" width="70" />
          <el-table-column :label="t('cameras.serialNumber')" prop="serial" min-width="150" />
          <el-table-column :label="t('admin.firmware.reason')" min-width="200">
            <template #default="{ row }">{{ t(`admin.registry.rowErrors.${row.error}`) }}</template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button @click="importVisible = false">{{ t('common.close') }}</el-button>
        <el-button :loading="importing" :disabled="!importText.trim()" @click="runImport(true)">{{ t('admin.registry.check') }}</el-button>
        <el-button type="primary" :loading="importing" :disabled="!preview || !preview.dryRun || !(preview.created || preview.updated)" data-test="registry-import" @click="runImport(false)">
          {{ t('admin.registry.importNow') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh, Plus, Upload, View, MoreFilled, Edit, Lock, Unlock, Delete, Document, Connection } from '@element-plus/icons-vue';
import api from '@/services/api';
import PageHeader from '@/components/common/PageHeader.vue';
import { adminErrorText } from './adminErrors';

/**
 * The serial registry: cameras for sale, entered before a customer adds one with its serial and label code.
 * Strict mode refuses serials that are not in it; a blocked serial is refused in both modes.
 */
const { t, locale } = useI18n();

const STATUSES = ['available', 'claimed', 'disabled'];
const STATUS_TYPES = { available: 'success', claimed: 'info', disabled: 'danger' };
const IMPORT_SAMPLE = 'serial,verifyCode,model,hwVersion,batch,note\nESP1234567890AB,K7Q2MX,AIC-FREENOVE-S3CAM,1.0,LOT-01,\nCAMOS:1;SN:ESP1234567890AB;VC:K7Q2MX;M:AIC-FREENOVE-S3CAM;;';

const entries = ref([]);
const batches = ref([]);
const counts = ref({ total: 0, available: 0, claimed: 0, disabled: 0 });
const mode = ref('open');
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const filters = reactive({ q: '', status: '', batch: '' });

const load = async () => {
  loading.value = true;
  try {
    const res = await api.adminRegistry({ q: filters.q || undefined, status: filters.status || undefined, batch: filters.batch || undefined, page: page.value, limit: pageSize });
    entries.value = res.data.entries || [];
    batches.value = res.data.batches || [];
    counts.value = res.data.counts || counts.value;
    mode.value = res.data.mode || 'open';
    total.value = res.data.total || 0;
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
};
const reload = () => {
  page.value = 1;
  load();
};
let timer = null;
const debouncedLoad = () => {
  clearTimeout(timer);
  timer = setTimeout(reload, 350);
};
const dateText = (d) => (d ? new Date(d).toLocaleDateString(locale.value) : '');

// ---------- Mode ----------
const savingMode = ref(false);
const setMode = async (strict) => {
  if (strict) {
    try {
      await ElMessageBox.confirm(t('admin.registry.strictConfirm'), t('admin.registry.strict'), { type: 'warning' });
    } catch {
      return;
    }
  }
  savingMode.value = true;
  try {
    await api.updateAdminSettings({ registryMode: strict ? 'strict' : 'open' });
    mode.value = strict ? 'strict' : 'open';
    ElMessage.success(t('admin.saved'));
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    savingMode.value = false;
  }
};

const backfilling = ref(false);
const backfill = async () => {
  backfilling.value = true;
  try {
    const res = await api.adminBackfillRegistry();
    ElMessage.success(t('admin.registry.backfilled', { n: res.data.added }));
    load();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    backfilling.value = false;
  }
};

// ---------- One serial ----------
const formVisible = ref(false);
const editing = ref(false);
const saving = ref(false);
const form = reactive({ serial: '', verifyCode: '', model: '', hwVersion: '', batch: '', note: '' });
const openAdd = () => {
  Object.assign(form, { serial: '', verifyCode: '', model: '', hwVersion: '', batch: filters.batch || '', note: '' });
  editing.value = false;
  formVisible.value = true;
};
const openEdit = (row) => {
  Object.assign(form, { serial: row.serial, verifyCode: '', model: row.model, hwVersion: row.hwVersion, batch: row.batch, note: row.note });
  editing.value = true;
  formVisible.value = true;
};
const submitForm = async () => {
  if (saving.value) return;
  saving.value = true;
  try {
    const data = { model: form.model.trim(), hwVersion: form.hwVersion.trim(), batch: form.batch.trim(), note: form.note.trim() };
    if (form.verifyCode.trim()) data.verifyCode = form.verifyCode.trim();
    if (editing.value) await api.adminUpdateRegistry(form.serial, data);
    else await api.adminAddRegistry({ serial: form.serial.trim(), ...data });
    ElMessage.success(t('admin.saved'));
    formVisible.value = false;
    load();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    saving.value = false;
  }
};

const reveal = async (row) => {
  try {
    await ElMessageBox.confirm(t('admin.fleet.revealConfirm', { name: row.serial }), t('admin.fleet.reveal'), { type: 'warning' });
  } catch {
    return;
  }
  try {
    const res = await api.adminRevealRegistryCode(row.serial);
    await ElMessageBox.alert(res.data.verifyCode, t('admin.fleet.codeOf', { serial: row.serial }), { confirmButtonText: t('common.close') });
  } catch (err) {
    if (err?.response) ElMessage.error(adminErrorText(t, err));
  }
};

const onCommand = async (cmd, row) => {
  if (cmd === 'edit') return openEdit(row);
  try {
    if (cmd === 'block') {
      const { value } = await ElMessageBox.prompt(t('admin.registry.blockHint'), t('admin.registry.block'), { inputPlaceholder: t('admin.fleet.pauseReason'), type: 'warning' });
      await api.adminUpdateRegistry(row.serial, { disabled: true, disabledReason: String(value || '').trim() });
    } else if (cmd === 'unblock') {
      await api.adminUpdateRegistry(row.serial, { disabled: false });
    } else if (cmd === 'delete') {
      await ElMessageBox.confirm(t('admin.registry.deleteConfirm', { serial: row.serial }), t('common.delete'), { type: 'warning' });
      await api.adminDeleteRegistry(row.serial);
    }
    ElMessage.success(t('admin.saved'));
    load();
  } catch (err) {
    if (err?.response) ElMessage.error(adminErrorText(t, err));
  }
};

// ---------- Import ----------
const importVisible = ref(false);
const importText = ref('');
const importBatch = ref('');
const importOverwrite = ref(false);
const importing = ref(false);
const preview = ref(null);
const openImport = () => {
  importText.value = '';
  importBatch.value = '';
  importOverwrite.value = false;
  preview.value = null;
  importVisible.value = true;
};
const readFile = async (file) => {
  if (!file?.raw) return;
  if (file.raw.size > 1024 * 1024) return ElMessage.error(t('admin.registry.fileTooLarge'));
  importText.value = await file.raw.text();
  preview.value = null;
};
const runImport = async (dryRun) => {
  importing.value = true;
  try {
    const res = await api.adminImportRegistry({ csv: importText.value, dryRun, overwrite: importOverwrite.value, batch: importBatch.value.trim() });
    preview.value = res.data;
    if (!dryRun) {
      ElMessage.success(t('admin.registry.importResult', { created: res.data.created, updated: res.data.updated, skipped: res.data.skipped, errors: res.data.errorCount }));
      load();
    }
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    importing.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.admin-strong {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.admin-meta {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
