<template>
  <div class="flex flex-col gap-4 w-full pb-10">
    <!-- Summary cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      <StatCard
        :label="isSingleCamera ? t('analytics.realtimeDensityTrap') : t('analytics.realtimeHotspotMax')"
        :value="realtimeInsectCount"
        :unit="t('analytics.insectsUnit')"
        :description="isSingleCamera ? (props.camera?.deviceName || props.camera?.deviceSerial) : t('analytics.peakAcrossTraps')"
        :icon="Aim"
        type="warning"
      />

      <StatCard
        :label="t('analytics.topSpeciesCard')"
        :value="formatSpeciesDisplay(topSpecies)"
        :description="t('analytics.topSpeciesDesc')"
        :icon="PieChart"
        type="primary"
      />

      <StatCard
        :label="t('analytics.scanCountCard')"
        :value="scanCount.toLocaleString()"
        :description="t('analytics.dataPointsUnit')"
        :icon="DataLine"
      />

      <StatCard
        :label="t('analytics.forecastCard')"
        :description="t('analytics.forecastTrend')"
        :icon="TrendCharts"
        :type="forecastType"
      >
        <template #value>
          <span class="inline-flex items-center gap-2">
            <span>{{ forecastText }}</span>
            <el-icon v-if="forecastIconComponent" :size="20">
              <component :is="forecastIconComponent" />
            </el-icon>
          </span>
        </template>
      </StatCard>
    </div>

    <!-- Charts row -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <!-- Main line chart -->
      <el-card shadow="never" class="lg:col-span-2">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="section-title">{{ t('analytics.densityChart') }}</span>
            <el-segmented
              :model-value="currentMode"
              :options="modes"
              size="small"
              @change="setMode"
            />
          </div>
        </template>

        <div
          v-loading="loading"
          :element-loading-text="t('analytics.loadingData')"
          class="h-[400px] relative"
        >
          <canvas v-show="statsData.length > 0" ref="lineChartRef"></canvas>
          <div
            v-show="!loading && statsData.length === 0"
            class="h-full flex items-center justify-center"
          >
            <el-empty :description="t('analytics.noStatsData')" :image-size="80" />
          </div>
        </div>
      </el-card>

      <!-- Species ratio doughnut chart -->
      <el-card shadow="never">
        <template #header>
          <span class="section-title">{{ t('analytics.speciesRatio') }}</span>
        </template>
        <div class="h-[320px] flex items-center justify-center relative">
          <canvas v-show="speciesList.length > 0" ref="pieChartRef"></canvas>
          <el-empty
            v-show="speciesList.length === 0"
            :description="t('analytics.noRatioData')"
            :image-size="80"
          />
        </div>
      </el-card>
    </div>

    <!-- This period vs the previous one, per camera -->
    <ComparisonCard />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import Chart from 'chart.js/auto'
import api from '@/services/api'
import { ElNotification } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { Aim, Bottom, DataLine, Minus, PieChart, Top, TrendCharts } from '@element-plus/icons-vue'
import StatCard from '@/components/common/StatCard.vue'
import ComparisonCard from '@/components/analytics/ComparisonCard.vue'
import { FRUIT_FLY, normalizeSpecies, speciesName, speciesShare } from '@/utils/species'

const { t } = useI18n()

const props = defineProps({
  camera: Object,
  timeRange: { type: String, default: '30d' },
  startDate: { type: String, default: null },
  endDate: { type: String, default: null },
  active: { type: Boolean, default: true }
})

const formatSpeciesName = (species) => speciesName(species, t);
const formatSpeciesDisplay = (str) => speciesShare(str, t);

const modes = computed(() => [
  { label: t('analytics.periodHour'), value: 'hour' },
  { label: t('analytics.periodDay'), value: 'day' },
  { label: t('analytics.periodMonth'), value: 'month' }
])

const currentMode = ref('day')
const loading = ref(false)
const statsData = ref([])

const lineChartRef = ref(null)
const pieChartRef = ref(null)
let lineChartInstance = null
let pieChartInstance = null

const realtimeInsectCount = ref(0)
const scanCount = ref(0)
const topSpecies = ref('--')
const forecastStatus = ref('stable')
const forecastText = computed(() => {
  if (forecastStatus.value === 'up') return t('analytics.forecastUp')
  if (forecastStatus.value === 'down') return t('analytics.forecastDown')
  return t('analytics.forecastStable')
})
// Forecast icon key: 'up' | 'down' | 'stable' | '' (no icon when there is not enough data)
const forecastIcon = ref('')
const forecastIconComponent = computed(() => {
  if (forecastIcon.value === 'up') return Top
  if (forecastIcon.value === 'down') return Bottom
  if (forecastIcon.value === 'stable') return Minus
  return null
})
// Rising insect counts are bad (danger), falling are good (success)
const forecastType = computed(() => {
  if (forecastIcon.value === 'up') return 'danger'
  if (forecastIcon.value === 'down') return 'success'
  return 'default'
})
const speciesList = ref([])

const isSingleCamera = computed(() => {
  return props.camera && props.camera.deviceSerial && props.camera.deviceSerial !== 'all'
})

const setMode = (mode) => {
  currentMode.value = mode
  fetchStatistics()
}

const loadRealtimeMetrics = async () => {
  try {
    const res = await api.getAiOverview()
    if (res.data?.success && res.data.overview) {
      const ov = res.data.overview
      if (isSingleCamera.value) {
        const found = (ov.cameraRealtimeList || []).find(c => c.deviceSerial === props.camera.deviceSerial)
        realtimeInsectCount.value = found ? found.currentCount : 0
      } else {
        realtimeInsectCount.value = ov.peakRealtimeInsects || 0
      }
      topSpecies.value = ov.topSpecies || '--'
    }
  } catch (e) {
    console.error('Failed to load realtime metrics for stats:', e)
  }
}

// Card replacements of the selected camera, as period keys matching the chart's dateKey
const cardMarkerKeys = ref(new Set())
const markerFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
})
const periodKeyOf = (date, mode) => {
  const parts = Object.fromEntries(markerFormat.formatToParts(new Date(date)).map(p => [p.type, p.value]))
  const day = `${parts.year}-${parts.month}-${parts.day}`
  if (mode === 'hour') return `${day} ${parts.hour}:00`
  return mode === 'month' ? day.slice(0, 7) : day
}
const loadCardMarkers = async (serial) => {
  if (!serial || serial === 'all') {
    cardMarkerKeys.value = new Set()
    return
  }
  try {
    const res = await api.getMaintenance(serial, 100)
    const changes = (res.data.events || []).filter(e => e.type === 'card_replaced')
    cardMarkerKeys.value = new Set(changes.map(e => periodKeyOf(e.at, currentMode.value)))
  } catch (e) {
    cardMarkerKeys.value = new Set()
  }
}

// Dashed vertical line at each period where the sticky card was replaced
const cardMarkerPlugin = {
  id: 'cardMarkers',
  afterDatasetsDraw(chart, _args, opts) {
    const indexes = opts?.indexes || []
    if (!indexes.length) return
    const { ctx, chartArea: { top, bottom, right }, scales: { x } } = chart
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = opts.color
    ctx.fillStyle = opts.color
    ctx.font = '11px sans-serif'
    const labelWidth = ctx.measureText(opts.label).width
    for (const i of indexes) {
      const px = x.getPixelForValue(i)
      ctx.beginPath()
      ctx.moveTo(px, top)
      ctx.lineTo(px, bottom)
      ctx.stroke()
      // Near the right edge the label goes on the left of the line
      const textX = px + 4 + labelWidth > right ? px - 4 - labelWidth : px + 4
      ctx.fillText(opts.label, textX, top + 12)
    }
    ctx.restore()
  }
}

const fetchStatistics = async () => {
  const serial = props.camera?.deviceSerial || 'all'

  loading.value = true
  try {
    loadCardMarkers(serial)
    const res = await api.getStatistics(serial, currentMode.value, props.startDate, props.endDate)
    if (res.data?.success) {
      statsData.value = res.data.data || []
      processStats(statsData.value)
      await nextTick()
      renderCharts(statsData.value)
      // Markers may arrive after the chart: redraw with them
      watchMarkersOnce()
    } else {
      statsData.value = []
      processStats([])
    }
  } catch (error) {
    ElNotification({ title: t('common.error'), message: t('analytics.noData'), type: 'error' })
  } finally {
    loading.value = false
  }
}

let stopMarkerWatch = null
const watchMarkersOnce = () => {
  if (stopMarkerWatch) stopMarkerWatch()
  stopMarkerWatch = watch(cardMarkerKeys, () => {
    renderCharts(statsData.value)
    stopMarkerWatch?.()
    stopMarkerWatch = null
  })
}

const processStats = (data) => {
  let speciesMap = {}

  data.forEach(item => {
    (item.insects || []).forEach(ins => {
      const norm = normalizeSpecies(ins.label)
      if (ins.value > 0) {
        speciesMap[norm] = (speciesMap[norm] || 0) + (ins.value || 0)
      }
    })
  })

  scanCount.value = data.length

  // Find top species
  let top = '--'
  let max = 0
  for (const k in speciesMap) {
    if (speciesMap[k] > max) {
      max = speciesMap[k]
      top = k
    }
  }
  if (Object.keys(speciesMap).length > 0 && max > 0) {
    const total = Object.values(speciesMap).reduce((a, b) => a + b, 0);
    const pct = Math.round((max / (total || 1)) * 100);
    topSpecies.value = `${top} (${pct}%)`
    speciesList.value = Object.keys(speciesMap)
  } else {
    topSpecies.value = '--'
    speciesList.value = []
  }

  // Forecast trend
  if (data.length >= 2) {
    const last = (data[data.length - 1].insects || []).reduce((a, b) => a + (b.value || 0), 0)
    const prev = (data[data.length - 2].insects || []).reduce((a, b) => a + (b.value || 0), 0)
    if (last > prev * 1.1) {
      forecastStatus.value = 'up'
      forecastIcon.value = 'up'
    } else if (last < prev * 0.9) {
      forecastStatus.value = 'down'
      forecastIcon.value = 'down'
    } else {
      forecastStatus.value = 'stable'
      forecastIcon.value = 'stable'
    }
  } else {
    forecastStatus.value = 'stable'
    forecastIcon.value = ''
  }
}

const renderCharts = (data) => {
  // 1. Line Chart
  if (lineChartInstance) {
    lineChartInstance.destroy()
    lineChartInstance = null
  }

  if (lineChartRef.value && data.length > 0) {
    const labels = data.map(item => item._id)
    const insectMap = new Map()
    data.forEach((item, itemIdx) => {
      (item.insects || []).forEach(ins => {
        const norm = normalizeSpecies(ins.label)
        if (!insectMap.has(norm)) {
          insectMap.set(norm, new Array(data.length).fill(0))
        }
        insectMap.get(norm)[itemIdx] += (ins.value || 0)
      })
    })

    const colors = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899']
    let colorIdx = 0
    const datasets = []
    for (const [label, values] of insectMap.entries()) {
      datasets.push({
        label: formatSpeciesName(label),
        data: values,
        borderColor: colors[colorIdx % colors.length],
        backgroundColor: colors[colorIdx % colors.length] + '20',
        borderWidth: 3,
        tension: 0.4,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 6
      })
      colorIdx++
    }

    if (datasets.length === 0) {
      datasets.push({
        label: formatSpeciesName(FRUIT_FLY),
        data: new Array(data.length).fill(0),
        borderColor: '#10b981',
        backgroundColor: '#10b98120',
        borderWidth: 3,
        tension: 0.4,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 6
      })
    }

    const markerIndexes = data.map((item, i) => (cardMarkerKeys.value.has(item.dateKey) ? i : -1)).filter(i => i >= 0)
    lineChartInstance = new Chart(lineChartRef.value, {
      type: 'line',
      data: { labels, datasets },
      plugins: [cardMarkerPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, font: { family: 'Quicksand' } } },
          cardMarkers: {
            indexes: markerIndexes,
            label: t('maintenance.chartMarker'),
            color: getComputedStyle(document.documentElement).getPropertyValue('--el-color-warning').trim() || '#e6a23c'
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { precision: 0, stepSize: 1 },
            // Theme border color, read at render time so it suits light and dark mode
            grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--el-border-color').trim() || 'rgba(128, 128, 128, 0.15)' }
          },
          x: { grid: { display: false } }
        }
      }
    })
  }

  // 2. Pie Chart
  if (pieChartInstance) {
    pieChartInstance.destroy()
    pieChartInstance = null
  }

  if (pieChartRef.value) {
    let speciesTotals = {}
    data.forEach(item => {
      (item.insects || []).forEach(ins => {
        const norm = normalizeSpecies(ins.label)
        if (ins.value > 0) {
          speciesTotals[norm] = (speciesTotals[norm] || 0) + (ins.value || 0)
        }
      })
    })

    const hasData = Object.keys(speciesTotals).length > 0;
    speciesList.value = hasData ? Object.keys(speciesTotals) : [];

    if (hasData) {
      const pieLabels = Object.keys(speciesTotals).map(l => formatSpeciesName(l))
      const pieData = Object.values(speciesTotals)
      const colors = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899']

      pieChartInstance = new Chart(pieChartRef.value, {
        type: 'doughnut',
        data: {
          labels: pieLabels,
          datasets: [
            {
              data: pieData,
              backgroundColor: colors.slice(0, pieLabels.length),
              borderWidth: 0,
              hoverOffset: 16
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { position: 'bottom', labels: { font: { family: 'Quicksand' } } }
          }
        }
      })
    }
  }
}

watch(
  [() => props.camera, () => props.startDate, () => props.endDate],
  () => {
    loadRealtimeMetrics()
    fetchStatistics()
  }
)

watch(
  () => props.active,
  (isActive) => {
    if (isActive) {
      nextTick(() => {
        if (lineChartInstance) {
          lineChartInstance.resize()
        } else if (statsData.value.length > 0) {
          renderCharts(statsData.value)
        }
        if (pieChartInstance) {
          pieChartInstance.resize()
        }
      })
    }
  }
)

onMounted(() => {
  loadRealtimeMetrics()
  fetchStatistics()
})

onUnmounted(() => {
  if (lineChartInstance) lineChartInstance.destroy()
  if (pieChartInstance) pieChartInstance.destroy()
})
</script>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
</style>
