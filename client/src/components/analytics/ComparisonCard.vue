<template>
  <el-card shadow="never">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="section-title">{{ t('analytics.compare.title') }}</div>
          <div class="section-desc">{{ t('analytics.compare.subtitle', { days }) }}</div>
        </div>
        <el-segmented v-model="days" :options="periodOptions" size="small" @change="load" />
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
        <el-table :data="comparison?.cameras || []" size="small" class="w-full">
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
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { DataAnalysis, DataLine, Aim } from '@element-plus/icons-vue'
import api from '@/services/api'
import StatCard from '@/components/common/StatCard.vue'

const { t } = useI18n()

const PERIODS = [7, 14, 30]
const RISK_TAG = { high: 'danger', moderate: 'warning', low: 'success' }

const days = ref(7)
const loading = ref(false)
const comparison = ref(null)

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
    const res = await api.getComparison(days.value)
    comparison.value = res.data?.comparison || null
  } catch (e) {
    comparison.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)

defineExpose({ reload: load })
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
