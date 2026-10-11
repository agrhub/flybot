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

<style scoped>
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
