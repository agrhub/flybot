<template>
  <div>
    <PageHeader :title="t('admin.pipeline.title')" :subtitle="t('admin.pipeline.subtitle')">
      <template #actions>
        <span v-if="data" class="admin-meta">{{ t('admin.pipeline.updated', { time: relative(data.generatedAt) }) }}</span>
        <el-button :icon="Refresh" :loading="loading" @click="load">{{ t('common.refresh') }}</el-button>
      </template>
    </PageHeader>

    <div v-loading="loading && !data">
      <template v-if="data">
        <el-alert
          v-if="!data.cronEnabled"
          class="mb-4"
          type="info"
          :title="t('admin.pipeline.cronOff')"
          :closable="false"
          show-icon
        />

        <!-- Totals over the window -->
        <div class="pipeline-stats">
          <div v-for="stat in stats" :key="stat.key" class="pipeline-stat">
            <span class="admin-meta">{{ t(`admin.pipeline.stats.${stat.key}`) }}</span>
            <span class="pipeline-stat__value" :class="stat.tone && `is-${stat.tone}`">{{ stat.value }}</span>
            <span v-if="stat.note" class="admin-meta">{{ stat.note }}</span>
          </div>
        </div>

        <el-card shadow="never" class="mt-4">
          <template #header>
            <div class="admin-label">{{ t('admin.pipeline.byHour') }}</div>
          </template>
          <CatchBarChart
            :labels="hourLabels"
            :series="hourSeries"
            :height="240"
            :y-title="t('admin.pipeline.photosAxis')"
            :empty-text="t('admin.pipeline.noPhotos')"
          />
        </el-card>

        <el-card shadow="never" class="mt-4">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="admin-label">{{ t('admin.pipeline.cameras') }}</div>
              <el-switch v-model="problemsOnly" :active-text="t('admin.pipeline.problemsOnly')" />
            </div>
          </template>
          <el-table :data="cameraRows" size="small" :empty-text="t('admin.pipeline.noProblems')" max-height="420">
            <el-table-column :label="t('admin.pipeline.cols.camera')" min-width="180">
              <template #default="{ row }">
                <div class="font-medium">{{ row.deviceName || row.deviceSerial }}</div>
                <div class="admin-meta">{{ row.deviceSerial }}</div>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.status')" width="110">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small" effect="plain">
                  {{ row.status === 1 ? t('admin.pipeline.online') : t('admin.pipeline.offline') }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.photos')" prop="photos" width="90" align="right" />
            <el-table-column :label="t('admin.pipeline.cols.failed')" width="110" align="right">
              <template #default="{ row }">
                <span :class="{ 'is-danger': row.failed }">{{ row.failed }}</span>
                <span v-if="row.photos" class="admin-meta"> ({{ Math.round((row.failed / row.photos) * 100) }}%)</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.lastPhoto')" min-width="130">
              <template #default="{ row }">
                {{ row.lastPhotoAt ? relative(row.lastPhotoAt) : '--' }}
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.problems')" min-width="170">
              <template #default="{ row }">
                <div class="flex flex-wrap gap-1">
                  <el-tag v-for="p in row.problems" :key="p" :type="p === 'failing' ? 'danger' : 'warning'" size="small">
                    {{ t(`admin.pipeline.problems.${p}`) }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="mt-4">
          <template #header>
            <div class="admin-label">{{ t('admin.pipeline.jobs') }}</div>
            <p class="admin-meta mt-1">{{ t('admin.pipeline.jobsDesc') }}</p>
          </template>
          <el-table :data="jobRows" size="small" :empty-text="t('admin.pipeline.noJobs')">
            <el-table-column :label="t('admin.pipeline.cols.job')" min-width="200">
              <template #default="{ row }">
                <div class="font-medium">{{ t(`admin.pipeline.jobNames.${row.id}`) }}</div>
                <div class="admin-meta">{{ t(`admin.pipeline.jobSchedules.${row.id}`) }}</div>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.lastRun')" min-width="130">
              <template #default="{ row }">
                {{ row.last ? relative(row.last.startedAt) : t('admin.pipeline.notYet') }}
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.duration')" width="100" align="right">
              <template #default="{ row }">{{ row.last ? duration(row.last) : '--' }}</template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.result')" min-width="200">
              <template #default="{ row }">
                <span v-if="row.last?.error" class="is-danger">{{ row.last.error }}</span>
                <span v-else>{{ resultText(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.pipeline.cols.state')" width="120">
              <template #default="{ row }">
                <el-tag :type="jobState(row).type" size="small" effect="plain">{{ t(`admin.pipeline.states.${jobState(row).key}`) }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import api from '@/services/api';
import PageHeader from '@/components/common/PageHeader.vue';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';
import { adminErrorText } from './adminErrors';

const { t, te, locale } = useI18n();
const data = ref(null);
const loading = ref(false);
const problemsOnly = ref(true);

// Jobs listed even before their first run, in this order
const JOB_ORDER = ['capture', 'aiRetry', 'cleanup', 'pestCount', 'statusSync', 'scheduledReports', 'weeklyReports', 'morningBriefs', 'cardReminders', 'trainingSync', 'ezvizPolicies'];

const load = async () => {
  loading.value = true;
  try {
    data.value = (await api.getPipeline()).data.pipeline;
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

const number = (n) => new Intl.NumberFormat(locale.value).format(n);
const relative = (date) => {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 45) return t('notifications.justNow');
  const [unit, size] = [['day', 86400], ['hour', 3600], ['minute', 60]].find(([, s]) => Math.abs(seconds) >= s);
  return new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
};
const duration = ({ startedAt, finishedAt }) => {
  const ms = new Date(finishedAt) - new Date(startedAt);
  return ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;
};

const stats = computed(() => {
  const { totals } = data.value;
  const rate = totals.photos ? Math.round((totals.analyzed / totals.photos) * 100) : null;
  return [
    { key: 'photos', value: number(totals.photos) },
    { key: 'analyzed', value: number(totals.analyzed), note: rate === null ? '' : t('admin.pipeline.rate', { rate }) },
    { key: 'failed', value: number(totals.failed), tone: totals.failed ? 'danger' : '' },
    { key: 'waitingRetry', value: number(totals.waitingRetry), tone: totals.waitingRetry ? 'warning' : '' },
    { key: 'recovered', value: number(totals.recovered), tone: totals.recovered ? 'success' : '' },
    { key: 'gaveUp', value: number(totals.gaveUp), tone: totals.gaveUp ? 'danger' : '', note: t('admin.pipeline.gaveUpNote', { max: data.value.retry.maxAttempts }) }
  ];
});

const hourLabels = computed(() => data.value.hours.map(h => `${h.hour.slice(11)}h`));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const hourSeries = computed(() => [
  { label: t('admin.pipeline.stats.analyzed'), data: data.value.hours.map(h => h.analyzed), color: cssVar('--el-color-success') },
  { label: t('admin.pipeline.stats.failed'), data: data.value.hours.map(h => h.failed), color: cssVar('--el-color-danger') },
  { label: t('admin.pipeline.inProgress'), data: data.value.hours.map(h => h.photos - h.analyzed - h.failed), color: cssVar('--el-color-info') }
]);

const cameraRows = computed(() => (problemsOnly.value ? data.value.cameras.filter(c => c.problems.length) : data.value.cameras));

const jobRows = computed(() => {
  const byId = new Map((data.value.jobs || []).map(j => [j.id, j]));
  return JOB_ORDER.map(id => byId.get(id) || { id, running: false, runs: 0, failures: 0, skipped: 0, last: null });
});

const jobState = (job) => {
  if (job.running) return { key: 'running', type: 'primary' };
  if (!job.last) return { key: 'notYet', type: 'info' };
  return job.last.ok ? { key: 'ok', type: 'success' } : { key: 'failed', type: 'danger' };
};

// The job's own figures, e.g. "cameras 12 · saved 11"
const resultText = (job) => {
  const result = job.last?.result;
  if (!result) return job.last ? '--' : '';
  const parts = Object.entries(result)
    .filter(([, v]) => typeof v === 'number')
    .map(([key, v]) => (te(`admin.pipeline.results.${key}`) ? t(`admin.pipeline.results.${key}`, { n: number(v) }) : `${key}: ${number(v)}`));
  if (result.more) parts.push(t('admin.pipeline.results.more'));
  if (job.skipped) parts.push(t('admin.pipeline.results.skipped', { n: job.skipped }));
  return parts.join(' · ') || '--';
};

// Kept fresh while the tab is open
let timer = null;
onMounted(() => {
  load();
  timer = setInterval(load, 60000);
});
onBeforeUnmount(() => clearInterval(timer));
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
.pipeline-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.pipeline-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-lighter);
  background-color: var(--el-bg-color);
}
.pipeline-stat__value {
  font-size: 22px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}
.pipeline-stat__value.is-danger,
.is-danger {
  color: var(--el-color-danger);
}
.pipeline-stat__value.is-warning {
  color: var(--el-color-warning);
}
.pipeline-stat__value.is-success {
  color: var(--el-color-success);
}
</style>
