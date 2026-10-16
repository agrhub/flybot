<template>
  <div class="pricing w-full max-w-6xl mx-auto flex flex-col gap-4">
    <PageHeader :title="t('plans.title')" :subtitle="t('plans.subtitle')" />

    <el-alert v-if="!pricing" type="info" :closable="false" show-icon :title="t('plans.b2bHint')" />

    <template v-else>
      <!-- Online prices: month or year, and the currency -->
      <div v-if="currencies.length" class="flex flex-wrap items-center gap-3" data-test="pricing-controls">
        <el-radio-group v-model="interval" size="small">
          <el-radio-button value="month">{{ t('billing.interval.monthly') }}</el-radio-button>
          <el-radio-button value="year">{{ t('billing.interval.yearly') }}</el-radio-button>
        </el-radio-group>
        <el-radio-group v-if="currencies.length > 1" v-model="currency" size="small">
          <el-radio-button v-for="c in currencies" :key="c" :value="c">{{ c }}</el-radio-button>
        </el-radio-group>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <el-card v-for="plan in plans" :key="plan.code" shadow="never" class="pricing-card" :class="{ 'is-current': plan.code === currentCode }" :data-test="`plan-${plan.code}`">
          <div class="flex items-center justify-between gap-2">
            <h3 class="pricing-card__name">{{ plan.name }}</h3>
            <el-tag v-if="plan.code === currentCode" type="success" effect="dark" round size="small">{{ t('plans.current') }}</el-tag>
          </div>
          <p class="pricing-card__price" :data-test="`plan-price-${plan.code}`">{{ priceText(plan) }}</p>
          <p v-if="addonText(plan)" class="pricing-card__desc">{{ addonText(plan) }}</p>
          <p v-if="plan.description" class="pricing-card__desc">{{ plan.description }}</p>
          <ul class="pricing-card__list">
            <li>{{ plan.maxCameras ? t('plans.list.cameras', { n: plan.maxCameras }) : t('plans.list.camerasUnlimited') }}</li>
            <li>{{ t('plans.list.snapshots', { n: plan.snapshotsPerDay }) }}</li>
            <li>{{ t('plans.list.retention', { n: plan.retentionDays }) }}</li>
            <li>{{ plan.deepAnalysisPerMonth ? t('plans.list.deep', { n: plan.deepAnalysisPerMonth }) : t('plans.list.deepNone') }}</li>
            <li>{{ t('plans.list.live', { n: plan.liveMinutesPerRequest }) }}</li>
            <li>{{ plan.maxMembers ? t('plans.list.members', { n: plan.maxMembers }) : t('plans.list.membersUnlimited') }}</li>
            <li v-for="f in ['telegram', 'pdfReports', 'apiAndWebhooks']" :key="f" :class="{ 'is-off': !plan.features[f] }">{{ t(`plans.features.${f}`) }}</li>
          </ul>
          <template v-if="plan.code !== 'free' && signedIn">
            <el-button v-if="canPay(plan)" type="primary" class="w-full mt-2" :data-test="`plan-pay-${plan.code}`" @click="openCheckout({ planCode: plan.code, interval })">
              {{ plan.code === currentCode ? t('billing.renew') : t('billing.pay') }}
            </el-button>
            <el-button v-else-if="plan.code !== currentCode" type="primary" class="w-full mt-2" :data-test="`plan-ask-${plan.code}`" @click="openUpgradeDialog({ targetPlan: plan.code })">{{ t('upgrade.ask') }}</el-button>
          </template>
        </el-card>

        <!-- Hybrid: an organization (business, cooperative) is arranged with the admin -->
        <el-card v-if="appMode === 'hybrid'" shadow="never" class="pricing-card pricing-card--org" data-test="plan-organization">
          <h3 class="pricing-card__name">{{ t('plans.orgCard.title') }}</h3>
          <p class="pricing-card__price">{{ t('plans.contact') }}</p>
          <p class="pricing-card__desc">{{ t('plans.orgCard.desc') }}</p>
          <el-button v-if="signedIn" type="primary" plain class="w-full mt-2" data-test="plan-ask-organization" @click="openUpgradeDialog({ type: 'organization' })">{{ t('plans.orgCard.ask') }}</el-button>
        </el-card>
      </div>
    </template>

    <UsageCard v-if="signedIn && pricing" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import PageHeader from '@/components/common/PageHeader.vue';
import UsageCard from '@/components/plans/UsageCard.vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { openUpgradeDialog } from '@/composables/useUpgrade';
import { openCheckout } from '@/composables/useCheckout';
import { formatMoney, PRICE_CURRENCIES } from '@/utils/money';

/** Plans for the current workspace (APP_MODE b2c / hybrid; hidden in b2b), with online prices. */
const { t, locale } = useI18n();
const { user } = useAuth();

const plans = ref([]);
const pricing = ref(true);
const appMode = ref('hybrid');
const billing = ref(null);
const interval = ref('month');
const currency = ref(locale.value === 'vi' ? 'VND' : 'USD');
const signedIn = computed(() => !!user.value?.id);
const currentCode = computed(() => user.value?.plan?.code || 'free');

const priceOf = (plan) => plan.prices?.[currency.value]?.[interval.value] || 0;
// Currencies some plan is priced in (the admin sets prices in Admin > Plans)
const currencies = computed(() => PRICE_CURRENCIES.filter(c => plans.value.some(p => p.prices?.[c]?.month || p.prices?.[c]?.year)));
// Online payment here: payments on, the workspace's owner, a plan not managed by hand
const payable = computed(() => !!billing.value?.enabled && !!billing.value?.isOwner && !billing.value?.managed);
const canPay = (plan) => payable.value && !!priceOf(plan) && (billing.value.currencies || []).includes(currency.value);

function priceText(plan) {
  const amount = priceOf(plan);
  if (amount) return `${formatMoney(amount, currency.value, locale.value)} / ${t(`billing.interval.${interval.value}`)}`;
  return plan.priceNote || (plan.code === 'free' ? t('plans.free') : t('plans.contact'));
}
function addonText(plan) {
  const addon = plan.prices?.[currency.value]?.[interval.value === 'year' ? 'addonYear' : 'addonMonth'];
  if (!priceOf(plan) || !addon) return '';
  return t('billing.addonPrice', { price: formatMoney(addon, currency.value, locale.value), interval: t(`billing.interval.${interval.value}`) });
}

onMounted(async () => {
  try {
    const res = await api.getPlans();
    plans.value = res.data?.plans || [];
    pricing.value = res.data?.pricing !== false;
    appMode.value = res.data?.appMode || 'hybrid';
    if (currencies.value.length && !currencies.value.includes(currency.value)) currency.value = currencies.value[0];
  } catch {
    plans.value = [];
  }
  if (signedIn.value) billing.value = await api.getBilling().then(r => r.data).catch(() => null);
});
</script>

<style scoped>
.pricing-card {
  display: flex;
  flex-direction: column;
}
.pricing-card.is-current {
  border-color: var(--el-color-success);
}
.pricing-card__name {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.pricing-card__price {
  margin: 6px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.pricing-card__desc {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.pricing-card__list {
  margin: 12px 0 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}
.pricing-card__list .is-off {
  color: var(--el-text-color-placeholder);
  text-decoration: line-through;
}
</style>
