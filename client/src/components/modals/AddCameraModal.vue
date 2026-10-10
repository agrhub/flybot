<template>
  <el-dialog
    v-model="isAddCameraOpen"
    :title="t('cameras.newCameraModal')"
    width="460px"
    append-to-body
    class="rounded-3xl"
  >
    <div class="space-y-4 pt-1">
      <div class="bg-[var(--el-bg-color)] p-4 rounded-2xl border border-[var(--el-border-color)] text-xs text-[var(--el-text-color-secondary)] leading-relaxed flex items-start gap-3">
        <svg class="w-5 h-5 text-[var(--primary-green)] shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p>
          {{ t('cameras.connectPrompt') }}
        </p>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('cameras.serialNumber') }}</label>
          <el-input
            v-model="newCameraForm.deviceSerial"
            placeholder="VD: BE4089629..."
            size="large"
            clearable
          />
        </div>

        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('cameras.validateCode') }}</label>
          <el-input
            v-model="newCameraForm.validateCode"
            placeholder="VD: QOKYZO..."
            size="large"
            clearable
            show-password
          />
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2 pt-2">
        <el-button @click="closeAddCameraModal" size="default">
          {{ t('common.cancel') }}
        </el-button>
        <el-button
          type="primary"
          :loading="addingCamera"
          @click="submitAddCamera"
          size="default"
          class="!font-bold !rounded-xl"
        >
          {{ t('cameras.addCameraBtn') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
import { useCameras } from '@/composables/useCameras';

const { t } = useI18n();
const { isAddCameraOpen, addingCamera, newCameraForm, closeAddCameraModal, submitAddCamera } = useCameras();
</script>
