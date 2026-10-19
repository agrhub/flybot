<template>
  <el-card shadow="never" class="mt-4" v-loading="loading" data-test="demo-access">
    <template #header>
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="admin-label">{{ t('admin.demo.title') }}</div>
          <p class="admin-meta mt-1">{{ t('admin.demo.desc') }}</p>
        </div>
        <el-switch v-model="form.demoViewEnabled" :aria-label="t('admin.demo.title')" data-test="demo-enabled" />
      </div>
    </template>

    <el-form label-position="top" class="max-w-xl" @submit.prevent="save">
      <el-form-item :label="t('admin.demo.cameras')">
        <el-select
          v-model="form.demoViewCameras"
          multiple
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          :multiple-limit="20"
          :placeholder="t('admin.demo.camerasPlaceholder')"
          class="w-full"
          data-test="demo-cameras"
        >
          <el-option v-for="c in cameras" :key="c.deviceSerial" :label="`${c.deviceName || c.deviceSerial} (${c.deviceSerial})`" :value="c.deviceSerial" />
        </el-select>
        <p class="admin-meta w-full mt-1">{{ t('admin.demo.camerasDesc') }}</p>
      </el-form-item>

      <el-form-item :label="t('admin.demo.audience')">
        <el-radio-group v-model="audience" data-test="demo-audience">
          <el-radio value="all">{{ t('admin.demo.audienceAll') }}</el-radio>
          <el-radio value="since">{{ t('admin.demo.audienceSince') }}</el-radio>
        </el-radio-group>
        <div v-if="audience === 'since'" class="w-full mt-2">
          <el-date-picker v-model="since" type="date" value-format="YYYY-MM-DD" :clearable="false" :placeholder="t('admin.demo.sincePlaceholder')" data-test="demo-since" />
        </div>
        <p class="admin-meta w-full mt-1">{{ t('admin.demo.audienceDesc') }}</p>
      </el-form-item>

      <el-form-item>
        <div class="flex items-start justify-between gap-4 w-full">
          <div class="min-w-0">
            <div class="admin-label">{{ t('admin.demo.live') }}</div>
            <p class="admin-meta">{{ t('admin.demo.liveDesc') }}</p>
          </div>
          <el-switch v-model="form.demoViewLive" :aria-label="t('admin.demo.live')" />
        </div>
      </el-form-item>

      <el-alert class="mb-4" type="info" :closable="false" show-icon :title="t('admin.demo.readOnly')" />

      <el-button type="primary" :loading="saving" :icon="Check" data-test="demo-save" @click="save">{{ t('common.save') }}</el-button>
    </el-form>
  </el-card>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Check } from '@element-plus/icons-vue';
import api from '@/services/api';
import { adminErrorText } from './adminErrors';

const { t } = useI18n();
const loading = ref(false);
const saving = ref(false);
const cameras = ref([]);
const form = reactive({ demoViewEnabled: false, demoViewCameras: [], demoViewLive: false });
// Who sees the demo cameras: every account, or accounts created on or after a date
const audience = ref('all');
const since = ref('');

const apply = (settings) => {
  form.demoViewEnabled = !!settings.demoViewEnabled;
  form.demoViewCameras = [...(settings.demoViewCameras || [])];
  form.demoViewLive = !!settings.demoViewLive;
  audience.value = settings.demoViewSince ? 'since' : 'all';
  since.value = settings.demoViewSince ? String(settings.demoViewSince).slice(0, 10) : '';
};

const load = async () => {
  loading.value = true;
  try {
    const [settings, list] = await Promise.all([api.getAdminSettings(), api.adminListCameras({ limit: 100 })]);
    apply(settings.data.settings);
    cameras.value = list.data.cameras || [];
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

const save = async () => {
  if (audience.value === 'since' && !since.value) {
    ElMessage.warning(t('admin.demo.sinceRequired'));
    return;
  }
  saving.value = true;
  try {
    const res = await api.updateAdminSettings({
      ...form,
      demoViewCameras: form.demoViewCameras.map(s => String(s).trim()).filter(Boolean),
      demoViewSince: audience.value === 'since' ? since.value : null
    });
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
