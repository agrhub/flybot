<template>
  <div>
    <PageHeader :title="t('admin.system.title')" :subtitle="t('admin.system.subtitle')" />

    <el-card shadow="never" v-loading="loading">
      <el-form label-position="top" class="max-w-xl" @submit.prevent="save">
        <el-form-item>
          <div class="flex items-start justify-between gap-4 w-full">
            <div class="min-w-0">
              <div class="admin-label">{{ t('admin.system.allowRegistration') }}</div>
              <p class="admin-meta">{{ t('admin.system.allowRegistrationDesc') }}</p>
            </div>
            <el-switch v-model="form.allowRegistration" />
          </div>
        </el-form-item>

        <el-divider />

        <el-form-item :label="t('admin.system.retentionMonths')">
          <div class="flex items-center gap-2">
            <el-input-number v-model="form.retentionMonths" :min="1" :max="60" :step="1" step-strictly />
            <span class="admin-meta">{{ t('admin.system.months') }}</span>
          </div>
          <p class="admin-meta w-full mt-1">{{ t('admin.system.retentionDesc') }}</p>
        </el-form-item>

        <el-form-item :label="t('admin.system.defaultThreshold')">
          <div class="flex items-center gap-2">
            <el-input-number v-model="form.defaultAlertThreshold" :min="1" :max="10000" :step="1" step-strictly />
            <span class="admin-meta">{{ t('settings.thresholdUnit') }}</span>
          </div>
          <p class="admin-meta w-full mt-1">{{ t('admin.system.defaultThresholdDesc') }}</p>
        </el-form-item>

        <div class="flex items-center gap-3">
          <el-button type="primary" :loading="saving" :icon="Check" @click="save">{{ t('common.save') }}</el-button>
          <span v-if="updatedAt" class="admin-meta">{{ t('admin.system.updatedAt', { time: formatDateTime(updatedAt) }) }}</span>
        </div>
      </el-form>
    </el-card>

    <TrainingSyncCard />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Check } from '@element-plus/icons-vue';
import api from '@/services/api';
import PageHeader from '@/components/common/PageHeader.vue';
import { adminErrorText } from './adminErrors';
import TrainingSyncCard from './TrainingSyncCard.vue';

const { t, locale } = useI18n();
const loading = ref(false);
const saving = ref(false);
const updatedAt = ref(null);
const form = reactive({ allowRegistration: true, retentionMonths: 12, defaultAlertThreshold: 15 });

const formatDateTime = (value) => new Date(value).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US');

const apply = (settings) => {
  form.allowRegistration = !!settings.allowRegistration;
  form.retentionMonths = settings.retentionMonths;
  form.defaultAlertThreshold = settings.defaultAlertThreshold;
  updatedAt.value = settings.updatedAt;
};

const load = async () => {
  loading.value = true;
  try {
    const res = await api.getAdminSettings();
    apply(res.data.settings);
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

const save = async () => {
  saving.value = true;
  try {
    const res = await api.updateAdminSettings({ ...form });
    apply(res.data.settings);
    ElMessage.success(t('admin.saved'));
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    saving.value = false;
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
</style>
