<template>
  <el-dialog
    :model-value="visible"
    :title="t('analytics.inspectSnapshot')"
    width="min(1040px, 94vw)"
    top="4vh"
    append-to-body
    class="detection-dialog"
    :before-close="handleBeforeClose"
  >
    <div class="flex flex-col lg:flex-row gap-5">
      <!-- Canvas view (snapshot + bounding boxes) -->
      <div
        v-loading="imageLoading"
        class="canvas-wrap lg:w-2/3 flex items-center justify-center relative overflow-hidden p-2"
      >
        <canvas ref="canvasRef" id="detectionCanvas" class="max-w-full max-h-[70vh] object-contain"></canvas>
      </div>

      <!-- Details sidebar -->
      <div class="lg:w-1/3 min-w-0">
        <el-descriptions :column="1" direction="vertical" border>
          <el-descriptions-item :label="t('analytics.detectionTime')">
            <span class="time-text">{{ formattedTime }}</span>
          </el-descriptions-item>

          <el-descriptions-item :label="t('analytics.targetStats')">
            <div class="h-44 w-full flex items-center justify-center mb-3 relative">
              <canvas ref="pieChartRef"></canvas>
              <span v-if="!hasInsects" class="meta-text absolute">{{ t('analytics.noInsects') }}</span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <el-tag
                v-for="(count, name) in summaryData"
                :key="name"
                type="success"
                effect="light"
                size="small"
                round
              >
                {{ name }}: {{ count }}
              </el-tag>
            </div>
          </el-descriptions-item>

          <el-descriptions-item :label="t('analytics.detailedDescription')">
            <p class="desc-text">
              {{ item?.aiResults?.raw_description || t('analytics.noDetailedDesc') }}
            </p>
          </el-descriptions-item>
        </el-descriptions>
      </div>
    </div>

    <template #footer>
      <el-button @click="closeModal">{{ t('analytics.closeWindow') }}</el-button>
    </template>
  </el-dialog>
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
const { t, locale } = useI18n()

const canvasRef = ref(null)
const pieChartRef = ref(null)
const imageLoading = ref(false)
let chartInstance = null

const formattedTime = computed(() => {
  if (!props.item?.createdAt) return '--'
  return new Date(props.item.createdAt).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US')
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

// User-initiated close (X button, overlay click, Esc): the parent owns visibility via the 'close' event
const handleBeforeClose = () => {
  closeModal()
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

<style scoped>
.canvas-wrap {
  min-height: 360px;
  border-radius: 8px;
  background-color: var(--el-fill-color-darker);
}
.time-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.meta-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.desc-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  white-space: pre-line;
}
</style>
