<template>
  <el-card shadow="never" v-loading="loading" data-test="firmware-card">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="fw-title">{{ t('firmware.title') }}</span>
          <el-tag v-if="info?.updateAvailable && !openUpdate" type="warning" effect="light" round size="small">{{ t('firmware.available') }}</el-tag>
          <el-tag v-else-if="info?.latest && !info.updateAvailable && info.current" type="success" effect="light" round size="small">{{ t('firmware.upToDate') }}</el-tag>
          <el-tooltip v-if="info?.channel && info.channel !== 'stable'" :content="t(`firmware.channelHints.${info.channel}`)" placement="top">
            <el-tag :type="channelTagType(info.channel)" effect="plain" round size="small">{{ t('firmware.onChannel', { channel: t(`firmware.channels.${info.channel}`) }) }}</el-tag>
          </el-tooltip>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <el-button size="small" :icon="Refresh" :loading="checking" data-test="firmware-check" @click="check">{{ t('firmware.check') }}</el-button>
          <el-button v-if="info?.canUpdate" type="primary" size="small" :icon="Upload" :loading="starting" data-test="firmware-update" @click="install">
            {{ t('firmware.install', { v: info.latest.version }) }}
          </el-button>
          <el-button v-if="canInstallFile" size="small" :icon="FolderOpened" data-test="firmware-from-file" @click="openFileDialog">{{ t('firmware.fromFile') }}</el-button>
        </div>
      </div>
    </template>

    <template v-if="info">
      <el-descriptions :column="isWide ? 3 : 1" size="small">
        <el-descriptions-item :label="t('firmware.running')"><span class="font-mono">{{ info.current || '--' }}</span></el-descriptions-item>
        <el-descriptions-item v-if="info.platform === 'camos'" :label="t('firmware.latest')">
          <span class="font-mono">{{ info.latest?.version || '--' }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="info.model" :label="t('admin.fleet.model')">{{ info.model }}</el-descriptions-item>
      </el-descriptions>

      <!-- EZVIZ: its firmware is updated from the EZVIZ app -->
      <el-alert v-if="info.managedBy === 'ezviz'" type="info" :closable="false" show-icon :title="t('firmware.ezvizHint')" class="mt-3" />

      <!-- The update in progress, or how the last one ended -->
      <div v-if="info.update && (openUpdate || recentEnd)" class="mt-3">
        <div class="flex flex-wrap items-center gap-2">
          <el-tag :type="updateTagType(info.update.state)" effect="light" round size="small">{{ t(`firmware.states.${info.update.state}`) }}</el-tag>
          <span class="fw-meta font-mono">{{ info.update.fromVersion || '?' }} → {{ info.update.toVersion }}</span>
          <span v-if="info.update.state === 'pending' && info.update.waitReason" class="fw-meta">{{ t(`firmware.wait.${info.update.waitReason}`) }}</span>
        </div>
        <el-progress v-if="progress !== null && openUpdate" :percentage="progress" :stroke-width="8" class="mt-2" />
        <p v-if="info.update.error" class="fw-meta mt-1">{{ errorText(info.update.error) }}</p>
      </div>

      <!-- What the new release changes -->
      <div v-if="info.updateAvailable && info.latest?.notes" class="fw-notes mt-3">
        <p class="fw-meta mb-1">{{ t('firmware.whatsNew', { v: info.latest.version }) }}</p>
        <p class="fw-notes__text">{{ info.latest.notes }}</p>
      </div>

      <!-- Automatic updates -->
      <div v-if="info.platform === 'camos' && canManage" class="flex flex-wrap items-center gap-3 mt-4">
        <el-switch :model-value="info.autoUpdate" :loading="savingAuto" data-test="firmware-auto" :active-text="t('firmware.auto')" @change="(v) => saveAuto(v, info.autoHour)" />
        <template v-if="info.autoUpdate">
          <span class="fw-meta">{{ t('firmware.autoAround') }}</span>
          <el-select :model-value="info.autoHour" size="small" class="!w-28" :aria-label="t('firmware.autoAround')" @change="(h) => saveAuto(true, h)">
            <el-option v-for="h in 24" :key="h - 1" :value="h - 1" :label="`${String(h - 1).padStart(2, '0')}:00`" />
          </el-select>
        </template>
      </div>
      <p v-if="info.platform === 'camos' && canManage" class="fw-meta mt-2">{{ t('firmware.batteryHint', { pct: info.latest?.minBatteryPct ?? 40 }) }}</p>
    </template>
    <el-empty v-else-if="!loading" :description="t('firmware.none')" :image-size="48" />

    <!-- Admin: one build from a file, for this camera only (stored as Alpha, never made current here) -->
    <el-dialog v-model="fileDialog" :title="t('firmware.fromFileTitle', { name: camera.deviceName || camera.deviceSerial })" width="480px" append-to-body data-test="firmware-file-dialog">
      <el-alert type="info" :closable="false" show-icon :title="t('firmware.fromFileHint')" class="mb-4" />
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('firmware.file')" :error="fileError">
          <el-upload :auto-upload="false" :show-file-list="true" :limit="1" accept=".bin" :file-list="fileList" :on-change="pickFile" :on-remove="clearFile">
            <el-button :icon="FolderOpened">{{ t('firmware.pickFile') }}</el-button>
          </el-upload>
        </el-form-item>
        <el-form-item :label="t('firmware.version')">
          <el-input v-model="fileVersion" class="font-mono" placeholder="0.9.2" data-test="firmware-file-version" />
          <p class="fw-meta mt-1">{{ t('firmware.versionHint') }}</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="fileDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :icon="Upload" :loading="sendingFile" :disabled="!fileBytes || !fileVersion.trim() || !!fileError" data-test="firmware-file-install" @click="installFile">
          {{ t('firmware.installNow') }}
        </el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { FolderOpened, Refresh, Upload } from '@element-plus/icons-vue';
import api from '@/services/api';
import { isOpenUpdate, updateProgress, updateTagType, channelTagType, imageVersion } from '@/utils/firmware';
import { requestErrorText } from '@/utils/requestError';
import { useAuth } from '@/composables/useAuth';

/**
 * The camera's firmware: running and latest version, release notes, a check, a confirmed install (sent when the
 * camera is awake and charged), and automatic updates at a chosen hour. EZVIZ cameras show their version only.
 * An administrator can also install a build from a file on this one camera.
 */
const props = defineProps({
  camera: { type: Object, required: true }
});
const { t, te } = useI18n();

const info = ref(null);
const loading = ref(false);
const checking = ref(false);
const starting = ref(false);
const savingAuto = ref(false);
const isWide = computed(() => typeof window === 'undefined' || window.innerWidth >= 768);
const canManage = computed(() => props.camera?.canManage !== false && props.camera?.access !== 'demo');
const openUpdate = computed(() => isOpenUpdate(info.value?.update));
// A finished update is shown for a day
const recentEnd = computed(() => {
  const u = info.value?.update;
  return !!u?.finishedAt && Date.now() - new Date(u.finishedAt).getTime() < 24 * 3600 * 1000;
});
const progress = computed(() => updateProgress(info.value?.update));
const { isAdmin } = useAuth();
const canInstallFile = computed(() => isAdmin.value && info.value?.platform === 'camos' && !!(info.value.model || props.camera?.model));
const errorText = (code) => (te(`firmware.errors.${code}`) ? t(`firmware.errors.${code}`) : code);

async function load({ quiet = false } = {}) {
  if (!props.camera?.deviceSerial || props.camera.simulated) return;
  if (!quiet) loading.value = true;
  try {
    info.value = (await api.getCameraFirmware(props.camera.deviceSerial)).data;
  } catch {
    if (!quiet) info.value = null;
  } finally {
    loading.value = false;
  }
}

async function check() {
  checking.value = true;
  try {
    info.value = (await api.checkCameraFirmware(props.camera.deviceSerial)).data;
    ElMessage.success(info.value.updateAvailable ? t('firmware.foundNew', { v: info.value.latest.version }) : t('firmware.noNew'));
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  } finally {
    checking.value = false;
  }
}

async function install() {
  const i = info.value;
  const onBattery = i.power !== 'powered' && !!i.battery;
  try {
    await ElMessageBox.confirm(
      `${t('firmware.confirmText', { name: props.camera.deviceName, from: i.current || '?', to: i.latest.version })}${onBattery ? ` ${t('firmware.confirmBattery', { pct: i.latest.minBatteryPct ?? 40 })}` : ''}`,
      t('firmware.confirmTitle'),
      { type: 'warning', confirmButtonText: t('firmware.installNow'), cancelButtonText: t('common.cancel') }
    );
  } catch {
    return;
  }
  starting.value = true;
  try {
    const res = await api.updateCameraFirmware(props.camera.deviceSerial);
    ElMessage.success(res.data.state === 'pending' ? t('firmware.queued') : t('firmware.started'));
    await load({ quiet: true });
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  } finally {
    starting.value = false;
  }
}

async function saveAuto(enabled, hour) {
  savingAuto.value = true;
  try {
    const res = await api.setCameraFirmwareAuto(props.camera.deviceSerial, enabled, hour);
    ElMessage.success(enabled ? (res.data.queued ? t('firmware.autoQueued') : t('firmware.autoOn')) : t('firmware.autoOff'));
    await load({ quiet: true });
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  } finally {
    savingAuto.value = false;
  }
}

// ---------- Install from file (admin) ----------

const fileDialog = ref(false);
const fileList = ref([]);
const fileBytes = ref(null);
const fileName = ref('');
const fileVersion = ref('');
const fileError = ref('');
const sendingFile = ref(false);

function openFileDialog() {
  clearFile();
  fileDialog.value = true;
}
function clearFile() {
  fileList.value = [];
  fileBytes.value = null;
  fileName.value = '';
  fileVersion.value = '';
  fileError.value = '';
}
async function pickFile(file) {
  fileList.value = [file];
  fileName.value = file.name;
  const bytes = new Uint8Array(await file.raw.arrayBuffer());
  // The image header magic (the server checks it too)
  fileError.value = bytes[0] === 0xe9 ? '' : t('firmware.notImage');
  fileBytes.value = fileError.value ? null : bytes;
  fileVersion.value = imageVersion(bytes);
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

// Store the build (or reuse the same file stored before under that version), then an update for this camera only
async function installFile() {
  const model = info.value.model || props.camera.model;
  const version = fileVersion.value.trim().replace(/^v/i, '');
  sendingFile.value = true;
  try {
    let releaseId = null;
    try {
      const form = new FormData();
      form.append('model', model);
      form.append('version', version);
      form.append('channel', 'alpha');
      form.append('file', new Blob([fileBytes.value], { type: 'application/octet-stream' }), fileName.value || `${model}-${version}.bin`);
      releaseId = (await api.adminAddFirmware(form)).data.release.id;
    } catch (err) {
      if (err?.response?.data?.code !== 'EXISTS') throw err;
      const known = ((await api.adminFirmware()).data.releases || []).find((r) => r.model === model && r.version === version);
      if (!known || known.sha256 !== (await sha256Hex(fileBytes.value))) {
        ElMessage.error(t('firmware.otherFile', { v: version }));
        return;
      }
      releaseId = known.id;
    }
    const res = await api.adminRolloutFirmware(releaseId, { serials: [props.camera.deviceSerial], outdatedOnly: false });
    if (res.data.created) {
      ElMessage.success(t('firmware.fromFileSent', { v: version }));
      fileDialog.value = false;
    } else {
      const reason = res.data.skipped?.[0]?.reason;
      ElMessage.warning(t('firmware.fromFileSkipped', { reason: reason && te(`admin.firmware.skip.${reason}`) ? t(`admin.firmware.skip.${reason}`) : reason || '?' }));
    }
    await load({ quiet: true });
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  } finally {
    sendingFile.value = false;
  }
}

// An update moves on by itself: follow it while it is open
let poll = null;
watch(openUpdate, (open) => {
  clearInterval(poll);
  if (open) poll = setInterval(() => !document.hidden && load({ quiet: true }), 10000);
});
watch(() => props.camera?.deviceSerial, () => load(), { immediate: true });
onBeforeUnmount(() => clearInterval(poll));
</script>

<style scoped>
.fw-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.fw-meta {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.fw-notes {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.fw-notes__text {
  margin: 0;
  font-size: 13px;
  white-space: pre-line;
  color: var(--el-text-color-regular);
  max-height: 160px;
  overflow: auto;
}
</style>
