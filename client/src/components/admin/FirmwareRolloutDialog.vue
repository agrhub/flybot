<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('admin.firmware.rolloutTitle')"
    width="min(560px, 96vw)"
    append-to-body
    align-center
    data-test="rollout-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @open="open"
  >
    <div v-loading="loading">
      <template v-if="!result">
        <el-form label-position="top" @submit.prevent>
          <el-form-item :label="t('admin.firmware.release')">
            <el-select v-model="releaseId" class="w-full" :placeholder="t('admin.firmware.pickRelease')" :disabled="!!fixedRelease">
              <el-option v-for="r in choices" :key="r.id" :value="r.id" :label="`${r.model} ${r.version} · ${t(`firmware.channels.${r.channel || 'stable'}`)}${r.current ? ` (${t('admin.firmware.current')})` : ''}`" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('admin.firmware.targets')">
            <el-radio-group v-if="!serials.length" v-model="scope">
              <el-radio value="model">{{ t('admin.firmware.allOfModel', { model: release?.model || '', channel: t(`firmware.channels.${release?.channel || 'stable'}`) }) }}</el-radio>
            </el-radio-group>
            <p v-else class="rollout-meta">{{ t('admin.firmware.selectedCameras', { n: serials.length }) }}</p>
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="outdatedOnly">{{ t('admin.firmware.outdatedOnly') }}</el-checkbox>
          </el-form-item>
        </el-form>
        <el-alert v-if="models.length > 1" type="warning" :closable="false" show-icon :title="t('admin.firmware.mixedModels')" class="mb-3" />
        <el-alert v-if="!choices.length && !loading" type="info" :closable="false" show-icon :title="t('admin.firmware.noReleaseForModel')" class="mb-3" />
        <el-alert type="info" :closable="false" show-icon :title="t('admin.firmware.rolloutHint')" />
      </template>
      <template v-else>
        <el-result :icon="result.created ? 'success' : 'warning'" :title="t('admin.firmware.rolloutStarted', { n: result.created })" :sub-title="result.skipped.length ? t('admin.firmware.rolloutSkipped', { n: result.skipped.length }) : ''" />
        <el-table v-if="result.skipped.length" :data="result.skipped" size="small" max-height="240">
          <el-table-column :label="t('cameras.serialNumber')" prop="deviceSerial" min-width="160" />
          <el-table-column :label="t('admin.firmware.reason')" min-width="160">
            <template #default="{ row }">{{ t(`admin.firmware.skip.${row.reason}`) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </div>
    <template #footer>
      <template v-if="!result">
        <el-button @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="sending" :disabled="!releaseId" data-test="rollout-start" @click="start">{{ t('admin.firmware.startRollout') }}</el-button>
      </template>
      <el-button v-else type="primary" @click="emit('update:modelValue', false)">{{ t('common.done') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '@/services/api';
import { adminErrorText } from './adminErrors';

/**
 * Start a firmware update for chosen cameras (`serials`), or every camera of the release's model. Each camera
 * gets its own update; the server sends it when the camera is awake and charged.
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  serials: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] },
  fixedRelease: { type: Object, default: null }
});
const emit = defineEmits(['update:modelValue', 'done']);
const { t } = useI18n();

const releases = ref([]);
const releaseId = ref('');
const scope = ref('model');
const outdatedOnly = ref(true);
const loading = ref(false);
const sending = ref(false);
const result = ref(null);

const choices = computed(() => {
  if (props.fixedRelease) return [props.fixedRelease];
  return props.models.length ? releases.value.filter(r => props.models.includes(r.model)) : releases.value;
});
const release = computed(() => choices.value.find(r => r.id === releaseId.value) || null);

async function open() {
  result.value = null;
  outdatedOnly.value = true;
  if (props.fixedRelease) {
    releaseId.value = props.fixedRelease.id;
    return;
  }
  loading.value = true;
  try {
    releases.value = (await api.adminFirmware()).data.releases || [];
    releaseId.value = (choices.value.find(r => r.current) || choices.value[0])?.id || '';
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
}

async function start() {
  if (!release.value || sending.value) return;
  const n = props.serials.length;
  try {
    await ElMessageBox.confirm(
      n ? t('admin.firmware.rolloutConfirm', { n, version: release.value.version }) : t('admin.firmware.rolloutConfirmModel', { model: release.value.model, version: release.value.version, channel: t(`firmware.channels.${release.value.channel || 'stable'}`) }),
      t('admin.firmware.rolloutTitle'),
      { type: 'warning' }
    );
  } catch {
    return;
  }
  sending.value = true;
  try {
    const body = n ? { serials: props.serials, outdatedOnly: outdatedOnly.value } : { allOfModel: true, outdatedOnly: outdatedOnly.value };
    result.value = (await api.adminRolloutFirmware(release.value.id, body)).data;
    emit('done', result.value);
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    sending.value = false;
  }
}
</script>

<style scoped>
.rollout-meta {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
