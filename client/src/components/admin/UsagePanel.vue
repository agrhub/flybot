<template>
  <div v-loading="loading">
    <PageHeader :title="t('admin.usage.title')" :subtitle="t('admin.usage.subtitle')">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
      </template>
    </PageHeader>

    <template v-if="usage">
      <!-- People -->
      <el-card shadow="never" class="mb-4">
        <template #header><span class="usage-title">{{ t('admin.usage.people') }}</span></template>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <el-statistic :title="t('admin.usage.active7')" :value="usage.people.active7" />
          <el-statistic :title="t('admin.usage.active30')" :value="usage.people.active30" />
          <el-statistic :title="t('admin.usage.users')" :value="usage.people.users" />
          <el-statistic :title="t('admin.usage.newUsers30')" :value="usage.people.newUsers30" />
        </div>
      </el-card>

      <!-- Features, last 30 days -->
      <el-card shadow="never" class="mb-4">
        <template #header><span class="usage-title">{{ t('admin.usage.features') }}</span></template>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
          <el-statistic v-for="key in FEATURES" :key="key" :title="t(`admin.usage.feature.${key}`)" :value="usage.features30[key]" />
        </div>
      </el-card>

      <!-- Cameras -->
      <el-card shadow="never" class="mb-4">
        <template #header><span class="usage-title">{{ t('admin.usage.cameras') }}</span></template>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <el-statistic :title="t('admin.usage.camerasTotal')" :value="usage.cameras.total" />
          <el-statistic :title="t('admin.usage.camerasOnline')" :value="usage.cameras.online" />
          <el-statistic :title="t('admin.usage.photo24h')" :value="usage.cameras.photo24h" />
          <el-statistic :title="t('admin.usage.photos30')" :value="usage.cameras.photos30" />
        </div>
      </el-card>

      <!-- Twelve weeks -->
      <el-card shadow="never">
        <template #header><span class="usage-title">{{ t('admin.usage.weeks') }}</span></template>
        <CatchBarChart
          :labels="weekLabels"
          :series="[{ label: t('admin.usage.activeUsers'), data: usage.weeks.map((w) => w.activeUsers) }]"
          :stacked="false"
          :height="220"
          :y-title="t('admin.usage.activeUsers')"
          :empty-text="t('admin.usage.noData')"
        />
        <el-table :data="[...usage.weeks].reverse()" size="small" class="mt-4" style="width: 100%">
          <el-table-column :label="t('admin.usage.week')" min-width="120">
            <template #default="{ row }">{{ weekLabel(row.from) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.usage.activeUsers')" prop="activeUsers" width="150" />
          <el-table-column :label="t('admin.usage.treatments')" prop="treatments" width="150" />
          <el-table-column :label="t('admin.usage.photos')" prop="photos" width="150" />
        </el-table>
        <p class="usage-note">{{ t('admin.usage.note') }}</p>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import api from '@/services/api';
import { requestErrorText } from '@/utils/requestError';
import PageHeader from '@/components/common/PageHeader.vue';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';

const FEATURES = ['treatmentsLogged', 'treatmentsByAssistant', 'treatmentsImported', 'cardChanges', 'assistantQuestions', 'assistantUsers', 'dataExports', 'remindersSent', 'cooperativeReportsSent'];
const { t } = useI18n();
const usage = ref(null);
const loading = ref(false);

// The week starting on this day: 13/10
const weekLabel = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
const weekLabels = computed(() => (usage.value?.weeks || []).map((w) => weekLabel(w.from)));

const load = async () => {
  loading.value = true;
  try {
    usage.value = (await api.getUsageStats()).data.usage;
  } catch (err) {
    ElMessage.error(requestErrorText(t, err, t('common.error')));
  } finally {
    loading.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.usage-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.usage-note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
