<template>
  <el-card shadow="never" class="mb-4" v-loading="loading">
    <template #header>
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="min-w-0">
          <h3 class="section-title">{{ t('farms.compare.title') }}</h3>
          <p class="section-desc">{{ t('farms.compare.desc') }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <el-radio-group v-model="period" size="small" @change="load">
            <el-radio-button v-for="p in PERIODS" :key="p" :value="p">{{ t('farms.compare.days', { days: p }) }}</el-radio-button>
          </el-radio-group>
          <el-button size="small" :icon="Download" :disabled="!withTraps.length" :loading="exporting" @click="exportExcel">{{ t('farms.compare.export') }}</el-button>
        </div>
      </div>
    </template>

    <el-empty v-if="!withTraps.length && !loading" :image-size="80" :description="t('farms.compare.empty')" />

    <template v-else>
      <!-- Flies per trap per day, one line per farm (the busiest ones) -->
      <CatchBarChart
        :labels="labels"
        :series="series"
        :stacked="false"
        :height="isMobile ? 220 : 260"
        :y-title="t('farms.compare.ftd')"
        :empty-text="t('farms.compare.noCatches')"
      />

      <!-- Phones: one card per farm -->
      <div v-if="isMobile" class="flex flex-col gap-3 mt-4">
        <div v-for="farm in farms" :key="farm.id" class="cmp-row">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="cmp-strong">{{ farm.name }}</p>
              <p class="cmp-meta">{{ t('farms.compare.traps', { count: farm.traps }) }} · {{ t('farms.compare.treatmentsCount', { count: farm.treatments }) }}</p>
              <p v-if="farm.worstPlot" class="cmp-meta">{{ t('farms.compare.worstPlotValue', { name: farm.worstPlot.name, ftd: farm.worstPlot.ftd }) }}</p>
            </div>
            <div class="text-right">
              <p class="cmp-strong">{{ farm.ftd ?? '--' }}</p>
              <ChangeTag :pct="farm.changePct" />
            </div>
          </div>
        </div>
      </div>

      <!-- Larger screens: table, each farm opens to its plots -->
      <el-table v-else :data="farms" row-key="id" class="mt-4" style="width: 100%">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="px-4 py-2">
              <el-table v-if="row.plots.length" :data="row.plots" size="small" style="width: 100%">
                <el-table-column :label="t('farms.compare.plot')" prop="name" min-width="180" />
                <el-table-column :label="t('farms.compare.trapsCol')" prop="traps" width="110" />
                <el-table-column :label="t('farms.compare.ftd')" width="150">
                  <template #default="{ row: plot }">{{ plot.ftd ?? '--' }}</template>
                </el-table-column>
                <el-table-column :label="t('farms.compare.change')" width="150">
                  <template #default="{ row: plot }"><ChangeTag :pct="plot.changePct" /></template>
                </el-table-column>
              </el-table>
              <p v-else class="cmp-meta">{{ t('farms.compare.noPlots') }}</p>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('farms.compare.farm')" min-width="200">
          <template #default="{ row }"><span class="cmp-strong">{{ row.name }}</span></template>
        </el-table-column>
        <el-table-column :label="t('farms.compare.trapsCol')" prop="traps" width="90" />
        <el-table-column :label="t('farms.compare.ftd')" width="140">
          <template #default="{ row }"><span class="cmp-strong">{{ row.ftd ?? '--' }}</span></template>
        </el-table-column>
        <el-table-column :label="t('farms.compare.change')" width="150">
          <template #default="{ row }"><ChangeTag :pct="row.changePct" /></template>
        </el-table-column>
        <el-table-column :label="t('farms.compare.worstPlot')" min-width="170">
          <template #default="{ row }">
            <span v-if="row.worstPlot" class="cmp-meta">{{ t('farms.compare.worstPlotValue', { name: row.worstPlot.name, ftd: row.worstPlot.ftd }) }}</span>
            <span v-else class="cmp-meta">--</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('farms.compare.treatments')" width="120">
          <template #default="{ row }"><span class="cmp-meta">{{ row.treatments }}</span></template>
        </el-table-column>
      </el-table>
    </template>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import api from '@/services/api';
import ChangeTag from '@/components/common/ChangeTag.vue';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { requestErrorText } from '@/utils/requestError';
import CatchBarChart from '@/components/charts/CatchBarChart.vue';
import { Download } from '@element-plus/icons-vue';
import { farmCompareSheets, downloadSheets } from '@/utils/tableExport';

const PERIODS = [7, 30, 90];
// Lines for the busiest farms; more would not be readable
const MAX_LINES = 5;
const LINE_COLORS = ['--el-color-primary', '--el-color-warning', '--el-color-danger', '--el-color-info', '--el-color-success'];

const { t } = useI18n();
const { isMobile } = useBreakpoints();

const period = ref(30);
const days = ref([]);
const farms = ref([]);
const loading = ref(false);

const withTraps = computed(() => farms.value.filter(f => f.traps > 0));
const labels = computed(() => days.value.map(d => `${d.slice(8, 10)}/${d.slice(5, 7)}`));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const series = computed(() => withTraps.value.slice(0, MAX_LINES).map((farm, i) => ({
  label: farm.name,
  data: farm.series,
  type: 'line',
  color: cssVar(LINE_COLORS[i]) || undefined
})));

const load = async () => {
  loading.value = true;
  try {
    const res = await api.compareFarms(period.value);
    days.value = res.data.days || [];
    farms.value = res.data.farms || [];
  } catch (err) {
    ElMessage.error(requestErrorText(t, err, t('common.error')));
  } finally {
    loading.value = false;
  }
};

// The table as it is shown (farms with traps first), one sheet for farms and one for plots
const exporting = ref(false);
const exportExcel = async () => {
  exporting.value = true;
  try {
    await downloadSheets(`FlyBot_farms_${period.value}d_${new Date().toISOString().slice(0, 10)}.xlsx`, farmCompareSheets(farms.value, period.value, t));
  } catch (err) {
    ElMessage.error(requestErrorText(t, err, t('common.error')));
  } finally {
    exporting.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-desc,
.cmp-meta {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.cmp-strong {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.cmp-row {
  padding: 12px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-bg-color-overlay);
}
</style>
