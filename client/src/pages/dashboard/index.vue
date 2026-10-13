<template>
  <div class="w-full max-w-7xl mx-auto pb-12 select-none space-y-6">
    <!-- Page header -->
    <PageHeader
      :title="t('dashboard.title')"
      :subtitle="`${t('dashboard.welcome')}, ${userName}`"
    />

    <!-- Areas still inside a pre-harvest interval after a treatment -->
    <el-alert v-if="withholding.length" type="warning" :closable="false" show-icon>
      <template #title>{{ t('dashboard.withholding.title', { count: withholding.length }) }}</template>
      <ul class="withholding-list">
        <li v-for="w in withholding.slice(0, 5)" :key="w.id">
          <b>{{ w.area || w.traps.join(', ') }}</b>
          <span>{{ t('dashboard.withholding.item', { product: w.product || t(`logbook.types.${w.type}`), date: formatHarvest(w.harvestAllowedFrom) }) }}</span>
        </li>
      </ul>
      <el-button link type="primary" @click="router.push('/logbook')">{{ t('dashboard.withholding.open') }}</el-button>
    </el-alert>

    <!-- Key metrics -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <!-- Insects that arrived today, all traps -->
      <StatCard
        :label="t('dashboard.catchesToday')"
        :value="catches.today ?? '--'"
        :unit="t('dashboard.individualsUnit')"
        :description="catches.yesterday !== null && catches.yesterday !== undefined ? t('dashboard.catchesYesterday', { count: catches.yesterday }) : t('dashboard.catchesHint')"
        :icon="Lightning"
        type="warning"
      />

      <!-- Flies per trap per day over the last 7 days -->
      <StatCard
        :label="t('dashboard.ftd7')"
        :value="catches.ftd7 ?? '--'"
        :unit="t('dashboard.ftdUnit')"
        :description="ftdChangeText"
        :icon="DataAnalysis"
        :type="catches.changePct > 15 ? 'danger' : catches.changePct < -15 ? 'success' : 'primary'"
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
        :description="t('dashboard.riskBasis')"
        :icon="Warning"
        :type="riskTagType"
      >
        <template #value>
          <el-tag :type="riskTagType" effect="light" round class="risk-tag">{{ riskLabel }}</el-tag>
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
            <el-button link type="primary" :icon="Setting" @click="router.push({ path: '/settings', query: { tab: 'notifications' } })">
              {{ t('dashboard.alertThreshold') }}
            </el-button>
          </div>
        </template>

        <div class="space-y-3">
          <div
            v-for="cam in (overviewData.cameraRealtimeList || [])"
            :key="cam.deviceSerial"
            @click="selectCameraAndGoToLive(cam)"
            @keydown.enter.prevent="selectCameraAndGoToLive(cam)"
            @keydown.space.prevent="selectCameraAndGoToLive(cam)"
            role="button"
            tabindex="0"
            class="density-item"
          >
            <div class="flex items-center justify-between gap-3 mb-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="status-dot" :class="cam.status ? 'is-online' : 'is-idle'"></span>
                <span class="item-name truncate">{{ cam.deviceName || cam.deviceSerial }}</span>
                <span class="meta-text font-mono truncate">({{ cam.deviceSerial }})</span>
              </div>
              <div class="shrink-0 text-right">
                <span class="meta-text mr-1">{{ cam.riskBasis === 'dailyAverage' ? t('dashboard.averageToday') : t('dashboard.onTrapNow') }}</span>
                <span class="item-count" :class="`is-${levelTagType(cam.riskLevel)}`">{{ cam.riskValue ?? cam.currentCount }}</span>
                <span class="meta-text ml-1">/ {{ cam.alertThreshold }} {{ t('dashboard.insectsShort') }}</span>
              </div>
            </div>

            <el-progress
              :aria-label="t('dashboard.levelOf', { name: cam.deviceName || cam.deviceSerial })"
              :percentage="Math.min(100, Math.max(4, ((cam.riskValue ?? cam.currentCount) / (cam.alertThreshold || 15)) * 100))"
              :color="`var(--el-color-${levelTagType(cam.riskLevel)})`"
              :stroke-width="8"
              :show-text="false"
            />

            <div class="flex items-center justify-between gap-3 mt-2">
              <span class="meta-text truncate">
                {{ t(cam.trapKind === 'lure' ? 'dashboard.camPresence' : 'dashboard.camCatches', { today: cam.today ?? '--', ftd: cam.ftd7 ?? '--' }) }}
                · {{ cam.locationAddress || t('map.noAddress') }}
              </span>
              <div class="flex items-center gap-1.5 shrink-0">
                <el-tag v-if="cam.cardDueAt && new Date(cam.cardDueAt) <= new Date()" type="warning" effect="plain" round size="small">
                  {{ t('maintenance.overdue') }}
                </el-tag>
                <el-tag :type="levelTagType(cam.riskLevel)" effect="light" round size="small">
                  {{ riskLevelLabel(cam.riskLevel) }}
                </el-tag>
              </div>
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
          <h3 class="section-title">{{ t('dashboard.catchStatsTitle') }}</h3>
          <p class="section-desc">{{ t('dashboard.catchStatsDesc') }}</p>
        </template>

        <el-radio-group v-model="selectedPeriod" size="small" class="period-switch mb-4">
          <el-radio-button v-for="p in periodOptions" :key="p.key" :value="p.key">
            {{ p.label }}
          </el-radio-button>
        </el-radio-group>

        <div class="grid grid-cols-2 gap-3">
          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statTotal') }}</span>
            <div class="mini-stat__value is-primary">{{ currentPeriodStats.total ?? 0 }}</div>
            <span class="meta-text">{{ t('dashboard.statTotalUnit') }}</span>
          </div>

          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statFtd') }}</span>
            <div class="mini-stat__value is-success">{{ currentPeriodStats.ftd ?? '--' }}</div>
            <span class="meta-text">{{ t('dashboard.ftdUnit') }}</span>
          </div>

          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statAvgDay') }}</span>
            <div class="mini-stat__value">{{ currentPeriodStats.avgPerDay ?? '--' }}</div>
            <span class="meta-text">{{ t('dashboard.statAvgDayUnit') }}</span>
          </div>

          <div class="mini-stat">
            <span class="meta-text">{{ t('dashboard.statMaxDay') }}</span>
            <div class="mini-stat__value is-danger">{{ currentPeriodStats.maxDay?.value ?? '--' }}</div>
            <span class="meta-text">{{ currentPeriodStats.maxDay ? shortDay(currentPeriodStats.maxDay.day) : '--' }}</span>
          </div>
        </div>

        <el-divider class="!my-4" />

        <div class="flex items-center justify-between gap-3">
          <span class="meta-text">{{ t('dashboard.dominantSpeciesLabel') }}</span>
          <span class="species-value truncate">{{ formatSpeciesDisplay(overviewData.topSpecies) }}</span>
        </div>
      </el-card>
    </section>

    <!-- Daily catches over two weeks, per trap -->
    <el-card shadow="never">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h3 class="section-title">{{ t('dashboard.catchChartTitle') }}</h3>
            <p class="section-desc">{{ t('dashboard.catchChartDesc') }}</p>
          </div>
          <el-button link type="primary" :icon="DataAnalysis" @click="router.push('/analytics')">{{ t('dashboard.moreAnalytics') }}</el-button>
        </div>
      </template>
      <CatchBarChart
        :labels="catchChart.labels"
        :series="catchChart.series"
        :height="260"
        :y-title="t('dashboard.statTotalUnit')"
        :empty-text="t('dashboard.noRealtimeData')"
      />
    </el-card>

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
            <div class="flex flex-wrap items-center gap-2">
              <el-tag :type="TRAJECTORY_TAG[diagnosisResult.forecast?.trajectory] || 'info'" effect="light" round size="small">
                {{ t(`dashboard.diagnosis.trajectory.${diagnosisResult.forecast?.trajectory || 'stable'}`) }}
              </el-tag>
              <span class="meta-text">
                {{ t('dashboard.modelConfidence') }}
                {{ t(`dashboard.diagnosis.confidence.${diagnosisResult.forecast?.confidence || 'low'}`) }}
                · {{ t('dashboard.diagnosis.basis', { days: diagnosisResult.forecast?.dataDays || 0 }) }}
              </span>
            </div>
          </div>

          <p class="meta-text mb-1">{{ t(diagnosisResult.trapKind === 'lure' ? 'dashboard.forecastBasisLure' : 'dashboard.forecastBasis', { name: diagnosisResult.peakCamera?.deviceName || '' }) }}</p>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 meta-text">
            <span v-if="diagnosisResult.peakCamera">
              {{ t('dashboard.diagnosis.peakTrap', {
                name: diagnosisResult.peakCamera.deviceName,
                count: diagnosisResult.currentPeakCount,
                threshold: diagnosisResult.peakCamera.alertThreshold
              }) }}
            </span>
            <span v-if="diagnosisResult.weather" class="inline-flex items-center gap-1">
              <el-icon><Sunny /></el-icon>
              {{ t('dashboard.diagnosis.weather', {
                temperature: diagnosisResult.weather.temperature,
                humidity: diagnosisResult.weather.humidity
              }) }}
              <template v-if="diagnosisResult.weatherFactor">
                · {{ t(`dashboard.diagnosis.weatherFactor.${diagnosisResult.weatherFactor}`) }}
              </template>
            </span>
            <span v-else>{{ t('dashboard.diagnosis.weatherUnavailable') }}</span>
          </div>

          <!-- Forecast bars (data visualization) -->
          <div class="grid grid-cols-7 gap-2 h-28 items-end pt-4 pb-1">
            <div
              v-for="(day, i) in (diagnosisResult.forecast?.days || [])"
              :key="i"
              class="flex flex-col items-center gap-1.5 h-full justify-end"
            >
              <span class="meta-text font-semibold">{{ day.projectedCount }}</span>
              <span v-if="day.projectedCatches !== undefined && diagnosisResult.trapKind !== 'lure'" class="forecast-add">+{{ day.projectedCatches }}</span>
              <div
                class="forecast-bar w-full"
                :style="{
                  height: `${Math.min(100, Math.max(6, (day.projectedCount / forecastScale) * 100))}%`,
                  backgroundColor: `var(--el-color-${levelTagType(day.risk)})`
                }"
              ></div>
              <span class="meta-text font-mono">{{ day.date }}</span>
            </div>
          </div>
        </div>

        <!-- Next adult wave from accumulated heat (degree-days) -->
        <DegreeDayPanel :model="diagnosisResult.degreeDays" />

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
                <span class="rec-zone truncate" :title="getTargetZoneLabel(rec)">{{ getTargetZoneLabel(rec) }}</span>
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

          <!-- Latest analyzed photo with its detection boxes -->
          <AnnotatedSnapshot
            class="mt-3"
            :item="latestOf(cam)?.latestSnapshot || null"
            :title="cam.deviceName || cam.deviceSerial"
            :count="latestOf(cam)?.latestSnapshot ? latestOf(cam).currentCount : null"
            @open="openSnapshot"
          />

          <el-divider class="!my-3" />

          <div class="flex items-center justify-between gap-2">
            <span class="meta-text truncate">{{ cam.locationAddress || t('map.noAddress') }}</span>
            <span class="watch-link shrink-0" @keydown.enter.prevent="selectCameraAndGoToLive(cam)" @keydown.space.prevent="selectCameraAndGoToLive(cam)" role="button" tabindex="0">
              {{ t('dashboard.watchStream') }}
              <el-icon><Right /></el-icon>
            </span>
          </div>
        </el-card>
      </div>
    </el-card>

    <DetectionModal :visible="snapshotVisible" :item="openedSnapshot" @close="snapshotVisible = false" @updated="(s) => (openedSnapshot = { ...openedSnapshot, ...s })" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { requestErrorText } from '@/utils/requestError';
import { useCameras } from '@/composables/useCameras';
import api from '@/services/api';
import { ElNotification } from 'element-plus';
import AnnotatedSnapshot from '@/components/common/AnnotatedSnapshot.vue';
import DetectionModal from '@/components/modals/DetectionModal.vue';
import {
  Lightning,
  DataAnalysis,
  VideoCamera,
  Warning,
  MagicStick,
  Cpu,
  TrendCharts,
  ArrowRight,
  Right,
  Setting,
  Sunny
} from '@element-plus/icons-vue';
import PageHeader from '@/components/common/PageHeader.vue';
import StatCard from '@/components/common/StatCard.vue';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';
import DegreeDayPanel from '@/components/dashboard/DegreeDayPanel.vue';
import { speciesShare } from '@/utils/species';

const router = useRouter();
const { t, locale } = useI18n();
const { cameras, selectCameraAndGoToLive } = useCameras();

const formatSpeciesDisplay = (topSpecies) => speciesShare(topSpecies, t);

// The diagnosis API returns stable keys; all display text comes from dashboard.diagnosis.*
const getUrgencyLabel = (rec) => t(`dashboard.diagnosis.urgency.${rec.urgency || 'normal'}`);
const recText = (rec, field) => (rec.key ? t(`dashboard.diagnosis.recs.${rec.key}.${field}`) : '');
const getMethodLabel = (rec) => recText(rec, 'method');
const getTitleLabel = (rec) => recText(rec, 'title');
const getDescLabel = (rec) => recText(rec, 'desc');
const getTargetZoneLabel = (rec) =>
  rec.targetCameras?.length ? rec.targetCameras.join(', ') : recText(rec, 'zone');

// Element Plus tag type per recommendation urgency
const urgencyTagType = (urgency) => {
  if (urgency === 'urgent') return 'danger';
  if (urgency === 'important') return 'warning';
  if (urgency === 'recommended') return 'primary';
  return 'info';
};

// Status type for realtime density per camera (same thresholds as the labels)
// Risk levels come from the API (each camera's own alert threshold); only map them to colors here
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' };
const levelTagType = (level) => RISK_TAG[level] || 'success';
const riskLevelLabel = (level) => (level === 'high'
  ? t('dashboard.pestHotspot')
  : level === 'moderate' ? t('dashboard.moderateLevel') : t('dashboard.wellControlled'));
const TRAJECTORY_TAG = { surging: 'danger', declining: 'success', stable: 'info' };

// Status type for projected forecast counts
// Bar height scale: the larger of the alert threshold and the highest projection
const forecastScale = computed(() => Math.max(
  diagnosisResult.value?.referenceThreshold || 15,
  ...(diagnosisResult.value?.forecast?.days || []).map(d => d.projectedCount),
  1
));

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

// Overview entry of a camera card (latest snapshot with its detections)
const realtimeBySerial = computed(() => new Map((overviewData.value.cameraRealtimeList || []).map(c => [c.deviceSerial, c])));
const latestOf = (cam) => realtimeBySerial.value.get(cam.deviceSerial);
const snapshotVisible = ref(false);
const openedSnapshot = ref(null);
const openSnapshot = (snapshot) => {
  openedSnapshot.value = snapshot;
  snapshotVisible.value = true;
};

const selectedPeriod = ref('day'); // 'day' | 'week' | 'month'
const periodOptions = computed(() => [
  { key: 'day', label: t('dashboard.periodDay') },
  { key: 'week', label: t('dashboard.periodWeek') },
  { key: 'month', label: t('dashboard.periodMonth') }
]);

// Catches: insects that arrived per day (see server/src/services/catchStats.js)
const catches = computed(() => overviewData.value.catches || {});
const currentPeriodStats = computed(() => catches.value.periods?.[selectedPeriod.value] || {});
const shortDay = (key) => (key ? `${key.slice(8, 10)}/${key.slice(5, 7)}` : '');
const ftdChangeText = computed(() => {
  const c = catches.value;
  if (c.ftdPrev7 === null || c.ftdPrev7 === undefined) return t('dashboard.ftdHint');
  const change = c.changePct === null || c.changePct === undefined ? '' : ` (${c.changePct > 0 ? '+' : ''}${c.changePct}%)`;
  return t('dashboard.ftdPrev', { value: c.ftdPrev7, change });
});
const catchChart = computed(() => {
  const series14 = catches.value.series14 || [];
  const names = new Map((overviewData.value.cameraRealtimeList || []).map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
  return {
    labels: series14.map(d => shortDay(d.day)),
    series: [...names.keys()].map(serial => ({ label: names.get(serial), data: series14.map(d => d.byCamera?.[serial] ?? null) }))
  };
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
      message: t('dashboard.diagnosisFailed', { error: requestErrorText(t, err, err.message) }),
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

// ---------- Pre-harvest intervals ----------
const withholding = ref([]);
// 17/10 06:00 in Vietnamese, 10/17 06:00 in English
const formatHarvest = (v) => {
  const d = new Date(v);
  const pad = (n) => String(n).padStart(2, '0');
  const day = locale.value === 'vi' ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const loadWithholding = async () => {
  try {
    withholding.value = (await api.listWithholding()).data.treatments || [];
  } catch {
    // Not worth an error on the overview: the field log shows the same
    withholding.value = [];
  }
};

onMounted(async () => {
  loadWithholding();
  await loadOverview();
  await runDeepDiagnosis();
});
</script>

<style scoped>
.withholding-list {
  margin: 4px 0 2px;
  padding: 0;
  list-style: none;
  font-size: 13px;
}
.withholding-list span {
  margin-left: 6px;
}
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
/* Long risk labels wrap instead of being cut off on phones */
.risk-tag {
  height: auto;
  padding-top: 2px;
  padding-bottom: 2px;
  white-space: normal;
  line-height: 1.4;
}
.forecast-add {
  font-size: 11px;
  color: var(--el-text-color-secondary);
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
