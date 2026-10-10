<template>
  <div class="space-y-8 w-full max-w-6xl pb-10">
    <!-- Summary Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
      <div class="bg-[var(--el-card-bg-color)] p-6 rounded-[24px] border border-[var(--el-border-color)] shadow-soft transition-transform hover:-translate-y-0.5">
        <p class="text-[11px] font-bold text-[var(--el-text-color-secondary)] uppercase tracking-widest mb-1">
          {{ isSingleCamera ? t('analytics.realtimeDensityTrap') : t('analytics.realtimeHotspotMax') }}
        </p>
        <h4 class="text-3xl font-black text-amber-400">
          {{ realtimeInsectCount }} <span class="text-xs font-normal text-slate-400">{{ t('analytics.insectsUnit') }}</span>
        </h4>
        <p class="text-xs text-[var(--el-text-color-secondary)] mt-2">
          {{ isSingleCamera ? (props.camera?.deviceName || props.camera?.deviceSerial) : t('analytics.peakAcrossTraps') }}
        </p>
      </div>

      <div class="bg-[var(--el-card-bg-color)] p-6 rounded-[24px] border border-[var(--el-border-color)] shadow-soft transition-transform hover:-translate-y-0.5">
        <p class="text-[11px] font-bold text-[var(--el-text-color-secondary)] uppercase tracking-widest mb-1">{{ t('analytics.topSpeciesCard') }}</p>
        <h4 class="text-xl font-bold text-[var(--el-text-color-primary)] truncate">{{ formatSpeciesDisplay(topSpecies) }}</h4>
        <p class="text-xs text-[var(--el-text-color-secondary)] mt-2">{{ t('analytics.topSpeciesDesc') }}</p>
      </div>

      <div class="bg-[var(--el-card-bg-color)] p-6 rounded-[24px] border border-[var(--el-border-color)] shadow-soft transition-transform hover:-translate-y-0.5">
        <p class="text-[11px] font-bold text-[var(--el-text-color-secondary)] uppercase tracking-widest mb-1">{{ t('analytics.scanCountCard') }}</p>
        <h4 class="text-3xl font-bold text-[var(--el-text-color-primary)]">{{ scanCount.toLocaleString() }}</h4>
        <p class="text-xs text-[var(--el-text-color-secondary)] mt-2">{{ t('analytics.dataPointsUnit') }}</p>
      </div>

      <div class="bg-[var(--el-card-bg-color)] p-6 rounded-[24px] border border-[var(--el-border-color)] shadow-soft transition-transform hover:-translate-y-0.5">
        <p class="text-[11px] font-bold text-[var(--el-text-color-secondary)] uppercase tracking-widest mb-1">{{ t('analytics.forecastCard') }}</p>
        <div class="flex items-center gap-2">
          <h4 class="text-xl font-bold text-[var(--el-text-color-primary)]">{{ forecastText }}</h4>
          <span v-html="forecastIcon"></span>
        </div>
        <p class="text-xs text-[var(--el-text-color-secondary)] mt-2">{{ t('analytics.forecastTrend') }}</p>
      </div>
    </div>

    <!-- Charts Row -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Main Line Chart -->
      <div class="lg:col-span-2 bg-[var(--el-card-bg-color)] p-7 rounded-[28px] border border-[var(--el-border-color)] shadow-soft relative">
        <div class="flex items-center justify-between mb-6">
          <h3 class="font-bold text-[var(--el-text-color-primary)]">{{ t('analytics.densityChart') }}</h3>
          <div class="flex bg-[var(--el-bg-color)] p-1 rounded-xl border border-[var(--el-border-color)]">
            <button
              v-for="item in modes"
              :key="item.value"
              @click="setMode(item.value)"
              :class="currentMode === item.value ? 'bg-[var(--primary-green)] text-slate-950 font-bold shadow-sm' : 'text-[var(--el-text-color-secondary)] hover:text-[var(--el-text-color-primary)]'"
              class="px-3.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer"
            >
              {{ item.label }}
            </button>
          </div>
        </div>

        <div class="h-[400px] relative">
          <canvas v-show="statsData.length > 0" ref="lineChartRef"></canvas>
          <div
            v-if="loading"
            class="absolute inset-0 bg-[var(--el-card-bg-color)]/80 backdrop-blur-sm flex items-center justify-center rounded-[28px] z-10"
          >
            <div class="flex flex-col items-center">
              <div class="w-8 h-8 border-2 border-[var(--primary-green)] border-t-transparent rounded-full animate-spin"></div>
              <p class="text-xs text-[var(--el-text-color-secondary)] mt-2">{{ t('analytics.loadingData') }}</p>
            </div>
          </div>
          <div
            v-show="!loading && statsData.length === 0"
            class="h-full flex items-center justify-center text-slate-500 text-sm italic"
          >
            {{ t('analytics.noStatsData') }}
          </div>
        </div>
      </div>

      <!-- Species Ratio Pie Chart -->
      <div class="bg-[var(--el-card-bg-color)] p-7 rounded-[28px] border border-[var(--el-border-color)] shadow-soft flex flex-col">
        <h3 class="font-bold text-[var(--el-text-color-primary)] mb-6 text-center">{{ t('analytics.speciesRatio') }}</h3>
        <div class="h-[320px] flex items-center justify-center relative">
          <canvas v-show="speciesList.length > 0" ref="pieChartRef"></canvas>
          <div v-show="speciesList.length === 0" class="text-slate-500 text-sm italic">
            {{ t('analytics.noRatioData') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import Chart from 'chart.js/auto'
import api from '@/services/api'
import { ElNotification } from 'element-plus'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

const props = defineProps({
  camera: Object,
  timeRange: { type: String, default: '30d' },
  startDate: { type: String, default: null },
  endDate: { type: String, default: null },
  active: { type: Boolean, default: true }
})

const formatSpeciesName = (species) => {
  if (!species) return '--';
  const s = species.toLowerCase();
  if (s.includes('ruồi vàng') || s.includes('fruit_fly') || s.includes('fruit fly') || s.includes('bactrocera')) {
    return locale.value === 'en' ? 'Fruit fly' : 'Ruồi vàng';
  }
  if (s.includes('bọ')) {
    return locale.value === 'en' ? 'Bug' : 'Bọ';
  }
  if (s.includes('sâu')) {
    return locale.value === 'en' ? 'Caterpillar' : 'Sâu';
  }
  return species;
};

const formatSpeciesDisplay = (str) => {
  if (!str || str === '--') return '--';
  if (locale.value === 'en') {
    return str.replace(/ruồi vàng/gi, 'Fruit fly').replace(/bọ/gi, 'Bug');
  }
  return str;
};

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
const forecastIcon = ref('')
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

const fetchStatistics = async () => {
  const serial = props.camera?.deviceSerial || 'all'

  loading.value = true
  try {
    const res = await api.getStatistics(serial, currentMode.value, props.startDate, props.endDate)
    if (res.data?.success) {
      statsData.value = res.data.data || []
      processStats(statsData.value)
      await nextTick()
      renderCharts(statsData.value)
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

const processStats = (data) => {
  let speciesMap = {}

  data.forEach(item => {
    (item.insects || []).forEach(ins => {
      const norm = (ins.label === 'fruit_fly' || ins.label === 'fruit fly' || ins.label === 'fruit-fly') ? 'ruồi vàng' : ins.label
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
      forecastIcon.value = '<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>'
    } else if (last < prev * 0.9) {
      forecastStatus.value = 'down'
      forecastIcon.value = '<svg class="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6"></path></svg>'
    } else {
      forecastStatus.value = 'stable'
      forecastIcon.value = '<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14"></path></svg>'
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
        const norm = (ins.label === 'fruit_fly' || ins.label === 'fruit fly' || ins.label === 'fruit-fly') ? 'ruồi vàng' : ins.label
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
        label: formatSpeciesName('ruồi vàng'),
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

    lineChartInstance = new Chart(lineChartRef.value, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, font: { family: 'Quicksand' } } }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { precision: 0, stepSize: 1 },
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
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
        const norm = (ins.label === 'fruit_fly' || ins.label === 'fruit fly' || ins.label === 'fruit-fly') ? 'ruồi vàng' : ins.label
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
