<template>
  <el-dialog
    v-model="isAddCameraOpen"
    :title="cameraSetup ? t('cameras.camosSetup.title') : t('cameras.newCameraModal')"
    width="460px"
    append-to-body
    @closed="closeAddCameraModal"
  >
    <!-- AI camera added: put it on the network -->
    <CamosNetworkSetup
      v-if="cameraSetup"
      :device-serial="cameraSetup.deviceSerial"
      :provision="cameraSetup.provision"
      @online="loadCameras"
      @done="closeAddCameraModal"
    />

    <template v-else>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        :title="newCameraForm.provider === 'camos' ? t('cameras.connectPromptCamos') : t('cameras.connectPrompt')"
        class="mb-4"
      />

      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('cameras.provider.label')">
          <el-radio-group v-model="newCameraForm.provider">
            <el-radio-button value="ezviz">EZVIZ</el-radio-button>
            <el-radio-button value="camos">{{ t('cameras.provider.camos') }}</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item :label="t('cameras.serialNumber')">
          <div class="serial-row">
            <el-input
              v-model="newCameraForm.deviceSerial"
              :placeholder="t('cameras.serialNumber')"
              :prefix-icon="VideoCamera"
              clearable
              @input="fillFromLabel"
            />
            <QrScanButton @detected="onScanned" />
          </div>
        </el-form-item>

        <el-form-item :label="t('cameras.validateCode')">
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

    <template v-if="!cameraSetup" #footer>
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
  </el-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
import { Plus, Lock, VideoCamera } from '@element-plus/icons-vue';
import { useCameras } from '@/composables/useCameras';
import { parseCameraLabel } from '@/utils/camosQr';
import QrScanButton from '@/components/cameras/QrScanButton.vue';
import CamosNetworkSetup from '@/components/cameras/CamosNetworkSetup.vue';

const { t } = useI18n();
const { isAddCameraOpen, addingCamera, newCameraForm, cameraSetup, loadCameras, closeAddCameraModal, submitAddCamera } = useCameras();

// The text of an AI camera's label QR code (scanned, or pasted into the serial field) fills both fields
const fillFromLabel = (text) => {
  const label = parseCameraLabel(text);
  if (!label) return false;
  newCameraForm.provider = 'camos';
  newCameraForm.deviceSerial = label.serial;
  newCameraForm.validateCode = label.code;
  return true;
};

// Any other QR code is taken as the serial number
const onScanned = (text) => {
  if (!fillFromLabel(text)) newCameraForm.deviceSerial = String(text || '').trim();
};
</script>

<style scoped>
.serial-row {
  display: flex;
  gap: 8px;
  width: 100%;
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
