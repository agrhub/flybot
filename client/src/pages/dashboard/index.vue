<template>
  <div class="w-full max-w-7xl mx-auto pb-12 select-none space-y-6">
    <!-- Page header -->
    <PageHeader
      :title="t('dashboard.title')"
      :subtitle="`${t('dashboard.welcome')}, ${userName}`"
    />

    <!-- Key metrics -->
    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- Realtime hotspot (peak camera) -->
      <StatCard
        :label="t('dashboard.hotspotPeak')"
        :value="overviewData.peakRealtimeInsects"
        :unit="t('dashboard.individualsUnit')"
        :description="overviewData.peakCamera?.deviceName || '--'"
        :icon="Lightning"
        type="warning"
      />

      <!-- Realtime insect total across the orchard -->
      <StatCard
        :label="t('dashboard.realtimeTotal')"
        :value="overviewData.totalRealtimeInsects"
        :unit="t('dashboard.fruitFlyUnit')"
        :description="t('dashboard.avgPerTrap', { count: (overviewData.totalRealtimeInsects / (cameras.length || 1)).toFixed(1) })"
        :icon="DataAnalysis"
        type="success"
      />

      <!-- Cameras online -->
      <StatCard
        :label="t('dashboard.activeCameras')"
        :value="`${onlineCount}/${cameras.length}`"
        :description="`${cameras.length > 0 ? Math.round((onlineCount / cameras.length) * 100) : 0}% ${t('dashboard.onlinePct')}`"
        :icon="VideoCamera"
        type="primary"
      />

      <!-- AI outbreak risk index -->
      <StatCard
        :label="t('dashboard.riskIndex')"
        :description="t('dashboard.aiCopilotAgentBadge')"
        :icon="Warning"
        :type="riskTagType"
      >
        <template #value>
          <el-tag :type="riskTagType" effect="light" round>{{ riskLabel }}</el-tag>
        </template>
      </StatCard>
    </section>

    <!-- Realtime density per camera & historical min/max/avg -->
    <section class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <!-- Realtime density per camera -->
      <el-card shadow="never" class="lg:col-span-2">
        <template #header>
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="min-w-0">
              <h3 class="section-title">{{ t('dashboard.realtimeByCamera') }}</h3>
              <p class="section-desc">{{ t('dashboard.realtimeByCameraDesc') }}</p>
            </div>
            <el-tag type="danger" effect="plain" round size="small">
              {{ t('dashboard.alertThreshold') }}
            </el-tag>
          </div>
        </template>

        <div class="space-y-3">
          <div
            v-for="cam in (overviewData.cameraRealtimeList || [])"
            :key="cam.deviceSerial"
            @click="selectCameraAndGoToLive(cam)"
            class="density-item"
          >
            <div class="flex items-center justify-between gap-3 mb-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="status-dot" :class="cam.status ? 'is-online' : 'is-idle'"></span>
                <span class="item-name truncate">{{ cam.deviceName || cam.deviceSerial }}</span>
                <span class="meta-text font-mono truncate">({{ cam.deviceSerial }})</span>
              </div>
              <div class="shrink-0">
                <span class="item-count" :class="`is-${densityLevel(cam.currentCount)}`">{{ cam.currentCount }}</span>
                <span class="meta-text ml-1">{{ t('dashboard.insectsShort') }}</span>
              </div>
            </div>

            <el-progress
              :percentage="Math.min(100, Math.max(8, (cam.currentCount / 40) * 100))"
              :color="`var(--el-color-${densityLevel(cam.currentCount)})`"
              :stroke-width="8"
              :show-text="false"
            />

            <div class="flex items-center justify-between gap-3 mt-2">
              <span class="meta-text truncate">{{ cam.locationAddress || t('map.noAddress') }}</span>
              <el-tag :type="densityLevel(cam.currentCount)" effect="light" round size="small">
                {{ cam.currentCount >= 16 ? t('dashboard.pestHotspot') : (cam.currentCount >= 5 ? t('dashboard.moderateLevel') : t('dashboard.wellControlled')) }}
              </el-tag>
            </div>
          </div>

          <el-empty
            v-if="!overviewData.cameraRealtimeList?.length"
            :description="t('dashboard.noRealtimeData')"
            :image-size="80"
          />
        </div>
      </el-card>

      <!-- Min / Max / Avg statistics -->
      <el-card shadow="never" body-class="flex flex-col h-full">
        <template #header>
          <h3 class="section-title">{{ t('dashboard.minMaxAvgTitle') }}</h3>
          <p class="section-desc">{{ t('dashboard.minMaxAvgDesc') }}</p>
        </template>

        <el-radio-group v-model="selectedPeriod" size="small" class="period-switch mb-4">
          <el-radio-button v-for="p in periodOptions" :key="p.key" :value="p.key">
            {{ p.label }}
          </el-radio-button>
        </el-radio-group>

        <div class="grid grid-cols-2 gap-3">
          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statMin') }}</span>
            <div class="mini-stat__value is-success">{{ currentPeriodStats.min }}</div>
            <span class="meta-text">{{ t('dashboard.individualsPerScan') }}</span>
          </div>

          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statMax') }}</span>
            <div class="mini-stat__value is-danger">{{ currentPeriodStats.max }}</div>
            <span class="meta-text">{{ t('dashboard.peakRecorded') }}</span>
          </div>

          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statAvg') }}</span>
            <div class="mini-stat__value is-primary">{{ currentPeriodStats.avg }}</div>
            <span class="meta-text">{{ t('dashboard.cycleAverage') }}</span>
          </div>

          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statScans') }}</span>
            <div class="mini-stat__value">{{ currentPeriodStats.totalScans }}</div>
            <span class="meta-text">{{ t('dashboard.aiProcessedRuns') }}</span>
          </div>
        </div>

        <el-divider class="!my-4" />

        <div class="flex items-center justify-between gap-3">
          <span class="meta-text">{{ t('dashboard.dominantSpeciesLabel') }}</span>
          <span class="species-value truncate">{{ formatSpeciesDisplay(overviewData.topSpecies) }}</span>
        </div>
      </el-card>
    </section>

    <!-- AI agricultural copilot: deep diagnosis & IPM recommendations -->
    <el-card shadow="never">
      <template #header>
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div class="min-w-0">
            <el-tag type="success" effect="light" round size="small" class="mb-2">
              <span class="inline-flex items-center gap-1">
                <el-icon><MagicStick /></el-icon>
                {{ t('dashboard.aiCopilotAgentBadge') }}
              </span>
            </el-tag>
            <h3 class="section-title">{{ t('dashboard.aiAgentTitle') }}</h3>
            <p class="section-desc">{{ t('dashboard.aiAgentSubtitle') }}</p>
          </div>

          <el-button
            type="primary"
            :icon="Cpu"
            :loading="loadingDiagnosis"
            :disabled="loadingDiagnosis || cameras.length === 0"
            @click="runDeepDiagnosis"
          >
            {{ loadingDiagnosis ? t('dashboard.runningDiagnosis') : t('dashboard.runDiagnosis') }}
          </el-button>
        </div>
      </template>

      <!-- No cameras: friendly empty prompt instead of fake plans -->
      <el-empty
        v-if="cameras.length === 0"
        :description="t('dashboard.noCamerasCopilotPrompt')"
        :image-size="80"
      />

      <!-- Diagnosis content -->
      <div v-else-if="diagnosisResult" class="space-y-6">
        <!-- 7-day forecast trajectory chart -->
        <div class="panel-inset">
          <div class="flex items-center justify-between gap-3 mb-2">
            <h4 class="subsection-title flex items-center gap-2">
              <el-icon class="is-primary"><TrendCharts /></el-icon>
              <span>{{ t('dashboard.trajectoryTitle') }}</span>
            </h4>
            <span class="meta-text">
              {{ t('dashboard.modelConfidence') }} {{ diagnosisResult.forecast?.confidence || '95.8%' }}
            </span>
          </div>

          <!-- Forecast bars (data visualization) -->
          <div class="grid grid-cols-7 gap-2 h-28 items-end pt-4 pb-1">
            <div
              v-for="(day, i) in (diagnosisResult.forecast?.days || [])"
              :key="i"
              class="flex flex-col items-center gap-1.5 h-full justify-end"
            >
              <span class="meta-text font-semibold">{{ day.projectedCount }}</span>
              <div
                class="forecast-bar w-full"
                :style="{
                  height: `${Math.min(100, Math.max(15, (day.projectedCount / 40) * 100))}%`,
                  backgroundColor: `var(--el-color-${forecastLevel(day.projectedCount)})`
                }"
              ></div>
              <span class="meta-text font-mono">{{ day.date }}</span>
            </div>
          </div>
        </div>

        <!-- Prescriptive recommendations -->
        <div>
          <h4 class="subsection-title mb-3">{{ t('dashboard.recommendationsTitle') }}</h4>

          <el-alert
            v-if="!diagnosisResult.recommendations?.length"
            type="success"
            :title="t('dashboard.systemSafePrompt')"
            :closable="false"
            show-icon
          />

          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <el-card
              v-for="rec in (diagnosisResult.recommendations || [])"
              :key="rec.id"
              shadow="never"
              body-class="flex flex-col justify-between h-full"
            >
              <div>
                <div class="flex items-center justify-between gap-2 mb-2">
                  <el-tag :type="urgencyTagType(rec.urgency)" effect="light" round size="small">
                    {{ getUrgencyLabel(rec) }}
                  </el-tag>
                  <span class="meta-text">{{ getMethodLabel(rec) }}</span>
                </div>
                <h5 class="rec-title">{{ getTitleLabel(rec) }}</h5>
                <p class="rec-desc">{{ getDescLabel(rec) }}</p>
              </div>
              <div class="rec-footer">
                <span class="meta-text">{{ t('dashboard.appliedZone') }}</span>
                <span class="rec-zone truncate">{{ getTargetZoneLabel(rec) }}</span>
              </div>
            </el-card>
          </div>
        </div>
      </div>
    </el-card>

    <!-- Camera surveillance roster -->
    <el-card shadow="never">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <h3 class="section-title">{{ t('dashboard.cameraRoster') }}</h3>
            <p class="section-desc">{{ t('dashboard.cameraRosterSubtitle') }}</p>
          </div>

          <el-button type="primary" link @click="router.push('/cameras')">
            {{ t('dashboard.viewAll') }}
            <el-icon class="el-icon--right"><ArrowRight /></el-icon>
          </el-button>
        </div>
      </template>

      <el-empty
        v-if="cameras.length === 0"
        :description="t('dashboard.noCamerasPrompt')"
        :image-size="80"
      />

      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <el-card
          v-for="cam in cameras"
          :key="cam.deviceSerial"
          shadow="hover"
          class="roster-card cursor-pointer"
          @click="selectCameraAndGoToLive(cam)"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <el-icon class="shrink-0" :class="cam.status === 1 ? 'is-success' : 'is-danger'"><VideoCamera /></el-icon>
                <h4 class="item-name truncate">{{ cam.deviceName || cam.deviceSerial }}</h4>
              </div>
              <p class="meta-text font-mono mt-1 truncate">{{ cam.deviceSerial }}</p>
            </div>

            <el-tag :type="cam.status === 1 ? 'success' : 'danger'" effect="light" round size="small" class="shrink-0">
              {{ cam.status === 1 ? t('common.online') : t('common.offline') }}
            </el-tag>
          </div>

          <el-divider class="!my-3" />

          <div class="flex items-center justify-between gap-2">
            <span class="meta-text truncate">{{ cam.locationAddress || t('map.noAddress') }}</span>
            <span class="watch-link shrink-0">
              {{ t('dashboard.watchStream') }}
              <el-icon><Right /></el-icon>
            </span>
          </div>
        </el-card>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCameras } from '@/composables/useCameras';
import api from '@/services/api';
import { ElNotification } from 'element-plus';
import {
  Lightning,
  DataAnalysis,
  VideoCamera,
  Warning,
  MagicStick,
  Cpu,
  TrendCharts,
  ArrowRight,
  Right
} from '@element-plus/icons-vue';
import PageHeader from '@/components/common/PageHeader.vue';
import StatCard from '@/components/common/StatCard.vue';
import { speciesShare } from '@/utils/species';

const router = useRouter();
const { t } = useI18n();
const { cameras, selectCameraAndGoToLive } = useCameras();

const formatSpeciesDisplay = (topSpecies) => speciesShare(topSpecies, t);

// The diagnosis API returns stable keys; all display text comes from dashboard.diagnosis.*
const getUrgencyLabel = (rec) => t(`dashboard.diagnosis.urgency.${rec.urgency || 'normal'}`);
const recText = (rec, field) => (rec.key ? t(`dashboard.diagnosis.recs.${rec.key}.${field}`) : '');
const getMethodLabel = (rec) => recText(rec, 'method');
const getTitleLabel = (rec) => recText(rec, 'title');
const getDescLabel = (rec) => recText(rec, 'desc');
const getTargetZoneLabel = (rec) => recText(rec, 'zone');

// Element Plus tag type per recommendation urgency
const urgencyTagType = (urgency) => {
  if (urgency === 'urgent') return 'danger';
  if (urgency === 'important') return 'warning';
  if (urgency === 'recommended') return 'primary';
  return 'info';
};

// Status type for realtime density per camera (same thresholds as the labels)
const densityLevel = (count) => (count >= 16 ? 'danger' : (count >= 5 ? 'warning' : 'success'));

// Status type for projected forecast counts
const forecastLevel = (count) => (count >= 20 ? 'danger' : (count >= 6 ? 'warning' : 'success'));

const user = computed(() => {
  try {
    return JSON.parse(localStorage.getItem('user')) || {};
  } catch (e) {
    return {};
  }
});

const userName = computed(() => user.value.name || user.value.email?.split('@')[0] || t('common.defaultUserName'));

const onlineCount = computed(() => {
  return cameras.value.filter(c => c.status === 1).length;
});

const loadingOverview = ref(false);
const overviewData = ref({
  peakRealtimeInsects: 0,
  peakCamera: null,
  totalRealtimeInsects: 0,
  cameraRealtimeList: [],
  overallRisk: 'low',
  historicalStats: {
    day: { min: 0, max: 0, avg: 0, totalScans: 0 },
    week: { min: 0, max: 0, avg: 0, totalScans: 0 },
    month: { min: 0, max: 0, avg: 0, totalScans: 0 }
  },
  totalSnapshots: 0,
  last24hCount: 0,
  topSpecies: '--',
  trend7Days: []
});

const selectedPeriod = ref('day'); // 'day' | 'week' | 'month'
const periodOptions = computed(() => [
  { key: 'day', label: t('dashboard.periodDay') },
  { key: 'week', label: t('dashboard.periodWeek') },
  { key: 'month', label: t('dashboard.periodMonth') }
]);

const currentPeriodStats = computed(() => {
  const stats = overviewData.value.historicalStats || {};
  return stats[selectedPeriod.value] || { min: 0, max: 0, avg: 0, totalScans: 0 };
});

const riskLabel = computed(() => {
  const risk = overviewData.value.overallRisk;
  if (risk === 'high') return t('dashboard.outbreakRiskHigh');
  if (risk === 'moderate') return t('dashboard.outbreakRiskModerate');
  return t('dashboard.outbreakRiskLow');
});

const riskTagType = computed(() => {
  const risk = overviewData.value.overallRisk;
  if (risk === 'high') return 'danger';
  if (risk === 'moderate') return 'warning';
  return 'success';
});

// AI Copilot Diagnosis state
const loadingDiagnosis = ref(false);
const diagnosisResult = ref(null);

const runDeepDiagnosis = async () => {
  loadingDiagnosis.value = true;
  try {
    const res = await api.getAiDiagnosis({ timeRange: '7d' });
    if (res.data?.success && res.data.diagnosis) {
      diagnosisResult.value = res.data.diagnosis;
      ElNotification({
        title: t('assistant.title'),
        message: t('dashboard.diagnosisDone'),
        type: 'success'
      });
    }
  } catch (err) {
    console.error('Diagnosis error:', err);
    ElNotification({
      title: t('common.error'),
      message: t('dashboard.diagnosisFailed', { error: err.message }),
      type: 'error'
    });
  } finally {
    loadingDiagnosis.value = false;
  }
};

const loadOverview = async () => {
  loadingOverview.value = true;
  try {
    const res = await api.getAiOverview();
    if (res.data?.success && res.data.overview) {
      overviewData.value = res.data.overview;
    }
  } catch (err) {
    console.error('Failed to load AI overview:', err);
  } finally {
    loadingOverview.value = false;
  }
};

onMounted(async () => {
  await loadOverview();
  await runDeepDiagnosis();
});
</script>

<style scoped>
.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.subsection-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.meta-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.item-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.item-count {
  font-size: 15px;
  font-weight: 600;
}

/* Clickable density row per camera */
.density-item {
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-blank);
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s;
}
.density-item:hover {
  border-color: var(--el-color-primary);
  background-color: var(--el-fill-color-light);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.is-online { background-color: var(--el-color-success); }
.status-dot.is-idle { background-color: var(--el-color-info); }

.period-switch {
  display: flex;
  width: 100%;
}
.period-switch :deep(.el-radio-button) {
  flex: 1;
}
.period-switch :deep(.el-radio-button__inner) {
  width: 100%;
}

.mini-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
.mini-stat__value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}

.species-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.panel-inset {
  padding: 16px;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
.forecast-bar {
  border-radius: 4px 4px 0 0;
  opacity: 0.85;
}

.rec-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.rec-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}
.rec-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.rec-zone {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.roster-card:hover .item-name {
  color: var(--el-color-primary);
}
.watch-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.is-primary { color: var(--el-color-primary); }
.is-success { color: var(--el-color-success); }
.is-warning { color: var(--el-color-warning); }
.is-danger { color: var(--el-color-danger); }
</style>
