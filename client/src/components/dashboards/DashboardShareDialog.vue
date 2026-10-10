<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('dashboards.share.title', { name: dashboard?.name || '' })"
    width="600px"
    align-center
    @update:model-value="(value) => emit('update:modelValue', value)"
  >
    <!-- Public link -->
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <div class="share-label">{{ t('dashboards.share.publicTitle') }}</div>
        <p class="share-meta">{{ t('dashboards.share.publicDesc') }}</p>
      </div>
      <el-switch :model-value="isPublic" :loading="savingVisibility" @change="setPublic" />
    </div>

    <div v-if="isPublic && publicUrl" class="mt-3">
      <el-input :model-value="publicUrl" readonly>
        <template #append>
          <el-button :icon="CopyDocument" @click="copyLink">{{ t('dashboards.share.copy') }}</el-button>
        </template>
      </el-input>
      <div class="flex items-center justify-between gap-2 mt-2">
        <span class="share-meta">{{ t('dashboards.share.publicHint') }}</span>
        <el-button link type="warning" :icon="RefreshRight" :loading="rotating" @click="rotate">
          {{ t('dashboards.share.rotate') }}
        </el-button>
      </div>
    </div>

    <el-divider />

    <!-- People -->
    <div class="share-label">{{ t('dashboards.share.peopleTitle') }}</div>
    <p class="share-meta mb-3">{{ t('dashboards.share.peopleDesc') }}</p>
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

    <el-empty v-if="!shares.length" :description="t('share.empty')" :image-size="56" />
    <el-table v-else :data="shares" size="small" class="mt-3" style="width: 100%">
      <el-table-column :label="t('share.email')" min-width="200" prop="email" />
      <el-table-column :label="t('share.status')" width="130">
        <template #default="{ row }">
          <el-tooltip :content="t(`share.statusHint.${row.status}`)" placement="top">
            <el-tag :type="row.status === 'active' ? 'success' : 'warning'" effect="light" round size="small">
              {{ t(`share.statusLabel.${row.status}`) }}
            </el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column width="60" align="right">
        <template #default="{ row }">
          <el-tooltip :content="t('share.remove')" placement="top">
            <el-button link type="danger" :icon="Delete" @click="removeShare(row)" />
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
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Share, Delete, Message, CopyDocument, RefreshRight } from '@element-plus/icons-vue';
import api from '@/services/api';
import { dashboardErrorText } from '@/utils/dashboards';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // Dashboard detail from the API (owner/admin view: has sharedWith and publicToken)
  dashboard: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'updated']);

const { t } = useI18n();
const email = ref('');
const adding = ref(false);
const savingVisibility = ref(false);
const rotating = ref(false);

const shares = computed(() => props.dashboard?.sharedWith || []);
const isPublic = computed(() => props.dashboard?.visibility === 'public');
const publicUrl = computed(() => (props.dashboard?.publicToken ? `${window.location.origin}/d/${props.dashboard.publicToken}` : ''));

const patch = (changes) => emit('updated', { ...props.dashboard, ...changes });

const setPublic = async (value) => {
  if (value) {
    try {
      await ElMessageBox.confirm(t('dashboards.share.publicConfirm'), t('dashboards.share.publicTitle'), {
        type: 'warning',
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
      });
    } catch {
      return;
    }
  }
  savingVisibility.value = true;
  try {
    const res = await api.updateDashboard(props.dashboard.id, { visibility: value ? 'public' : 'private' });
    emit('updated', res.data.dashboard);
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    savingVisibility.value = false;
  }
};

const copyLink = async () => {
  try {
    await navigator.clipboard.writeText(publicUrl.value);
    ElMessage.success(t('dashboards.share.copied'));
  } catch {
    ElMessage.warning(t('dashboards.share.copyFailed'));
  }
};

const rotate = async () => {
  try {
    await ElMessageBox.confirm(t('dashboards.share.rotateConfirm'), t('dashboards.share.rotate'), {
      type: 'warning',
      confirmButtonText: t('dashboards.share.rotate'),
      cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  rotating.value = true;
  try {
    const res = await api.rotateDashboardLink(props.dashboard.id);
    patch({ publicToken: res.data.publicToken });
    ElMessage.success(t('dashboards.share.rotated'));
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    rotating.value = false;
  }
};

const addShare = async () => {
  const value = email.value.trim();
  if (!value || adding.value) return;
  adding.value = true;
  try {
    const res = await api.shareDashboard(props.dashboard.id, value);
    patch({ sharedWith: res.data.shares || [] });
    email.value = '';
    ElMessage.success(res.data.invited ? t('share.invited', { email: value }) : t('share.shared', { email: value }));
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
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
    const res = await api.unshareDashboard(props.dashboard.id, row.email);
    patch({ sharedWith: res.data.shares || [] });
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  }
};
</script>

<style scoped>
.share-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.share-meta {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
