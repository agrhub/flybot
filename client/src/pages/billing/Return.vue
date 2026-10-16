<template>
  <div class="w-full max-w-xl mx-auto">
    <el-card shadow="never" data-test="billing-return">
      <el-result :icon="view.icon" :title="view.title" :sub-title="view.text">
        <template #extra>
          <div class="flex flex-wrap justify-center gap-2">
            <el-button v-if="payment?.checkoutUrl && payment.status === 'pending'" type="primary" @click="resume">{{ t('billing.return.resume') }}</el-button>
            <el-button :type="payment?.status === 'paid' ? 'primary' : 'default'" @click="router.push({ name: 'settings', query: { tab: 'plan' } })">{{ t('billing.return.toPlan') }}</el-button>
            <el-button v-if="payment?.status !== 'paid'" @click="router.push({ name: 'pricing' })">{{ t('plans.seePlans') }}</el-button>
          </div>
        </template>
      </el-result>
      <el-descriptions v-if="payment?.status === 'paid'" :column="1" border size="small">
        <el-descriptions-item :label="t('billing.receipt.number')">{{ payment.receiptNumber }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.plan')">{{ payment.planCode.toUpperCase() }} · {{ t(`billing.interval.${payment.interval}`) }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.amount')">{{ formatMoney(payment.amount, payment.currency, locale) }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.until')">{{ formatDate(payment.periodEnd) }}</el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { formatMoney } from '@/utils/money';

/**
 * Back from PayOS / Stripe (/billing/return?payment=<id>): waits for the payment to be confirmed
 * (the provider's webhook; the server also asks PayOS) and shows the new plan.
 */
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const { refreshUser } = useAuth();

const payment = ref(null);
const failed = ref(false);
const timedOut = ref(false);
let timer = null;
let tries = 0;
const POLL_MS = 3000;
const MAX_TRIES = 40;

const formatDate = (d) => (d ? new Date(d).toLocaleDateString(locale.value) : '--');
const cancelledByBuyer = computed(() => route.query.cancelled === '1' || route.query.cancel === 'true');

const view = computed(() => {
  const status = payment.value?.status;
  if (failed.value) return { icon: 'error', title: t('billing.return.notFound'), text: '' };
  if (status === 'paid') return { icon: 'success', title: t('billing.return.paid', { plan: payment.value.planCode.toUpperCase() }), text: t('billing.return.paidText', { date: formatDate(payment.value.periodEnd) }) };
  if (status === 'review') return { icon: 'warning', title: t('billing.return.review'), text: t('billing.return.reviewText') };
  if (status === 'failed' || status === 'canceled' || (status === 'pending' && cancelledByBuyer.value)) return { icon: 'warning', title: t('billing.return.notPaid'), text: t('billing.return.notPaidText') };
  if (timedOut.value) return { icon: 'info', title: t('billing.return.slow'), text: t('billing.return.slowText') };
  return { icon: 'info', title: t('billing.return.waiting'), text: t('billing.return.waitingText') };
});

async function check() {
  try {
    const res = await api.getPayment(route.query.payment, { refresh: true });
    payment.value = res.data?.payment || null;
  } catch {
    failed.value = true;
    return;
  }
  if (payment.value?.status === 'paid') {
    // The new plan in the top bar and the limits
    refreshUser().catch(() => {});
    return;
  }
  if (payment.value?.status !== 'pending' || cancelledByBuyer.value) return;
  if (++tries >= MAX_TRIES) {
    timedOut.value = true;
    return;
  }
  timer = setTimeout(check, POLL_MS);
}

function resume() {
  window.location.assign(payment.value.checkoutUrl);
}

onMounted(() => {
  if (!route.query.payment) failed.value = true;
  else check();
});
onBeforeUnmount(() => clearTimeout(timer));
</script>
