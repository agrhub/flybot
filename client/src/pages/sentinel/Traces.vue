<template>
  <div class="flex flex-col gap-4 sm:gap-6" data-test="sentinel-traces">
    <!-- A trace opened from a link (approval, device) -->
    <el-card v-if="openId" shadow="never">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="section-title">{{ t('sentinel.traces.opened') }}</div>
            <div class="section-subtitle font-mono truncate">{{ openId }}</div>
          </div>
          <el-button :icon="Close" circle :aria-label="t('common.close')" @click="closeOpened" />
        </div>
      </template>
      <el-skeleton v-if="opened.loading" :rows="5" animated />
      <el-alert v-else-if="opened.error" type="error" :closable="false" show-icon :title="opened.error" />
      <TraceDetail v-else-if="opened.trace" :trace="opened.trace" />
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="min-w-0">
          <div class="section-title">{{ t('sentinel.traces.title') }}</div>
          <div class="section-subtitle">{{ t('sentinel.traces.subtitle') }}</div>
        </div>

        <!-- Filters: camera and dates go to the server, the decision type is read from each trace -->
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <el-select v-model="camera" :aria-label="t('analytics.allCameras')" :placeholder="t('analytics.allCameras')" clearable filterable class="filter-camera" data-test="filter-camera">
            <template #prefix><el-icon><VideoCamera /></el-icon></template>
            <el-option v-for="c in cameraOptions" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
          <DateRangeFilter v-model="range" />
          <el-select v-model="type" :aria-label="t('sentinel.traces.allTypes')" :placeholder="t('sentinel.traces.allTypes')" clearable class="filter-select" data-test="filter-type">
            <template #prefix><el-icon><Operation /></el-icon></template>
            <el-option v-for="d in DECISION_TYPES" :key="d" :label="t(`sentinel.decision.${d}`)" :value="d" />
          </el-select>
          <el-select v-model="loop" :aria-label="t('sentinel.traces.loop')" class="filter-select">
            <el-option v-for="l in LOOPS" :key="l" :label="t(`sentinel.loops.${l}`)" :value="l" />
          </el-select>
          <el-button v-if="filtered" link type="primary" :icon="RefreshLeft" @click="clearFilters">{{ t('sentinel.traces.clear') }}</el-button>
        </div>
      </template>

      <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" class="mb-3">
        <el-button link type="primary" size="small" @click="load()">{{ t('sentinel.common.retry') }}</el-button>
      </el-alert>

      <TraceTable :items="shown" :loading="loading" />

      <div class="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4">
        <p class="meta-text" role="status" aria-live="polite">
          {{ t('common.showing') }} <strong>{{ shown.length }}</strong> {{ t('sentinel.traces.unit') }}
        </p>
        <el-button v-if="next" :loading="loading" data-test="load-more" @click="load({ append: true })">{{ t('sentinel.traces.older') }}</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { VideoCamera, Operation, RefreshLeft, Close } from '@element-plus/icons-vue';
import DateRangeFilter from '@/components/common/DateRangeFilter.vue';
import TraceTable from '@/components/sentinel/TraceTable.vue';
import TraceDetail from '@/components/sentinel/TraceDetail.vue';
import { useCameras } from '@/composables/useCameras';
import { sentinelGet, sentinelErrorKind, items } from '@/composables/useSentinel';
import { DECISION_TYPES, filterTraces } from '@/utils/sentinel/trace';
import { rangeDates } from '@/utils/dateRange';

const LOOPS = ['per_photo', 'daily_per_plot', 'followup'];
const DEFAULT_RANGE = { preset: '7d' };

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { cameras } = useCameras();

const list = ref([]);
const next = ref(null);
const loading = ref(false);
const error = ref('');
const camera = ref(typeof route.query.camera === 'string' ? route.query.camera : '');
const type = ref('');
const loop = ref('per_photo');
const range = ref({ ...DEFAULT_RANGE });
const seenCameras = ref([]);

// FlyBot's names for the cameras it knows; Sentinel-only cameras (CamOS) by serial
const cameraOptions = computed(() => {
  const names = new Map(cameras.value.filter((c) => c.deviceSerial && c.deviceSerial !== 'all').map((c) => [c.deviceSerial, c.deviceName]));
  const serials = [...new Set([...seenCameras.value, ...(camera.value ? [camera.value] : [])])].sort();
  return serials.map((s) => ({ value: s, label: names.get(s) ? `${names.get(s)} (${s})` : s }));
});
const filtered = computed(() => !!camera.value || !!type.value || loop.value !== 'per_photo' || range.value.preset !== DEFAULT_RANGE.preset);
const shown = computed(() => filterTraces(list.value, { type: type.value }));

// Server time window from FlyBot's date filter
function timeWindow() {
  const { startDate, endDate } = rangeDates(range.value);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? new Date(`${startDate}T00:00:00`).toISOString() : startDate;
  const until = endDate ? new Date(new Date(`${endDate}T00:00:00`).getTime() + 86400000 - 1).toISOString() : undefined;
  return { since, until };
}

let requestId = 0;
async function load({ append = false } = {}) {
  const id = ++requestId;
  loading.value = true;
  try {
    const res = await sentinelGet('traces', {
      ...timeWindow(),
      camera: camera.value || undefined,
      loop: camera.value ? undefined : loop.value,
      limit: 50,
      cursor: append ? next.value || undefined : undefined,
    });
    if (id !== requestId) return;
    const got = items(res);
    list.value = append ? [...list.value, ...got] : got;
    next.value = res?.next || null;
    seenCameras.value = [...new Set([...seenCameras.value, ...got.map((x) => x.camera).filter(Boolean)])];
    error.value = '';
  } catch (err) {
    if (id !== requestId) return;
    error.value = t(`sentinel.errors.${sentinelErrorKind(err)}`);
  } finally {
    if (id === requestId) loading.value = false;
  }
}

function clearFilters() {
  camera.value = '';
  type.value = '';
  loop.value = 'per_photo';
  range.value = { ...DEFAULT_RANGE };
}

watch(() => JSON.stringify([camera.value, loop.value, range.value]), () => load());

// ?id= opens one trace above the list
const openId = computed(() => (typeof route.query.id === 'string' ? route.query.id : ''));
const opened = reactive({ loading: false, trace: null, error: '' });
async function loadOpened() {
  if (!openId.value) return;
  Object.assign(opened, { loading: true, trace: null, error: '' });
  try {
    const res = await sentinelGet(`traces/${encodeURIComponent(openId.value)}`);
    Object.assign(opened, { loading: false, trace: res?.trace || res });
  } catch (err) {
    Object.assign(opened, { loading: false, error: t(`sentinel.errors.${sentinelErrorKind(err)}`) });
  }
}
watch(openId, loadOpened);
const closeOpened = () => router.replace({ query: { ...route.query, id: undefined } });

// New photos arrive every few minutes: refresh the first page (not while older pages are loaded)
let timer = null;
onMounted(() => {
  load();
  loadOpened();
  timer = setInterval(() => {
    if (list.value.length <= 50) load();
  }, 30000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.meta-text strong {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.filter-camera {
  width: 240px;
}
.filter-select {
  width: 190px;
}
@media (max-width: 767px) {
  .filter-camera,
  .filter-select {
    width: 100%;
  }
}
</style>
