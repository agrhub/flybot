<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('admin.plans.title')" :subtitle="t('admin.plans.subtitle')" />
    <el-alert type="info" :closable="false" show-icon :title="t('admin.plans.placeholderNote')" />
    <div v-if="loading"><el-skeleton :rows="6" animated /></div>
    <el-card v-for="plan in plans" v-else :key="plan.code" shadow="never" :data-test="`admin-plan-${plan.code}`">
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <span class="font-semibold">{{ plan.code.toUpperCase() }}</span>
          <el-button v-if="isAdmin" type="primary" size="small" :loading="saving === plan.code" @click="save(plan)">{{ t('common.save') }}</el-button>
        </div>
      </template>
      <el-form label-position="top" :disabled="!isAdmin">
        <div class="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
          <el-form-item :label="t('admin.plans.name')"><el-input v-model="plan.name" maxlength="40" /></el-form-item>
          <el-form-item :label="t('admin.plans.priceNote')"><el-input v-model="plan.priceNote" maxlength="200" /></el-form-item>
          <el-form-item v-for="f in numberFields" :key="f.key" :label="f.label">
            <el-input-number v-model="plan[f.key]" :min="f.min" :max="f.max" class="!w-full" />
          </el-form-item>
        </div>
        <el-form-item :label="t('admin.plans.description')"><el-input v-model="plan.description" type="textarea" :rows="2" maxlength="500" /></el-form-item>
        <div class="flex flex-wrap gap-4">
          <el-checkbox v-for="f in ['telegram', 'pdfReports', 'apiAndWebhooks']" :key="f" v-model="plan.features[f]">{{ t(`plans.features.${f}`) }}</el-checkbox>
          <el-checkbox v-model="plan.visible">{{ t('admin.plans.visible') }}</el-checkbox>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import PageHeader from '@/components/common/PageHeader.vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { requestErrorText } from '@/utils/requestError';

/** Admin > Plans: what FREE / PRO / ENTERPRISE allow (support accounts read only). */
const { t } = useI18n();
const { isAdmin } = useAuth();
const plans = ref([]);
const loading = ref(true);
const saving = ref('');

const numberFields = computed(() => [
  { key: 'maxCameras', label: t('admin.plans.maxCameras'), min: 0, max: 100000 },
  { key: 'snapshotsPerDay', label: t('plans.fields.snapshotsPerDay'), min: 1, max: 1440 },
  { key: 'retentionDays', label: t('plans.fields.retentionDays'), min: 1, max: 3650 },
  { key: 'deepAnalysisPerMonth', label: t('admin.plans.deepPerMonth'), min: 0, max: 1000000 },
  { key: 'liveMinutesPerRequest', label: t('plans.fields.liveMinutes'), min: 1, max: 60 },
  { key: 'maxMembers', label: t('admin.plans.maxMembers'), min: 0, max: 100000 },
  { key: 'order', label: t('admin.plans.order'), min: 0, max: 100 }
]);

async function load() {
  loading.value = true;
  try {
    const res = await api.adminGetPlans();
    plans.value = (res.data?.plans || []).map(p => ({ ...p, features: { ...p.features } }));
  } finally {
    loading.value = false;
  }
}

async function save(plan) {
  saving.value = plan.code;
  try {
    const { code, ...body } = plan;
    await api.adminUpdatePlan(code, body);
    ElNotification({ title: t('common.success'), message: t('admin.plans.saved', { plan: plan.name }), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('common.error')), type: 'error' });
  } finally {
    saving.value = '';
  }
}

onMounted(load);
</script>
