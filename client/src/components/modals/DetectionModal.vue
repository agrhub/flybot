<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md transition-opacity duration-300"
    @click.self="closeModal"
  >
    <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-[2.5rem] w-full max-w-5xl overflow-hidden shadow-2xl relative transition-transform duration-300 max-h-[92vh] flex flex-col">
      <!-- Close button -->
      <button
        @click="closeModal"
        class="absolute top-5 right-5 z-20 w-10 h-10 bg-[var(--el-card-bg-color)]/80 hover:bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-full flex items-center justify-center shadow-lg backdrop-blur-md transition-all text-[var(--el-text-color-regular)] hover:text-[var(--el-text-color-primary)] cursor-pointer"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>

      <div class="flex flex-col lg:flex-row h-full overflow-hidden">
        <!-- Canvas view -->
        <div class="lg:w-2/3 bg-black flex items-center justify-center relative overflow-hidden p-2 min-h-[360px]">
          <div v-if="imageLoading" class="absolute inset-0 flex items-center justify-center z-10 bg-black/80">
            <div class="w-10 h-10 border-4 border-[var(--primary-green)] border-t-transparent rounded-full animate-spin"></div>
          </div>
          <canvas ref="canvasRef" id="detectionCanvas" class="max-w-full max-h-[80vh] object-contain"></canvas>
        </div>

        <!-- Details Sidebar -->
        <div class="lg:w-1/3 p-6 lg:p-8 overflow-y-auto custom-scrollbar flex flex-col bg-[var(--el-card-bg-color)]">
          <div class="mb-4">
            <p class="text-[10px] font-bold text-[var(--primary-green)] uppercase tracking-widest mb-1">{{ t('analytics.detectionTime') || 'Record Time' }}</p>
            <h4 class="text-base font-bold text-[var(--el-text-color-primary)] tracking-tight">{{ formattedTime }}</h4>
          </div>

          <div class="mb-5">
            <p class="text-[10px] font-bold text-[var(--primary-green)] uppercase tracking-widest mb-2">{{ t('analytics.targetStats') || 'Object Statistics' }}</p>
            <div class="h-44 w-full flex items-center justify-center mb-3 relative">
              <canvas ref="pieChartRef"></canvas>
              <div v-if="!hasInsects" class="absolute text-xs italic text-[var(--el-text-color-secondary)]">{{ t('analytics.noInsects') || 'No insects detected' }}</div>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="(count, name) in summaryData"
                :key="name"
                class="bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full text-xs font-bold border border-emerald-500/20"
              >
                {{ name }}: {{ count }}
              </span>
            </div>
          </div>

          <div class="flex-1">
            <p class="text-[10px] font-bold text-[var(--primary-green)] uppercase tracking-widest mb-1.5">{{ t('analytics.detailedDescription') || 'Detailed Description' }}</p>
            <div class="bg-[var(--el-bg-color)] p-4 rounded-2xl italic text-xs leading-relaxed text-[var(--el-text-color-secondary)] border border-[var(--el-border-color)]">
              {{ item?.aiResults?.raw_description || t('analytics.noDetailedDesc') || 'No detailed description.' }}
            </div>
          </div>

          <div class="mt-6 pt-4 border-t border-[var(--el-border-color)]/60">
            <button
              @click="closeModal"
              class="w-full py-3 bg-[var(--el-bg-color)] hover:bg-[var(--el-card-bg-color)] text-[var(--el-text-color-primary)] border border-[var(--el-border-color)] font-bold rounded-2xl transition text-sm cursor-pointer"
            >
              {{ t('analytics.closeWindow') || 'Close Window' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, nextTick, onUnmounted } from 'vue'
import Chart from 'chart.js/auto'
import api from '@/services/api'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  visible: Boolean,
  item: Object
})

const emit = defineEmits(['close'])
const { t, currentLang } = useI18n()

const canvasRef = ref(null)
const pieChartRef = ref(null)
const imageLoading = ref(false)
let chartInstance = null

const formattedTime = computed(() => {
  if (!props.item?.createdAt) return '--'
  return new Date(props.item.createdAt).toLocaleString(currentLang.value === 'vi' ? 'vi-VN' : 'en-US')
})

const summaryData = computed(() => {
  return props.item?.aiResults?.summary || {}
})

const hasInsects = computed(() => {
  return Object.keys(summaryData.value).length > 0
})

const closeModal = () => {
  emit('close')
}

const drawDetection = () => {
  if (!props.item) return
  imageLoading.value = true

  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')

  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = api.getImageUrl(props.item.imageUrl || props.item.s3Key)

  img.onload = () => {
    canvas.width = img.width
    canvas.height = img.height
    ctx.drawImage(img, 0, 0)

    const detections = props.item.aiResults?.insects || []
    detections.forEach(det => {
      const box = det.bbox
      if (!box || box.length < 4) return

      const x = box[0]
      const y = box[1]
      const w = box[2] - box[0]
      const h = box[3] - box[1]

      // Draw bounding box
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = Math.max(2, img.width / 400)
      ctx.strokeRect(x, y, w, h)

      // Draw label background
      ctx.fillStyle = '#2563eb'
      const fontSize = Math.max(12, Math.round(img.width / 60))
      ctx.font = `bold ${fontSize}px Quicksand, sans-serif`
      const conf = det.confidence ? Math.round(det.confidence * 100) : 100
      const label = `${det.name} (${conf}%)`
      const textWidth = ctx.measureText(label).width

      ctx.fillRect(x, Math.max(0, y - fontSize - 6), textWidth + 10, fontSize + 6)

      // Draw label text
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, x + 5, Math.max(fontSize, y - 4))
    })

    imageLoading.value = false
  }

  img.onerror = () => {
    imageLoading.value = false
  }
}

const renderChart = () => {
  if (chartInstance) {
    chartInstance.destroy()
    chartInstance = null
  }

  const canvas = pieChartRef.value
  if (!canvas) return

  const entries = Object.entries(summaryData.value)
  if (entries.length === 0) return

  const labels = entries.map(([name]) => name)
  const counts = entries.map(([, count]) => count)
  const colors = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777']

  chartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: counts,
          backgroundColor: colors.slice(0, labels.length),
          borderWidth: 0,
          hoverOffset: 8
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const label = context.label || ''
              const value = context.raw || 0
              const total = context.dataset.data.reduce((a, b) => a + b, 0)
              const pct = Math.round((value / total) * 100)
              return `${label}: ${value} (${pct}%)`
            }
          }
        }
      }
    }
  })
}

watch(
  () => props.visible,
  async (isVis) => {
    if (isVis && props.item) {
      await nextTick()
      drawDetection()
      renderChart()
    } else {
      if (chartInstance) {
        chartInstance.destroy()
        chartInstance = null
      }
    }
  }
)

onUnmounted(() => {
  if (chartInstance) chartInstance.destroy()
})
</script>
