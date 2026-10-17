<template>
  <el-dialog
    v-model="isAddCameraOpen"
    :title="t('cameras.newCameraModal')"
    width="460px"
    append-to-body
  >
    <!-- A CamOS camera was just added: what to type into its portal (shown once) -->
    <div v-if="provisioning" class="flex flex-col gap-3" data-test="provisioning">
      <el-alert type="success" :closable="false" show-icon :title="t('cameras.provisioning.title', { serial: provisioning.deviceSerial })" :description="t('cameras.provisioning.intro')" />
      <el-descriptions :column="1" size="small" border>
        <el-descriptions-item v-for="row in provisioningRows" :key="row.key" :label="t(`cameras.provisioning.${row.key}`)">
          <div class="flex items-center justify-between gap-2 min-w-0">
            <code class="prov-value truncate" :title="row.value">{{ row.value || '--' }}</code>
            <el-button v-if="row.value" link size="small" :type="copied === row.key ? 'success' : 'primary'" :icon="copied === row.key ? Check : DocumentCopy" @click="copy(row.key, row.value)" />
          </div>
        </el-descriptions-item>
      </el-descriptions>
      <p class="prov-hint">{{ t('cameras.provisioning.expires', { time: new Date(provisioning.expiresAt).toLocaleString() }) }}</p>
    </div>

    <template v-else>
    <el-alert
      type="info"
      :closable="false"
      show-icon
      :title="newCameraForm.platform === 'camos' ? t('cameras.platformHint.camos') : t('cameras.connectPrompt')"
      class="mb-4"
    />

    <el-form label-position="top" @submit.prevent>
      <!-- EZVIZ cloud camera, or a CamOS trap camera on AWS IoT Core -->
      <el-form-item :label="t('cameras.platformLabel')">
        <el-radio-group v-model="newCameraForm.platform" data-test="platform">
          <el-radio-button v-for="p in ['ezviz', 'camos']" :key="p" :value="p">{{ t(`cameras.platform.${p}`) }}</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <!-- CamOS: scan the label QR (CAMOS:1;SN:...;VC:...;;) instead of typing -->
      <div v-if="newCameraForm.platform === 'camos'" class="flex flex-col gap-2 mb-4" data-test="camos-scan">
        <div v-if="scanning" class="add-scanner">
          <video ref="videoRef" autoplay playsinline muted class="w-full h-full object-cover"></video>
          <el-button class="add-scanner__stop" size="small" @click="stopScan">{{ t('common.cancel') }}</el-button>
        </div>
        <el-button v-else-if="canScan" :icon="Camera" class="w-full" data-test="scan" @click="startScan">{{ t('claim.scan') }}</el-button>
        <el-alert v-if="scanError" type="warning" :closable="false" show-icon :title="scanError" />
      </div>

      <el-form-item :label="t('cameras.serialNumber')">
        <el-input
          v-model="newCameraForm.deviceSerial"
          :placeholder="t('cameras.serialNumber')"
          :prefix-icon="VideoCamera"
          clearable
        />
      </el-form-item>

      <el-form-item :label="newCameraForm.platform === 'camos' ? t('claim.code') : t('cameras.validateCode')">
        <el-input
          v-model="newCameraForm.validateCode"
          :placeholder="t('cameras.codeDialogInputPlaceholder')"
          :prefix-icon="Lock"
          clearable
          show-password
        />
      </el-form-item>

      <!-- Glue card or lure trap: decides how counts are read -->
      <el-form-item :label="t('trapKind.label')">
        <el-radio-group v-model="newCameraForm.trapKind" class="trap-kind">
          <el-radio v-for="kind in ['sticky', 'lure']" :key="kind" :value="kind" border class="trap-kind__option">
            <div class="trap-kind__name">{{ t(`trapKind.${kind}.name`) }}</div>
            <div class="trap-kind__hint">{{ t(`trapKind.${kind}.hint`) }}</div>
          </el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    </template>

    <template #footer>
      <template v-if="provisioning">
        <el-button type="primary" @click="closeAddCameraModal">{{ t('cameras.provisioning.done') }}</el-button>
      </template>
      <template v-else>
        <el-button @click="closeAddCameraModal">
          {{ t('common.cancel') }}
        </el-button>
        <el-button
          type="primary"
          :icon="Plus"
          :loading="addingCamera"
          @click="submitAddCamera"
        >
          {{ t('cameras.addCameraBtn') }}
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Lock, VideoCamera, Check, DocumentCopy, Camera } from '@element-plus/icons-vue';
import { useCameras } from '@/composables/useCameras';
import { useClaimQrScan } from '@/composables/useClaimQrScan';

const { t } = useI18n();
const { isAddCameraOpen, addingCamera, newCameraForm, provisioning, closeAddCameraModal, submitAddCamera } = useCameras();

// A CamOS label QR fills the serial and the code; a camera that registered itself is then claimed on submit
const { canScan, scanning, scanError, videoRef, startScan, stopScan } = useClaimQrScan((parsed) => {
  if (parsed?.serial) newCameraForm.deviceSerial = parsed.serial;
  if (parsed?.verifyCode) newCameraForm.validateCode = parsed.verifyCode;
}, { failedText: t('claim.scanFailed') });
watch(() => [isAddCameraOpen.value, newCameraForm.platform], ([open, platform]) => {
  if (!open || platform !== 'camos') stopScan();
});

const provisioningRows = computed(() => {
  const p = provisioning.value || {};
  return [
    { key: 'token', value: p.provisionToken },
    { key: 'apiBase', value: p.apiBase },
    { key: 'iotEndpoint', value: p.iotEndpoint },
    { key: 'channel', value: p.kvs?.channelName },
    { key: 'qr', value: p.qr },
  ];
});
const copied = ref('');
const copy = async (key, value) => {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = key;
    setTimeout(() => { if (copied.value === key) copied.value = ''; }, 2000);
  } catch {
    // Clipboard not available (http): the value is on screen
  }
};
</script>

<style scoped>
.add-scanner {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 50vh;
  overflow: hidden;
  border-radius: 8px;
  background: #000;
}
.add-scanner__stop {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
}
.prov-value {
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.prov-hint {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.trap-kind {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.trap-kind__option {
  height: auto;
  margin-right: 0;
  padding: 10px 12px;
  width: 100%;
  white-space: normal;
  align-items: flex-start;
}
.trap-kind__name {
  font-weight: 600;
  line-height: 1.4;
}
.trap-kind__hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
