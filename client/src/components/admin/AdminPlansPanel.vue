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
        <!-- Online prices (0 = not sold online in that currency) -->
        <template v-if="plan.code !== 'free'">
          <p class="admin-plans__prices">{{ t('admin.plans.prices') }}</p>
          <div v-for="c in PRICE_CURRENCIES" :key="c" class="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4" :data-test="`admin-plan-${plan.code}-prices-${c}`">
            <el-form-item v-for="f in priceFields" :key="f" :label="`${t(`admin.plans.price.${f}`)} (${c})`">
              <el-input-number v-model="plan.priceInput[c][f]" :min="0" :precision="c === 'USD' ? 2 : 0" :step="c === 'USD' ? 1 : 10000" controls-position="right" class="!w-full" />
            </el-form-item>
          </div>
        </template>
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
import { fromMinor, toMinor, PRICE_CURRENCIES } from '@/utils/money';

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

// Online prices: the form shows whole units (199000 VND, 9.00 USD); the server keeps the smallest unit
const priceFields = ['month', 'year', 'addonMonth', 'addonYear'];
const toInput = (prices = {}) => Object.fromEntries(PRICE_CURRENCIES.map(c => [c, Object.fromEntries(priceFields.map(f => [f, fromMinor(prices[c]?.[f], c)]))]));
const fromInput = (input) => Object.fromEntries(PRICE_CURRENCIES.map(c => [c, Object.fromEntries(priceFields.map(f => [f, toMinor(input[c][f], c)]))]));

async function load() {
  loading.value = true;
  try {
    const res = await api.adminGetPlans();
    plans.value = (res.data?.plans || []).map(p => ({ ...p, features: { ...p.features }, priceInput: toInput(p.prices) }));
  } finally {
    loading.value = false;
  }
}

async function save(plan) {
  saving.value = plan.code;
  try {
    const { code, priceInput, ...body } = plan;
    // Whole units in the form, the smallest unit on the server (FREE has no price)
    if (code === 'free') delete body.prices;
    else body.prices = fromInput(priceInput);
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

<style scoped>
.admin-plans__prices {
  margin: 16px 0 4px;
  font-size: 13px;
  font-weight: 600;
}
</style>
