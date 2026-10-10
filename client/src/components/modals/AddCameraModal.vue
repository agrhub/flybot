<template>
  <el-dialog
    v-model="isAddCameraOpen"
    :title="t('cameras.newCameraModal')"
    width="460px"
    append-to-body
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      :title="t('cameras.connectPrompt')"
      class="mb-4"
    />

    <el-form label-position="top" @submit.prevent>
      <el-form-item :label="t('cameras.serialNumber')">
        <el-input
          v-model="newCameraForm.deviceSerial"
          :placeholder="t('cameras.serialNumber')"
          :prefix-icon="VideoCamera"
          clearable
        />
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
    </el-form>

    <template #footer>
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

const { t } = useI18n();
const { isAddCameraOpen, addingCamera, newCameraForm, closeAddCameraModal, submitAddCamera } = useCameras();
</script>
