<template>
  <div class="flex flex-col gap-4" data-test="sentinel-bench">
    <el-alert type="info" :closable="false" show-icon :title="t('sentinel.bench.intro')" />
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />

    <el-card shadow="never" v-loading="loading" :element-loading-text="t('common.loading')">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="section-title">{{ bench.title || t('sentinel.bench.title') }}</div>
            <div class="section-subtitle">{{ bench.note || t('sentinel.bench.subtitle') }}</div>
          </div>
          <el-select v-if="files.length" v-model="file" :aria-label="t('sentinel.bench.file')" class="bench-file" data-test="bench-file">
            <template #prefix><el-icon><Document /></el-icon></template>
            <el-option v-for="f in files" :key="f.name" :label="f.name" :value="f.name" />
          </el-select>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-3" data-test="bench-groups">
          <el-tag v-for="g in GROUPS" :key="g" :type="grouped[g].length ? 'success' : 'info'" effect="light" size="small" round>
            {{ t(`sentinel.bench.groups.${g}`) }}: {{ grouped[g].length ? grouped[g].length : t('sentinel.bench.pendingGroup') }}
          </el-tag>
        </div>
      </template>

      <el-empty v-if="!files.length && !loading" :description="t('sentinel.bench.empty')" :image-size="80" data-test="bench-empty" />
      <template v-else-if="files.length">
        <el-alert v-if="bench.empty && !loading" type="warning" :closable="false" show-icon :title="t('sentinel.bench.emptyArms')" class="mb-3" />

        <template v-if="!bench.empty">
          <div class="section-label">{{ t('sentinel.bench.chart') }}</div>
          <CatchBarChart :labels="chartLabels" :series="chartSeries" :stacked="false" :height="isMobile ? 220 : 260" y-title="ms" :empty-text="t('sentinel.bench.noLatency')" />

          <el-table :data="bench.arms" size="small" class="w-full mt-4" data-test="bench-table">
            <el-table-column prop="label" :label="t('sentinel.bench.arm')" min-width="150" fixed />
            <el-table-column :label="t('sentinel.bench.instance')" min-width="110">
              <template #default="{ row }">{{ row.instance || '--' }}</template>
            </el-table-column>
            <el-table-column :label="t('sentinel.bench.opencv')" min-width="90">
              <template #default="{ row }">{{ row.opencv || '--' }}</template>
            </el-table-column>
            <el-table-column v-for="col in NUM_COLS" :key="col.key" :label="t(`sentinel.bench.${col.key}`)" :min-width="col.width" align="right">
              <template #default="{ row }">{{ fmt(row[col.key], col.digits) }}</template>
            </el-table-column>
          </el-table>

          <template v-if="opNames.length">
            <div class="section-label mt-5">{{ t('sentinel.bench.perOp') }}</div>
            <el-table :data="opRows" size="small" class="w-full" data-test="bench-ops">
              <el-table-column prop="op" :label="t('sentinel.bench.op')" min-width="160" fixed />
              <el-table-column v-for="a in bench.arms" :key="a.label" :label="`${a.label} p50 / p95`" min-width="150" align="right">
                <template #default="{ row }">{{ row[a.label] }}</template>
              </el-table-column>
            </el-table>
          </template>
        </template>

        <el-collapse v-if="bench.raw" class="bench-raw mt-4">
          <el-collapse-item :title="t('sentinel.bench.raw')" name="raw">
            <pre class="bench-pre">{{ JSON.stringify(bench.raw, null, 2) }}</pre>
          </el-collapse-item>
        </el-collapse>
      </template>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Document } from '@element-plus/icons-vue';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { sentinelGet, sentinelErrorKind, items } from '@/composables/useSentinel';
import { armGroup, normalizeBench } from '@/utils/sentinel/bench';

/** Per-photo pipeline cost: COOL build on Graviton vs pip arm64 vs pip x86 (bench/results files). */
const GROUPS = ['cool', 'pip_arm64', 'pip_x86'];
const NUM_COLS = [
  { key: 'p50', digits: 1, width: 80 },
  { key: 'p95', digits: 1, width: 80 },
  { key: 'fps', digits: 1, width: 70 },
  { key: 'cpu', digits: 1, width: 70 },
  { key: 'rss', digits: 0, width: 80 },
  { key: 'cost', digits: 4, width: 110 },
  { key: 'n', digits: 0, width: 70 },
];

const { t } = useI18n();
const { isMobile } = useBreakpoints();
const files = ref([]);
const file = ref('');
const bench = ref(normalizeBench(null));
const loading = ref(false);
const error = ref('');

const grouped = computed(() => {
  const out = Object.fromEntries([...GROUPS, 'other'].map((g) => [g, []]));
  for (const a of bench.value.arms) out[armGroup(a)].push(a);
  return out;
});
const chartArms = computed(() => bench.value.arms.filter((a) => a.p50 !== null));
const chartLabels = computed(() => chartArms.value.map((a) => a.label));
const chartSeries = computed(() => [
  { label: t('sentinel.bench.p50'), data: chartArms.value.map((a) => a.p50) },
  { label: t('sentinel.bench.p95'), data: chartArms.value.map((a) => a.p95) },
]);
const opNames = computed(() => [...new Set(bench.value.arms.flatMap((a) => a.perOp.map((o) => o.op)))]);
const opRows = computed(() => opNames.value.map((op) => ({
  op,
  ...Object.fromEntries(bench.value.arms.map((a) => {
    const hit = a.perOp.find((o) => o.op === op);
    return [a.label, `${fmt(hit?.p50)} / ${fmt(hit?.p95)}`];
  })),
})));
const fmt = (v, digits = 1) => (v === null || v === undefined ? '--' : Number(v).toFixed(digits));

async function loadFiles() {
  loading.value = true;
  try {
    files.value = items(await sentinelGet('bench'));
    if (files.value.length && !files.value.some((f) => f.name === file.value)) file.value = files.value[0].name;
    if (!files.value.length) bench.value = normalizeBench(null);
    error.value = '';
  } catch (err) {
    error.value = t(`sentinel.errors.${sentinelErrorKind(err)}`);
  } finally {
    loading.value = false;
  }
}

async function loadFile() {
  if (!file.value) return;
  loading.value = true;
  try {
    bench.value = normalizeBench(await sentinelGet('bench', { name: file.value }));
    error.value = '';
  } catch (err) {
    error.value = t(`sentinel.errors.${sentinelErrorKind(err)}`);
  } finally {
    loading.value = false;
  }
}

watch(file, loadFile);
onMounted(loadFiles);
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
.section-label {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.bench-file {
  width: 240px;
}
.bench-raw {
  border: none;
}
.bench-raw :deep(.el-collapse-item__header) {
  font-size: 13px;
  color: var(--el-color-primary);
}
.bench-pre {
  margin: 0;
  padding: 8px;
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
@media (max-width: 767px) {
  .bench-file {
    width: 100%;
  }
}
</style>
