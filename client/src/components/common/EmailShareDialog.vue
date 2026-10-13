<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="560px"
    align-center
    @update:model-value="(value) => emit('update:modelValue', value)"
  >
    <p v-if="description" class="share-meta mb-4">{{ description }}</p>
    <div class="flex gap-2">
      <el-input v-model="email" type="email" :placeholder="t('share.emailPlaceholder')" :prefix-icon="Message" clearable @keyup.enter="add" />
      <el-button type="primary" :icon="Share" :loading="adding" :disabled="!email.trim()" @click="add">{{ t('share.add') }}</el-button>
    </div>
    <el-divider />
    <el-empty v-if="!shares.length" :description="t('share.empty')" :image-size="56" />
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
      <el-table-column width="60" align="right">
        <template #default="{ row }">
          <el-tooltip :content="t('share.remove')" placement="top">
            <el-button :aria-label="t('share.remove')" link type="danger" :icon="Delete" @click="remove(row)" />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
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
import ShareStatus from '@/components/common/ShareStatus.vue';
import UserAvatar from '@/components/common/UserAvatar.vue';

// Share-by-email list for any item; the parent passes the API calls
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  shares: { type: Array, default: () => [] },
  // async (email) => { shares, invited }
  onAdd: { type: Function, required: true },
  // async (email) => shares
  onRemove: { type: Function, required: true },
});
const emit = defineEmits(['update:modelValue', 'changed']);

const { t } = useI18n();
const email = ref('');
const adding = ref(false);

const errorText = (err) => {
  const code = err.response?.data?.code;
  if (['SHARE_WITH_OWNER', 'ALREADY_SHARED'].includes(code)) return t(`share.errors.${code}`);
  return err.response?.data?.message || t('common.error');
};

const add = async () => {
  const value = email.value.trim();
  if (!value || adding.value) return;
  adding.value = true;
  try {
    const result = await props.onAdd(value);
    email.value = '';
    emit('changed', result.shares);
    ElMessage.success(result.invited ? t('share.invited', { email: value }) : t('share.shared', { email: value }));
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    adding.value = false;
  }
};

const remove = async (row) => {
  try {
    await ElMessageBox.confirm(t('share.removeConfirm', { email: row.email }), t('share.remove'), {
      type: 'warning', confirmButtonText: t('share.remove'), cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  try {
    emit('changed', await props.onRemove(row.email));
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
