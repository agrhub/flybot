<template>
  <el-dialog :model-value="modelValue" :title="t('logbook.import.title')" width="860px" align-center @update:model-value="(v) => emit('update:modelValue', v)" @closed="reset">
    <ol class="imp-steps">
      <li>
        {{ t('logbook.import.step1') }}
        <el-button link type="primary" :icon="Download" @click="downloadTemplate">{{ t('logbook.import.template') }}</el-button>
      </li>
      <li>{{ t('logbook.import.step2') }}</li>
      <li>{{ t('logbook.import.step3') }}</li>
    </ol>

    <div class="flex flex-wrap items-center gap-2 mt-3">
      <el-button :icon="Upload" :loading="reading" @click="fileInput?.click()">{{ t('logbook.import.pick') }}</el-button>
      <input ref="fileInput" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden" tabindex="-1" aria-hidden="true" @change="readFile" />
      <span v-if="fileName" class="imp-meta">{{ fileName }}</span>
    </div>

    <el-alert v-if="missing.length" type="error" :closable="false" show-icon class="mt-3"
      :title="t('logbook.import.missingColumns', { columns: missing.map((f) => t(`logbook.import.columns.${f}`)).join(', ') })" />
    <el-alert v-if="truncated" type="warning" :closable="false" show-icon class="mt-3" :title="t('logbook.import.truncated', { max: MAX_ROWS })" />

    <template v-if="rows.length">
      <div class="flex flex-wrap gap-2 mt-4">
        <el-tag type="success" effect="light" round>{{ t('logbook.import.countReady', { count: counts.ready }) }}</el-tag>
        <el-tag v-if="counts.duplicate" type="info" effect="light" round>{{ t('logbook.import.countDuplicate', { count: counts.duplicate }) }}</el-tag>
        <el-tag v-if="counts.error" type="danger" effect="light" round>{{ t('logbook.import.countError', { count: counts.error }) }}</el-tag>
      </div>
      <el-table :data="rows" size="small" max-height="340" class="mt-3" style="width: 100%">
        <el-table-column :label="t('logbook.import.line')" prop="line" width="70" />
        <el-table-column :label="t('logbook.import.columns.date')" width="140">
          <template #default="{ row }">{{ row.body.at ? formatDate(row.body.at) : row.raw.date }}</template>
        </el-table-column>
        <el-table-column :label="t('logbook.import.columns.type')" width="130">
          <template #default="{ row }">{{ row.body.type ? t(`logbook.types.${row.body.type}`) : row.raw.type }}</template>
        </el-table-column>
        <el-table-column :label="t('logbook.import.columns.cameras')" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.raw.cameras }}</template>
        </el-table-column>
        <el-table-column :label="t('logbook.import.columns.product')" min-width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.body.product || '' }}</template>
        </el-table-column>
        <el-table-column :label="t('logbook.import.result')" min-width="220">
          <template #default="{ row }">
            <el-tag :type="STATUS_TAG[row.status]" effect="light" size="small">{{ t(`logbook.import.status.${row.status}`) }}</el-tag>
            <p v-for="(p, i) in row.messages" :key="i" class="imp-problem">{{ p }}</p>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t('common.close') }}</el-button>
      <el-button type="primary" :disabled="!counts.ready || done" :loading="importing" @click="runImport">
        {{ t('logbook.import.run', { count: counts.ready }) }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Download, Upload } from '@element-plus/icons-vue';
import api from '@/services/api';
import i18n from '@/i18n';
import { requestErrorText } from '@/utils/requestError';
import { loadExcelReader } from '@/utils/lazyLibs';
import { MAX_FILE_BYTES, MAX_ROWS, TYPES, FIELDS, parseCsv, toImportRows, templateCsv } from '@/utils/logImport';

const props = defineProps({
  modelValue: Boolean,
  // Traps the user can log work on
  cameras: { type: Array, default: () => [] }
});
const emit = defineEmits(['update:modelValue', 'imported']);
const { t, locale } = useI18n();

const STATUS_TAG = { ready: 'success', imported: 'success', duplicate: 'info', error: 'danger' };
const fileInput = ref(null);
const fileName = ref('');
const reading = ref(false);
const importing = ref(false);
const done = ref(false);
const missing = ref([]);
const truncated = ref(false);
const rows = ref([]);

const counts = computed(() => {
  const c = { ready: 0, duplicate: 0, error: 0 };
  for (const r of rows.value) c[r.status === 'imported' ? 'ready' : r.status]++;
  return c;
});

// Type names in both languages, so a sheet in either one is understood
const labelsByType = Object.fromEntries(TYPES.map((type) => [type, ['vi', 'en'].map((l) => i18n.global.getLocaleMessage(l)?.logbook?.types?.[type]).filter(Boolean)]));

const formatDate = (iso) => new Date(iso).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const reset = () => {
  fileName.value = '';
  missing.value = [];
  truncated.value = false;
  rows.value = [];
  done.value = false;
};

const downloadTemplate = () => {
  const headers = FIELDS.map((f) => t(`logbook.import.columns.${f}`));
  const example = t('logbook.import.example').split('|');
  const blob = new Blob([templateCsv(headers, example)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = t('logbook.import.templateFile');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

// Server checks (cameras, lengths, rows already logged): one code per row
const serverMessage = (result) => {
  if (result.code === 'TEXT_TOO_LONG') return t('logbook.import.problems.TEXT_TOO_LONG', { column: t(`logbook.import.columns.${result.field}`) });
  return t(`logbook.import.problems.${result.code}`, t('logbook.import.problems.INVALID_ROW'));
};

const check = async (dryRun) => {
  // Only rows the page understood go to the server; their results come back in the same order
  const sendable = rows.value.filter((r) => !r.problems.length);
  if (!sendable.length) return null;
  const res = await api.importTreatments({ rows: sendable.map((r) => r.body), dryRun });
  res.data.results.forEach((result, i) => {
    const row = sendable[i];
    row.status = result.status;
    row.messages = result.status === 'error' ? [serverMessage(result)] : result.status === 'duplicate' ? [t('logbook.import.problems.DUPLICATE')] : [];
  });
  return res.data.summary;
};

const readFile = async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  reset();
  if (file.size > MAX_FILE_BYTES) {
    ElMessage.error(t('logbook.import.tooBig'));
    return;
  }
  fileName.value = file.name;
  reading.value = true;
  try {
    const sheet = /\.xlsx$/i.test(file.name) ? await (await loadExcelReader())(file) : parseCsv(await file.text());
    const parsed = toImportRows(sheet, { cameras: props.cameras, labelsByType });
    missing.value = parsed.missing;
    truncated.value = !!parsed.truncated;
    rows.value = parsed.rows.map((r) => ({
      ...r,
      status: r.problems.length ? 'error' : 'ready',
      messages: r.problems.map((p) => t(`logbook.import.problems.${p.key}`, { value: p.value }))
    }));
    await check(true);
  } catch (err) {
    ElMessage.error(err?.response ? requestErrorText(t, err, t('common.error')) : t('logbook.import.unreadable'));
  } finally {
    reading.value = false;
  }
};

const runImport = async () => {
  importing.value = true;
  try {
    const summary = await check(false);
    done.value = true;
    ElMessage.success(t('logbook.import.done', { count: summary?.imported || 0 }));
    emit('imported');
  } catch (err) {
    ElMessage.error(requestErrorText(t, err, t('common.error')));
  } finally {
    importing.value = false;
  }
};
</script>

<style scoped>
.imp-steps {
  margin: 0;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
}
.imp-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.imp-problem {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-color-danger);
}
</style>
