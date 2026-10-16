<template>
  <el-card v-if="visible" shadow="never" data-test="billing-panel">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-semibold">{{ t('billing.panel.title') }}</span>
        <el-button v-if="summary?.enabled && !summary?.managed" link type="primary" @click="router.push({ name: 'pricing' })">{{ t('billing.panel.payOrRenew') }}</el-button>
      </div>
    </template>

    <div class="flex flex-col gap-3">
      <!-- How the plan renews -->
      <template v-if="summary?.billing">
        <el-alert v-if="summary.billing.pastDue" type="warning" :closable="false" show-icon :title="t('billing.panel.pastDue', { date: formatDate(summary.billing.graceUntil) })" data-test="billing-past-due" />
        <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {{ t(`billing.provider.${summary.billing.provider}`) }} ·
            {{ summary.billing.autoRenew ? t('billing.panel.autoRenew', { date: formatDate(summary.plan?.expiresAt) }) : t('billing.panel.manualRenew', { date: formatDate(summary.plan?.expiresAt) }) }}
          </span>
          <el-button v-if="summary.billing.autoRenew" size="small" :loading="stopping" data-test="billing-stop-renewal" @click="stopRenewal">{{ t('billing.panel.stopRenewal') }}</el-button>
        </div>
      </template>
      <p v-else-if="summary?.managed" class="billing-muted">{{ t('billing.panel.managed') }}</p>

      <!-- Receipts -->
      <el-table v-if="payments.length" :data="payments" size="small" data-test="billing-receipts">
        <el-table-column :label="t('billing.receipt.date')" min-width="110">
          <template #default="{ row }">{{ formatDate(row.paidAt || row.createdAt) }}</template>
        </el-table-column>
        <el-table-column :label="t('billing.receipt.plan')" min-width="140">
          <template #default="{ row }">{{ row.planCode.toUpperCase() }} · {{ t(`billing.interval.${row.interval}`) }}<span v-if="row.addonCameras"> · +{{ row.addonCameras }}</span></template>
        </el-table-column>
        <el-table-column :label="t('billing.receipt.amount')" min-width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.amount, row.currency, locale) }}</template>
        </el-table-column>
        <el-table-column :label="t('billing.receipt.status')" min-width="110">
          <template #default="{ row }"><el-tag size="small" round :type="statusType(row.status)">{{ t(`billing.status.${row.status}`) }}</el-tag></template>
        </el-table-column>
        <el-table-column width="120" align="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'paid'" link type="primary" size="small" @click="openReceipt(row)">{{ t('billing.receipt.view') }}</el-button>
            <el-button v-else-if="row.checkoutUrl" link type="primary" size="small" @click="resume(row)">{{ t('billing.return.resume') }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="billing-muted">{{ t('billing.panel.noPayments') }}</p>
    </div>

    <el-dialog v-model="receiptOpen" :title="t('billing.receipt.title')" :width="isMobile ? '94%' : '440px'" append-to-body>
      <el-descriptions v-if="receipt" :column="1" border size="small" data-test="billing-receipt">
        <el-descriptions-item :label="t('billing.receipt.number')">{{ receipt.receiptNumber }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.workspace')">{{ receipt.workspace?.name }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.date')">{{ formatDate(receipt.paidAt) }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.plan')">{{ receipt.planCode.toUpperCase() }} · {{ t(`billing.interval.${receipt.interval}`) }}</el-descriptions-item>
        <el-descriptions-item v-if="receipt.addonCameras" :label="t('billing.checkout.addonCameras')">{{ receipt.addonCameras }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.period')">{{ formatDate(receipt.periodStart) }} – {{ formatDate(receipt.periodEnd) }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.amount')">{{ formatMoney(receipt.amount, receipt.currency, locale) }}</el-descriptions-item>
        <el-descriptions-item :label="t('billing.receipt.method')">{{ t(`billing.provider.${receipt.provider}`) }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button v-if="receipt?.receiptUrl" tag="a" :href="receipt.receiptUrl" target="_blank" rel="noopener">{{ t('billing.receipt.providerInvoice') }}</el-button>
        <el-button type="primary" @click="receiptOpen = false">{{ t('common.close') }}</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessageBox, ElNotification } from 'element-plus';
import api from '@/services/api';
import { formatMoney } from '@/utils/money';
import { requestErrorText } from '@/utils/requestError';
import { useBreakpoints } from '@/composables/useBreakpoints';

/** The current workspace's online payments (its owner): renewal, receipts, stopping auto renewal. */
const { t, locale } = useI18n();
const router = useRouter();
const { isMobile } = useBreakpoints();

const summary = ref(null);
const payments = ref([]);
const stopping = ref(false);
const receipt = ref(null);
const receiptOpen = ref(false);

const visible = computed(() => !!summary.value?.isOwner && (summary.value.enabled || payments.value.length > 0 || !!summary.value.billing));
const formatDate = (d) => (d ? new Date(d).toLocaleDateString(locale.value) : '--');
const statusType = (s) => ({ paid: 'success', failed: 'danger', canceled: 'info', review: 'warning' }[s] || 'warning');

async function load() {
  try {
    summary.value = (await api.getBilling()).data;
    payments.value = summary.value?.isOwner ? ((await api.getPayments()).data?.payments || []) : [];
  } catch {
    summary.value = null;
  }
}

function openReceipt(row) {
  receipt.value = row;
  receiptOpen.value = true;
}
function resume(row) {
  window.location.assign(row.checkoutUrl);
}

async function stopRenewal() {
  try {
    await ElMessageBox.confirm(t('billing.panel.stopConfirm', { date: formatDate(summary.value.plan?.expiresAt) }), t('billing.panel.stopRenewal'), { type: 'warning', confirmButtonText: t('billing.panel.stopRenewal'), cancelButtonText: t('common.cancel') });
  } catch {
    return;
  }
  stopping.value = true;
  try {
    await api.cancelRenewal();
    await load();
  } catch (err) {
    ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('common.error')), type: 'error' });
  } finally {
    stopping.value = false;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<style scoped>
.billing-muted {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
