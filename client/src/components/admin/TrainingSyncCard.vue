<template>
  <el-card shadow="never" class="mt-4" v-loading="loading">
    <template #header>
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="admin-label">{{ t('admin.training.title') }}</div>
          <p class="admin-meta mt-1">{{ t('admin.training.desc') }}</p>
        </div>
        <el-switch
          :aria-label="t('admin.training.title')"
          :model-value="!!sync?.enabled"
          :disabled="!sync?.configured"
          :loading="saving"
          @change="toggle"
        />
      </div>
    </template>

    <el-alert
      v-if="sync && !sync.configured"
      type="info"
      :title="t('admin.training.notConfigured')"
      :closable="false"
      show-icon
    />

    <template v-else-if="sync">
      <p class="admin-meta mb-3">{{ t('admin.training.project', { project: sync.project }) }}</p>
      <div class="grid grid-cols-3 gap-3">
        <div v-for="key in ['pending', 'uploaded', 'failed']" :key="key" class="training-stat">
          <span class="admin-meta">{{ t(`admin.training.counts.${key}`) }}</span>
          <span class="training-stat__value" :class="{ 'is-danger': key === 'failed' && sync.counts.failed }">{{ sync.counts[key] }}</span>
        </div>
      </div>
      <el-alert
        v-if="sync.lastError"
        class="mt-3"
        type="warning"
        :title="t('admin.training.lastError', { error: sync.lastError })"
        :closable="false"
        show-icon
      />
      <div class="flex flex-wrap items-center gap-3 mt-3">
        <el-button :icon="Upload" :loading="running" @click="runNow">{{ t('admin.training.runNow') }}</el-button>
        <span class="admin-meta">{{ t('admin.training.schedule') }}</span>
      </div>
    </template>
  </el-card>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Upload } from '@element-plus/icons-vue';
import api from '@/services/api';
import { adminErrorText } from './adminErrors';

const { t } = useI18n();
const sync = ref(null);
const loading = ref(false);
const saving = ref(false);
const running = ref(false);

const load = async () => {
  loading.value = true;
  try {
    sync.value = (await api.getTrainingSync()).data.sync;
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

const toggle = async (enabled) => {
  saving.value = true;
  try {
    await api.updateAdminSettings({ trainingSync: enabled });
    sync.value = { ...sync.value, enabled };
    ElMessage.success(t('admin.saved'));
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    saving.value = false;
  }
};

const runNow = async () => {
  running.value = true;
  try {
    const res = await api.runTrainingSync();
    sync.value = res.data.sync;
    const { uploaded = 0, failed = 0 } = res.data.result || {};
    ElMessage[failed ? 'warning' : 'success'](t('admin.training.ran', { uploaded, failed }));
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    running.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.admin-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.admin-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.training-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
.training-stat__value {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.training-stat__value.is-danger {
  color: var(--el-color-danger);
}
</style>
