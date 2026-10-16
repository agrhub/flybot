<template>
  <div class="flex flex-col gap-4" data-test="admin-revenue">
    <PageHeader :title="t('admin.revenue.title')" :subtitle="t('admin.revenue.subtitle')" />

    <div class="flex flex-wrap items-center gap-3">
      <el-radio-group v-model="months" size="small" @change="load">
        <el-radio-button v-for="m in [3, 12, 36]" :key="m" :value="m">{{ t('admin.revenue.months', { n: m }) }}</el-radio-button>
      </el-radio-group>
      <el-button size="small" :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
    </div>

    <div v-if="loading && !data" class="py-4"><el-skeleton :rows="5" animated /></div>
    <template v-else-if="data">
      <!-- Totals: one per currency (never added across currencies) -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <el-card v-for="row in data.totals" :key="row.currency" shadow="never" :data-test="`revenue-total-${row.currency}`">
          <el-statistic :title="t('admin.revenue.total', { currency: row.currency })" :value="row.amount" :formatter="() => formatMoney(row.amount, row.currency, locale)" />
          <p class="revenue-muted">{{ t('admin.revenue.payments', { n: row.count }) }}</p>
        </el-card>
        <el-card shadow="never">
          <el-statistic :title="t('admin.revenue.paying')" :value="data.workspaces.paying" />
          <p class="revenue-muted">{{ t('admin.revenue.renewing', { n: data.workspaces.renewing }) }} · {{ t('admin.revenue.pastDue', { n: data.workspaces.pastDue }) }}</p>
        </el-card>
      </div>
      <el-empty v-if="!data.totals.length" :description="t('admin.revenue.none')" />

      <el-alert v-if="data.review" type="warning" :closable="false" show-icon :title="t('admin.revenue.review', { n: data.review })" />

      <div class="grid gap-4 2xl:grid-cols-3">
        <el-card shadow="never">
          <template #header><span class="font-semibold">{{ t('admin.revenue.byMonth') }}</span></template>
          <el-table :data="data.byMonth" size="small" max-height="320">
            <el-table-column prop="month" :label="t('admin.revenue.month')" min-width="90" />
            <el-table-column :label="t('billing.receipt.amount')" min-width="120" align="right">
              <template #default="{ row }">{{ formatMoney(row.amount, row.currency, locale) }}</template>
            </el-table-column>
            <el-table-column prop="count" :label="t('admin.revenue.count')" width="70" align="right" />
          </el-table>
        </el-card>
        <el-card shadow="never">
          <template #header><span class="font-semibold">{{ t('admin.revenue.byProvider') }}</span></template>
          <el-table :data="data.byProvider" size="small">
            <el-table-column :label="t('billing.receipt.method')" min-width="110">
              <template #default="{ row }">{{ t(`billing.provider.${row.provider}`) }}</template>
            </el-table-column>
            <el-table-column :label="t('billing.receipt.amount')" min-width="120" align="right">
              <template #default="{ row }">{{ formatMoney(row.amount, row.currency, locale) }}</template>
            </el-table-column>
            <el-table-column prop="count" :label="t('admin.revenue.count')" width="70" align="right" />
          </el-table>
        </el-card>
        <el-card shadow="never">
          <template #header><span class="font-semibold">{{ t('admin.revenue.byPlan') }}</span></template>
          <el-table :data="data.byPlan" size="small">
            <el-table-column :label="t('billing.receipt.plan')" min-width="90">
              <template #default="{ row }">{{ row.planCode.toUpperCase() }}</template>
            </el-table-column>
            <el-table-column :label="t('billing.receipt.amount')" min-width="120" align="right">
              <template #default="{ row }">{{ formatMoney(row.amount, row.currency, locale) }}</template>
            </el-table-column>
            <el-table-column prop="count" :label="t('admin.revenue.count')" width="70" align="right" />
          </el-table>
        </el-card>
      </div>

      <!-- Latest payments -->
      <el-card shadow="never">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-semibold">{{ t('admin.revenue.latest') }}</span>
            <el-select v-model="status" size="small" clearable :placeholder="t('admin.revenue.allStatuses')" class="!w-40" @change="load">
              <el-option v-for="s in STATUSES" :key="s" :label="t(`billing.status.${s}`)" :value="s" />
            </el-select>
          </div>
        </template>
        <el-table :data="data.payments" size="small" data-test="revenue-payments">
          <el-table-column :label="t('billing.receipt.date')" min-width="140">
            <template #default="{ row }">{{ new Date(row.paidAt || row.createdAt).toLocaleString(locale) }}</template>
          </el-table-column>
          <el-table-column :label="t('billing.receipt.workspace')" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.workspace?.name || row.workspace?.id }}</template>
          </el-table-column>
          <el-table-column :label="t('billing.receipt.plan')" min-width="130">
            <template #default="{ row }">{{ row.planCode.toUpperCase() }} · {{ t(`billing.interval.${row.interval}`) }}<span v-if="row.addonCameras"> · +{{ row.addonCameras }}</span></template>
          </el-table-column>
          <el-table-column :label="t('billing.receipt.method')" min-width="100">
            <template #default="{ row }">{{ t(`billing.provider.${row.provider}`) }}</template>
          </el-table-column>
          <el-table-column :label="t('billing.receipt.amount')" min-width="120" align="right">
            <template #default="{ row }">{{ formatMoney(row.amount, row.currency, locale) }}</template>
          </el-table-column>
          <el-table-column :label="t('billing.receipt.status')" min-width="110">
            <template #default="{ row }">
              <el-tooltip :disabled="!row.failureReason" :content="row.failureReason || ''">
                <el-tag size="small" round :type="statusType(row.status)">{{ t(`billing.status.${row.status}`) }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column :label="t('billing.receipt.number')" min-width="140" prop="receiptNumber" />
        </el-table>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import PageHeader from '@/components/common/PageHeader.vue';
import api from '@/services/api';
import { formatMoney } from '@/utils/money';

/** Admin > Revenue: plans paid online, per currency, month, payment method and plan. */
const { t, locale } = useI18n();
const STATUSES = ['paid', 'pending', 'failed', 'canceled', 'review'];

const data = ref(null);
const loading = ref(false);
const months = ref(12);
const status = ref('');

const statusType = (s) => ({ paid: 'success', failed: 'danger', canceled: 'info', review: 'warning' }[s] || 'warning');

async function load() {
  loading.value = true;
  try {
    const res = await api.adminGetRevenue({ months: months.value, status: status.value || undefined });
    data.value = res.data;
  } catch {
    data.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.revenue-muted {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
