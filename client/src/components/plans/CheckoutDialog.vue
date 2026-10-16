<template>
  <el-dialog v-model="state.open" :title="t('billing.checkout.title', { plan: plan?.name || planCode.toUpperCase() })" :width="isMobile ? '94%' : '460px'" append-to-body destroy-on-close data-test="checkout-dialog" @open="load">
    <div v-if="loading" class="py-4"><el-skeleton :rows="4" animated /></div>
    <el-alert v-else-if="!billing?.enabled" type="info" :closable="false" show-icon :title="t('billing.checkout.unavailable')" />
    <el-form v-else label-position="top" @submit.prevent>
      <el-form-item :label="t('billing.checkout.interval')">
        <el-radio-group v-model="form.interval" data-test="checkout-interval">
          <el-radio-button value="month">{{ t('billing.interval.month') }}</el-radio-button>
          <el-radio-button value="year">{{ t('billing.interval.year') }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('billing.checkout.addonCameras')">
        <el-input-number v-model="form.addonCameras" :min="0" :max="1000" :disabled="fixed" data-test="checkout-addons" />
      </el-form-item>
      <el-form-item v-if="billing.currencies.length > 1" :label="t('billing.checkout.currency')">
        <el-radio-group v-model="form.currency">
          <el-radio-button v-for="c in billing.currencies" :key="c" :value="c">{{ c }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('billing.checkout.method')">
        <el-radio-group v-model="form.provider" class="checkout-methods" data-test="checkout-provider">
          <el-radio v-for="p in providersForCurrency" :key="p.name" :value="p.name">
            {{ t(`billing.provider.${p.name}`) }}
            <span class="checkout-hint">{{ t(`billing.providerHint.${p.name}`) }}</span>
          </el-radio>
        </el-radio-group>
      </el-form-item>

      <div class="checkout-total" data-test="checkout-total">
        <span>{{ t('billing.checkout.total') }}</span>
        <strong v-if="total !== null">{{ formatMoney(total, form.currency, locale) }} / {{ t(`billing.interval.${form.interval}`) }}</strong>
        <span v-else class="checkout-hint">{{ t('billing.checkout.notForSale') }}</span>
      </div>
      <p class="checkout-hint mt-2">{{ t('billing.checkout.note', { days: billing.graceDays }) }}</p>
    </el-form>
    <template #footer>
      <el-button @click="closeCheckout">{{ t('common.cancel') }}</el-button>
      <el-button v-if="billing?.enabled" type="primary" :loading="busy" :disabled="total === null || !form.provider" data-test="checkout-pay" @click="pay">{{ t('billing.checkout.pay') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import api from '@/services/api';
import { useCheckout } from '@/composables/useCheckout';
import { formatMoney } from '@/utils/money';
import { requestErrorText } from '@/utils/requestError';
import { useBreakpoints } from '@/composables/useBreakpoints';

/** Pay for a plan online: interval, add-on cameras, currency, PayOS (VietQR) or Stripe (card). */
const { t, locale } = useI18n();
const { state, closeCheckout } = useCheckout();
const { isMobile } = useBreakpoints();

const loading = ref(false);
const busy = ref(false);
const billing = ref(null);
const plans = ref([]);
const form = reactive({ interval: 'month', addonCameras: 0, currency: 'VND', provider: '' });

const planCode = computed(() => state.options?.planCode || 'pro');
const fixed = computed(() => !!state.options?.upgradeRequestId);
const plan = computed(() => plans.value.find(p => p.code === planCode.value) || null);
const providersForCurrency = computed(() => (billing.value?.providers || []).filter(p => p.currencies.includes(form.currency)));

// What the server will charge (it computes the same from the plan; this is only shown)
const total = computed(() => {
  const prices = plan.value?.prices?.[form.currency];
  if (!prices) return null;
  const base = form.interval === 'year' ? prices.year : prices.month;
  const addon = form.interval === 'year' ? prices.addonYear : prices.addonMonth;
  if (!base || (form.addonCameras > 0 && !addon)) return null;
  return base + form.addonCameras * addon;
});

watch(providersForCurrency, (list) => {
  if (!list.some(p => p.name === form.provider)) form.provider = list[0]?.name || '';
});

async function load() {
  loading.value = true;
  Object.assign(form, { interval: state.options?.interval || 'month', addonCameras: state.options?.addonCameras || 0 });
  try {
    const [b, p] = await Promise.all([api.getBilling(), api.getPlans()]);
    billing.value = b.data || null;
    plans.value = p.data?.plans || [];
    const currencies = billing.value?.currencies || [];
    const preferred = locale.value === 'vi' ? 'VND' : 'USD';
    form.currency = currencies.includes(preferred) ? preferred : (currencies[0] || 'VND');
    form.provider = providersForCurrency.value[0]?.name || '';
  } catch {
    billing.value = null;
  } finally {
    loading.value = false;
  }
}

async function pay() {
  busy.value = true;
  try {
    const res = await api.startCheckout({
      planCode: planCode.value,
      interval: form.interval,
      addonCameras: form.addonCameras,
      currency: form.currency,
      provider: form.provider,
      upgradeRequestId: state.options?.upgradeRequestId || undefined
    });
    // The provider's page (PayOS VietQR or Stripe Checkout); it comes back to /billing/return
    window.location.assign(res.data.checkout.checkoutUrl);
  } catch (err) {
    ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('billing.checkout.failed')), type: 'error' });
    busy.value = false;
  }
}
</script>

<style scoped>
/* One option per line: the method's name with its explanation under it */
.checkout-methods {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.checkout-methods :deep(.el-radio) {
  height: auto;
  margin-right: 0;
  align-items: flex-start;
}
.checkout-methods :deep(.el-radio__input) {
  margin-top: 2px;
}
.checkout-methods :deep(.el-radio__label) {
  white-space: normal;
  line-height: 1.4;
}
.checkout-hint {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: normal;
}
.checkout-total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.checkout-total strong {
  font-size: 16px;
  color: var(--el-color-primary);
}
</style>
