<template>
  <el-card shadow="never">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="section-title">{{ t('analytics.compare.title') }}</div>
          <div class="section-desc">{{ t('analytics.compare.subtitle', { days }) }}</div>
        </div>
        <div class="flex items-center gap-2">
          <el-segmented v-model="days" :options="periodOptions" size="small" @change="load" />
          <WidgetFilter v-model="filter" :defaults="defaults" :fields="['cameras', 'risk']" />
        </div>
      </div>
    </template>

    <div v-loading="loading" class="space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          v-for="metric in metrics"
          :key="metric.key"
          :label="metric.label"
          :value="metric.value"
          :icon="metric.icon"
        >
          <template #footer>
            <el-tag
              v-if="metric.change !== null"
              :type="changeTagType(metric.change)"
              effect="light"
              round
              size="small"
            >
              {{ t('analytics.compare.vsPrevious', { change: formatChange(metric.change) }) }}
            </el-tag>
            <span v-else>{{ t('analytics.compare.noPrevious') }}</span>
          </template>
        </StatCard>
      </div>

      <div>
        <div class="subsection-title">{{ t('analytics.compare.ranking') }}</div>
        <el-table :data="rows" size="small" class="w-full">
          <template #empty>
            <el-empty :description="t('analytics.noStatsData')" :image-size="60" />
          </template>
          <el-table-column :label="t('analytics.compare.camera')" min-width="160">
            <template #default="{ row }">
              <div class="truncate">{{ row.deviceName }}</div>
              <div class="meta-text font-mono">{{ row.deviceSerial }}</div>
            </template>
          </el-table-column>
          <el-table-column :label="t('analytics.compare.totalInsects')" prop="totalInsects" align="right" min-width="110" />
          <el-table-column :label="t('analytics.compare.avgPerScan')" prop="avgPerScan" align="right" min-width="120" />
          <el-table-column :label="t('analytics.compare.peak')" align="center" min-width="140">
            <template #default="{ row }">
              <el-tag :type="RISK_TAG[row.riskLevel] || 'success'" effect="light" round size="small">
                {{ row.peakCount }} / {{ row.alertThreshold }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('analytics.compare.scans')" prop="scans" align="right" min-width="90" />
          <el-table-column :label="t('analytics.compare.change')" align="center" min-width="110">
            <template #default="{ row }">
              <el-tag v-if="row.changePct !== null" :type="changeTagType(row.changePct)" effect="plain" round size="small">
                {{ formatChange(row.changePct) }}
              </el-tag>
              <span v-else class="meta-text">--</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { DataAnalysis, DataLine, Aim } from '@element-plus/icons-vue'
import api from '@/services/api'
import StatCard from '@/components/common/StatCard.vue'
import WidgetFilter from '@/components/common/WidgetFilter.vue'
import { useWidgetFilter } from '@/composables/useWidgetFilter'

const props = defineProps({
  // Page camera filter: 'all' or one serial
  defaultCamera: { type: String, default: 'all' }
})

const { t } = useI18n()

const PERIODS = [7, 14, 30]
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' }

const days = ref(7)
const loading = ref(false)
const comparison = ref(null)

const defaults = computed(() => ({ cameras: props.defaultCamera && props.defaultCamera !== 'all' ? [props.defaultCamera] : [], risk: 'all' }))
const filter = useWidgetFilter(() => defaults.value)
// Risk level of each camera: a table filter (the totals above cover the chosen cameras)
const rows = computed(() => (comparison.value?.cameras || []).filter(row => !filter.value.risk || filter.value.risk === 'all' || row.riskLevel === filter.value.risk))

const periodOptions = computed(() => PERIODS.map(d => ({ label: t('analytics.compare.days', { days: d }), value: d })))

const metrics = computed(() => {
  const c = comparison.value
  return [
    { key: 'total', label: t('analytics.compare.totalInsects'), value: c?.current.totalInsects ?? '--', change: c?.change.totalInsects ?? null, icon: DataAnalysis },
    { key: 'avg', label: t('analytics.compare.avgPerScan'), value: c?.current.avgPerScan ?? '--', change: c?.change.avgPerScan ?? null, icon: DataLine },
    { key: 'peak', label: t('analytics.compare.peak'), value: c?.current.peakCount ?? '--', change: c?.change.peakCount ?? null, icon: Aim }
  ]
})

// More pests is bad news: increases are red, decreases green
const changeTagType = (pct) => (pct > 0 ? 'danger' : pct < 0 ? 'success' : 'info')
const formatChange = (pct) => `${pct > 0 ? '+' : ''}${pct}%`

const load = async () => {
  loading.value = true
  try {
    const res = await api.getComparison(days.value, filter.value.cameras || [])
    comparison.value = res.data?.comparison || null
  } catch (e) {
    comparison.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => filter.value.cameras, load, { deep: true })

/** The card as PDF sections (utils/analyticsPdf.js). */
const pdfSections = () => [{
  title: t('analytics.compare.title'),
  lines: [t('analytics.compare.subtitle', { days: days.value })],
  table: {
    head: [t('dashboards.pdf.figure'), t('dashboards.pdf.value'), t('analytics.compare.change')],
    body: metrics.value.map(m => [m.label, String(m.value), m.change === null ? '--' : formatChange(m.change)])
  }
}, {
  title: t('analytics.compare.ranking'),
  table: {
    head: [t('analytics.compare.camera'), t('analytics.compare.totalInsects'), t('analytics.compare.avgPerScan'), t('analytics.compare.peak'), t('analytics.compare.scans'), t('analytics.compare.change')],
    body: rows.value.map(r => [r.deviceName, String(r.totalInsects), String(r.avgPerScan), `${r.peakCount} / ${r.alertThreshold}`, String(r.scans), r.changePct === null ? '--' : formatChange(r.changePct)])
  }
}]

defineExpose({ reload: load, pdfSections })
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-desc,
.meta-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.subsection-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--el-text-color-primary);
}
</style>
