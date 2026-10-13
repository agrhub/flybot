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
            <!-- Fixed size: a self-resizing chart in a table cell inside an opening dialog measures wrong -->
            <div class="h-44 w-full flex items-center justify-center mb-3 relative">
              <canvas ref="pieChartRef" width="240" height="176"></canvas>
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
                {{ speciesName(name, t) }}: {{ count }}
              </el-tag>
            </div>
          </el-descriptions-item>

          <!-- Human review of the AI result -->
          <el-descriptions-item :label="t('analytics.review.title')">
            <div v-if="!editing" class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <el-tag :type="REVIEW_TAG[reviewStatus]" effect="light" round size="small">
                  {{ t(`analytics.review.status.${reviewStatus}`) }}
                </el-tag>
                <span v-if="item?.review?.reviewedAt" class="meta-text">{{ formatDate(item.review.reviewedAt) }}</span>
              </div>
              <p v-if="reviewStatus === 'corrected'" class="meta-text">
                {{ t('analytics.review.aiOriginal') }}: {{ formatSummary(item.review.originalSummary, t) || '--' }}
              </p>
              <p v-if="item?.review?.note" class="desc-text">{{ item.review.note }}</p>
              <div v-if="item?.aiProcessed !== false && canReview" class="flex flex-wrap gap-2 pt-1">
                <el-button
                  v-if="reviewStatus === 'pending'"
                  size="small"
                  type="success"
                  plain
                  :icon="Check"
                  :loading="savingReview"
                  @click="confirmResult"
                >
                  {{ t('analytics.review.confirm') }}
                </el-button>
                <el-button size="small" :icon="EditPen" @click="startEditing">
                  {{ t('analytics.review.correct') }}
                </el-button>
              </div>
            </div>

            <el-form v-else label-position="top" size="small" @submit.prevent>
              <div v-for="(row, index) in correctionRows" :key="index" class="flex items-center gap-2 mb-2">
                <el-select
                  v-model="row.label"
                  filterable
                  allow-create
                  default-first-option
                  class="flex-1 min-w-0"
                  :placeholder="t('analytics.review.species')"
                >
                  <el-option v-for="key in KNOWN_SPECIES" :key="key" :value="key" :label="speciesName(key, t)" />
                </el-select>
                <el-input-number v-model="row.count" :min="0" :max="10000" :step="1" step-strictly controls-position="right" class="!w-28" />
                <el-button text circle :icon="Delete" @click="correctionRows.splice(index, 1)" />
              </div>
              <el-button size="small" link type="primary" :icon="Plus" @click="correctionRows.push({ label: '', count: 0 })">
                {{ t('analytics.review.addSpecies') }}
              </el-button>
              <el-input
                v-model="correctionNote"
                type="textarea"
                :rows="2"
                maxlength="500"
                :placeholder="t('analytics.review.notePlaceholder')"
                class="mt-2"
              />
              <div class="flex justify-end gap-2 mt-3">
                <el-button size="small" @click="editing = false">{{ t('common.cancel') }}</el-button>
                <el-button size="small" type="primary" :loading="savingReview" @click="saveCorrection">
                  {{ t('common.save') }}
                </el-button>
              </div>
            </el-form>
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
      <el-button :icon="ChatDotRound" @click="askAboutPhoto">{{ t('assistant.askAboutPhoto') }}</el-button>
      <el-button @click="closeModal">{{ t('analytics.closeWindow') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, computed, nextTick, onUnmounted } from 'vue'
import Chart from 'chart.js/auto'
import api from '@/services/api'
import { drawDetections } from '@/utils/detectionImage'
import { useI18n } from 'vue-i18n'
import { ElNotification } from 'element-plus'
import { Check, EditPen, Delete, Plus, ChatDotRound } from '@element-plus/icons-vue'
import { useTheme } from '@/utils/theme'
import { FRUIT_FLY, speciesName, normalizeSummary, formatSummary } from '@/utils/species'
import { useCameras } from '@/composables/useCameras'

const props = defineProps({
  visible: Boolean,
  item: Object
})

const emit = defineEmits(['close', 'updated'])
const { t, locale } = useI18n()
const { askAssistant } = useTheme()

// The assistant looks at this photo (inspect_photo) and answers in the chat panel
const askAboutPhoto = () => {
  if (!props.item?._id) return
  askAssistant({ text: t('assistant.photoQuestion'), snapshotId: String(props.item._id) })
  closeModal()
}

// ---------- Human review ----------
const REVIEW_TAG = { pending: 'info', confirmed: 'success', corrected: 'warning' }
const KNOWN_SPECIES = [FRUIT_FLY, 'bug', 'caterpillar']

const editing = ref(false)
const savingReview = ref(false)
const correctionRows = ref([])
const correctionNote = ref('')

const reviewStatus = computed(() => props.item?.review?.status || 'pending')
// Only people who manage the camera can review its results
const { cameras } = useCameras()
const canReview = computed(() => {
  const cam = cameras.value.find(c => c.deviceSerial === props.item?.deviceSerial)
  return !cam || cam.canManage !== false
})

const formatDate = (value) => new Date(value).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US')

const startEditing = () => {
  const current = normalizeSummary(props.item?.aiResults?.summary || {})
  correctionRows.value = Object.entries(current).map(([label, count]) => ({ label, count }))
  if (correctionRows.value.length === 0) correctionRows.value.push({ label: FRUIT_FLY, count: 0 })
  correctionNote.value = props.item?.review?.note || ''
  editing.value = true
}

const submitReview = async (body) => {
  savingReview.value = true
  try {
    const res = await api.reviewSnapshot(props.item._id, body)
    if (res.data?.snapshot) emit('updated', res.data.snapshot)
    editing.value = false
    ElNotification({ title: t('common.success'), message: t('analytics.review.saved'), type: 'success' })
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.response?.data?.message || t('settings.saveFailed'), type: 'error' })
  } finally {
    savingReview.value = false
  }
}

const confirmResult = () => submitReview({ status: 'confirmed' })

const saveCorrection = () => {
  const summary = {}
  for (const row of correctionRows.value) {
    const label = String(row.label || '').trim()
    if (!label) continue
    summary[label] = (summary[label] || 0) + (Number(row.count) || 0)
  }
  submitReview({ status: 'corrected', summary, note: correctionNote.value.trim() || undefined })
}

// Leave edit mode when another snapshot is opened
watch(() => props.item?._id, () => { editing.value = false })

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

    drawDetections(ctx, props.item.aiResults?.insects, { t, imageWidth: img.width })

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

  const labels = entries.map(([name]) => speciesName(name, t))
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
      responsive: false,
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

// Redraw the doughnut after a review changes the counts
watch(summaryData, async () => {
  if (props.visible) {
    await nextTick()
    renderChart()
  }
})

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
