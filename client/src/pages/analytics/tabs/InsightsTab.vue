<template>
  <div v-loading="loading" class="flex flex-col gap-4 w-full pb-10">
    <el-alert :title="t('insights.howToRead')" type="info" :closable="false" show-icon />

    <!-- Daily catches per trap -->
    <el-card shadow="never">
      <template #header>
        <div class="section-title">{{ t('insights.dailyTitle') }}</div>
        <p class="section-desc">{{ t('insights.dailyDesc', { days: dayKeys.length }) }}</p>
      </template>
      <CatchBarChart
        :labels="dayLabels"
        :series="dailySeries"
        :height="300"
        :y-title="t('insights.catchesAxis')"
        :empty-text="t('analytics.noStatsData')"
      />
    </el-card>

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <!-- Weather vs catches -->
      <el-card shadow="never">
        <template #header>
          <div class="section-title">{{ t('insights.weatherTitle') }}</div>
          <p class="section-desc">{{ weather ? t('insights.weatherDesc') : t('insights.weatherMissing') }}</p>
        </template>
        <CatchBarChart
          :labels="dayLabels"
          :series="weatherSeries"
          :height="280"
          :y-title="t('insights.catchesAxis')"
          :y2-title="t('insights.tempAxis')"
          :empty-text="t('analytics.noStatsData')"
        />
      </el-card>

      <!-- Activity by hour of day -->
      <el-card shadow="never">
        <template #header>
          <div class="section-title">{{ t('insights.activityTitle') }}</div>
          <p class="section-desc">
            {{ peakHour !== null ? t('insights.activityPeak', { from: peakHour, to: peakHour + 1 }) : t('insights.activityDesc') }}
          </p>
        </template>
        <ActivityHeatmap :activity="activity" />
      </el-card>
    </div>

    <!-- Per-trap summary -->
    <el-card shadow="never">
      <template #header>
        <div class="section-title">{{ t('insights.tableTitle') }}</div>
        <p class="section-desc">{{ t('insights.tableDesc') }}</p>
      </template>
      <el-table :data="traps" size="small" class="w-full" :empty-text="t('analytics.noStatsData')" @row-click="openTrap">
        <el-table-column :label="t('insights.col.trap')" min-width="190" fixed>
          <template #default="{ row }">
            <div class="flex items-center gap-2 min-w-0">
              <span class="status-dot shrink-0" :class="row.online ? 'is-online' : 'is-idle'"></span>
              <div class="min-w-0">
                <div class="font-semibold truncate">{{ row.deviceName }}</div>
                <div class="meta-text truncate">{{ [row.plot, row.farm].filter(Boolean).join(' · ') || row.deviceSerial }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.kind')" min-width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" round>{{ t(`trapKind.${row.trapKind}.short`) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.onTrap')" min-width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="RISK_TAG[row.riskLevel]" effect="light" round size="small">{{ row.onCard }} / {{ row.alertThreshold }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.today')" prop="today" min-width="80" align="right">
          <template #default="{ row }">{{ row.today ?? '--' }}</template>
        </el-table-column>
        <el-table-column :label="t('insights.col.total', { days: dayKeys.length })" prop="total" min-width="90" align="right" sortable />
        <el-table-column :label="t('insights.col.ftd')" prop="ftd" min-width="110" align="right" sortable>
          <template #default="{ row }"><b>{{ row.ftd ?? '--' }}</b></template>
        </el-table-column>
        <el-table-column :label="t('insights.col.change')" min-width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.changePct !== null" :type="row.changePct > 10 ? 'danger' : row.changePct < -10 ? 'success' : 'info'" effect="light" size="small" round>
              {{ row.changePct > 0 ? '+' : '' }}{{ row.changePct }}%
            </el-tag>
            <span v-else class="meta-text">--</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.trend')" min-width="130">
          <template #default="{ row }">
            <div class="spark">
              <div v-for="(v, i) in row.daily" :key="i" class="spark__bar" :style="{ height: `${v ? Math.max(8, (v / sparkMax(row)) * 100) : 4}%`, opacity: v === null ? 0.25 : 1 }"></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.card')" min-width="100" align="center">
          <template #default="{ row }">
            <span v-if="row.trapKind === 'lure'" class="meta-text">--</span>
            <span v-else-if="row.cardAgeDays !== null">{{ t('insights.days', { n: row.cardAgeDays }) }}</span>
            <span v-else class="meta-text">--</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('insights.col.photo')" min-width="170">
          <template #default="{ row }">
            <div class="flex flex-wrap gap-1">
              <el-tag v-for="issue in row.imageIssues" :key="issue" type="warning" size="small" effect="light" round>
                {{ t(`cameras.imageQuality.issues.${issue}`) }}
              </el-tag>
              <span v-if="!row.imageIssues.length" class="meta-text">{{ row.lastScanAt ? relative(row.lastScanAt) : '--' }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';
import ActivityHeatmap from '@/components/charts/ActivityHeatmap.vue';

const props = defineProps({
  camera: { type: Object, default: null },
  active: { type: Boolean, default: false }
});

const { t, locale } = useI18n();
const { cameras, selectCameraAndGoToLive } = useCameras();
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' };

const loading = ref(false);
const dayKeys = ref([]);
const traps = ref([]);
const activity = ref(null);
const weather = ref(null);

const shortDay = (key) => (key ? `${key.slice(8, 10)}/${key.slice(5, 7)}` : '');
const dayLabels = computed(() => dayKeys.value.map(shortDay));

const dailySeries = computed(() => traps.value.map(trap => ({ label: trap.deviceName, data: trap.daily })));
const totalsByDay = computed(() => dayKeys.value.map((_, i) => {
  const values = traps.value.map(trap => trap.daily[i]).filter(v => v !== null && v !== undefined);
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 10) / 10 : null;
}));
const weatherSeries = computed(() => {
  const series = [{ label: t('insights.catchesAxis'), data: totalsByDay.value }];
  if (weather.value) {
    series.push(
      { label: t('insights.tempMax'), data: weather.value.map(w => w.max), type: 'line', axis: 'y2', color: getComputedStyle(document.documentElement).getPropertyValue('--el-color-danger').trim() },
      { label: t('insights.tempMin'), data: weather.value.map(w => w.min), type: 'line', axis: 'y2', color: getComputedStyle(document.documentElement).getPropertyValue('--el-color-primary').trim() }
    );
  }
  return series;
});

const peakHour = computed(() => {
  const byHour = activity.value?.byHour || [];
  const max = Math.max(0, ...byHour);
  return max > 0 ? activity.value.hours[byHour.indexOf(max)] : null;
});
const sparkMax = (row) => Math.max(1, ...row.daily.filter(v => v !== null));

const relative = (date) => {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' });
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  if (minutes < 1440) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / 1440), 'day');
};

// Open the trap on the Cameras page
const openTrap = (row) => selectCameraAndGoToLive(cameras.value.find(c => c.deviceSerial === row.deviceSerial) || { deviceSerial: row.deviceSerial });

const load = async () => {
  loading.value = true;
  try {
    const res = await api.getInsights(props.camera?.deviceSerial || 'all', 14);
    const data = res.data?.insights || {};
    dayKeys.value = data.days || [];
    traps.value = data.traps || [];
    activity.value = data.activity || null;
    weather.value = data.weather || null;
  } catch {
    traps.value = [];
  } finally {
    loading.value = false;
  }
};

watch(() => [props.camera?.deviceSerial, props.active], () => { if (props.active) load(); });
onMounted(() => { if (props.active) load(); });
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-desc,
.meta-text {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--el-color-info-light-5);
}
.status-dot.is-online {
  background-color: var(--el-color-success);
}
.spark {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 24px;
}
.spark__bar {
  flex: 1;
  min-width: 3px;
  border-radius: 1px;
  background-color: var(--el-color-primary-light-3);
}
</style>
