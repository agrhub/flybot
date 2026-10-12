<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('share.cameraTitle', { name: camera?.deviceName || '' })"
    width="560px"
    align-center
    destroy-on-close
    @update:model-value="(value) => emit('update:modelValue', value)"
    @open="loadShares"
  >
    <p class="share-meta mb-4">{{ t('share.cameraDesc') }}</p>

    <el-form @submit.prevent="addShare">
      <div class="flex gap-2">
        <el-input
          v-model="email"
          type="email"
          :placeholder="t('share.emailPlaceholder')"
          :prefix-icon="Message"
          clearable
          @keyup.enter="addShare"
        />
        <el-button type="primary" :icon="Share" :loading="adding" :disabled="!email.trim()" @click="addShare">
          {{ t('share.add') }}
        </el-button>
      </div>
    </el-form>

    <el-divider />

    <div v-loading="loading">
      <el-empty v-if="!shares.length" :description="t('share.empty')" :image-size="64" />
      <el-table v-else :data="shares" size="small" style="width: 100%">
        <el-table-column :label="t('share.email')" min-width="200">
          <template #default="{ row }">
            <div class="flex items-center gap-2 min-w-0">
              <UserAvatar :src="row.avatar" :label="row.email" :size="24" />
              <span class="truncate">{{ row.email }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('share.status')" width="160">
          <template #default="{ row }">
            <ShareStatus :status="row.status" :email="row.email" />
          </template>
        </el-table-column>
        <el-table-column width="90" align="right">
          <template #default="{ row }">
            <el-tooltip v-if="row.viaFarm" :content="t('share.viaFarmHint')" placement="top">
              <el-tag type="info" effect="plain" size="small">{{ t('share.viaFarm') }}</el-tag>
            </el-tooltip>
            <el-tooltip v-else :content="t('share.remove')" placement="top">
              <el-button link type="danger" :icon="Delete" @click="removeShare(row)" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Share, Delete, Message } from '@element-plus/icons-vue';
import api from '@/services/api';
import ShareStatus from '@/components/common/ShareStatus.vue';
import UserAvatar from '@/components/common/UserAvatar.vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  camera: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'changed']);

const { t } = useI18n();
const shares = ref([]);
const email = ref('');
const loading = ref(false);
const adding = ref(false);

const errorText = (err) => {
  const code = err.response?.data?.code;
  if (code && ['SHARE_WITH_OWNER', 'ALREADY_SHARED'].includes(code)) return t(`share.errors.${code}`);
  return err.response?.data?.message || t('common.error');
};

const loadShares = async () => {
  if (!props.camera) return;
  loading.value = true;
  try {
    const res = await api.getCameraShares(props.camera.deviceSerial);
    shares.value = res.data.shares || [];
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
};

const addShare = async () => {
  const value = email.value.trim();
  if (!value || adding.value) return;
  adding.value = true;
  try {
    const res = await api.shareCamera(props.camera.deviceSerial, value);
    shares.value = res.data.shares || [];
    email.value = '';
    ElMessage.success(res.data.invited ? t('share.invited', { email: value }) : t('share.shared', { email: value }));
    emit('changed');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    adding.value = false;
  }
};

const removeShare = async (row) => {
  try {
    await ElMessageBox.confirm(t('share.removeConfirm', { email: row.email }), t('share.remove'), {
      type: 'warning',
      confirmButtonText: t('share.remove'),
      cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  try {
    const res = await api.unshareCamera(props.camera.deviceSerial, row.email);
    shares.value = res.data.shares || [];
    emit('changed');
  } catch (err) {
    ElMessage.error(errorText(err));
  }
};
</script>

<style scoped>
.share-meta {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
