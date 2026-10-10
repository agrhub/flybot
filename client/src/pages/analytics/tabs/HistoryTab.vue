<template>
  <div class="w-full pb-10">
    <el-card shadow="never">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="section-title">{{ t('analytics.tabHistory') }}</div>
            <div class="section-subtitle">{{ t('analytics.subtitle') }}</div>
          </div>

          <el-button
            :icon="Document"
            :loading="exporting"
            :disabled="records.length === 0"
            @click="exportToPDF"
          >
            {{ exporting ? t('common.exporting') : t('analytics.exportPdf') }}
          </el-button>
        </div>
      </template>

      <el-table
        v-loading="loading"
        :element-loading-text="t('common.loading')"
        :data="records"
        row-key="_id"
        class="history-table w-full"
        @row-click="openModal"
      >
        <template #empty>
          <el-empty :description="t('analytics.noData')" :image-size="80" />
        </template>

        <el-table-column :label="t('analytics.time')" min-width="170">
          <template #default="{ row }">
            <span class="meta-text whitespace-nowrap">{{ formatDate(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('analytics.image')" width="110">
          <template #default="{ row }">
            <el-image
              :src="api.getImageUrl(row.imageUrl || row.s3Key)"
              fit="cover"
              loading="lazy"
              class="thumb"
            />
          </template>
        </el-table-column>

        <el-table-column :label="t('analytics.totalCount')" width="110" align="center">
          <template #default="{ row }">
            <span class="count-text">{{ getTotalCount(row) }}</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('analytics.speciesBreakdown')" min-width="200">
          <template #default="{ row }">
            <div class="flex flex-wrap gap-1">
              <el-tag
                v-for="(count, name) in (row.aiResults?.summary || {})"
                :key="name"
                type="success"
                effect="light"
                size="small"
                round
              >
                {{ formatSpeciesName(name) }}: {{ count }}
              </el-tag>
              <span v-if="!hasSummary(row)" class="meta-text">--</span>
              <el-tag
                v-if="row.review?.status"
                :type="row.review.status === 'corrected' ? 'warning' : 'info'"
                effect="plain"
                size="small"
                round
              >
                {{ t(`analytics.review.status.${row.review.status}`) }}
              </el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column :label="t('analytics.aiRemarks')" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="meta-text">{{ row.aiResults?.raw_description || '--' }}</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('common.actions')" width="90" align="center" fixed="right">
          <template #default="{ row }">
            <el-tooltip :content="t('analytics.inspectSnapshot')" placement="top">
              <el-button :icon="View" circle size="small" @click.stop="openModal(row)" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>

      <!-- Pagination footer -->
      <div class="flex flex-col sm:flex-row items-center justify-between gap-4 mt-4">
        <p class="meta-text">
          {{ t('common.showing') }} <strong>{{ records.length }}</strong> {{ t('common.of') }}
          <strong>{{ totalRecords }}</strong> {{ t('dashboard.recordsUnit') }}
        </p>

        <el-pagination
          v-if="totalPages > 1"
          background
          layout="prev, pager, next"
          :current-page="currentPage"
          :page-size="limit"
          :total="totalRecords"
          @current-change="goToPage"
        />
      </div>
    </el-card>

    <!-- Image preview modal -->
    <DetectionModal
      :visible="modalVisible"
      :item="selectedItem"
      @close="closeModal"
      @updated="onSnapshotUpdated"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/services/api'
import DetectionModal from '@/components/modals/DetectionModal.vue'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { addQuicksandFonts } from '@/utils/pdfFonts'
import { ElNotification } from 'element-plus'
import { Document, View } from '@element-plus/icons-vue'
import { speciesName, formatSummary } from '@/utils/species'

const { t, locale } = useI18n()

const formatSpeciesName = (species) => speciesName(species, t);
const dateLocale = () => (locale.value === 'vi' ? 'vi-VN' : 'en-US');

const props = defineProps({
  camera: Object,
  startDate: { type: String, default: null },
  endDate: { type: String, default: null }
})

const records = ref([])
const loading = ref(false)
const totalRecords = ref(0)
const currentPage = ref(1)
const limit = 10
const exporting = ref(false)

const modalVisible = ref(false)
const selectedItem = ref(null)

const totalPages = computed(() => Math.ceil(totalRecords.value / limit) || 1)

const visiblePages = computed(() => {
  const total = totalPages.value
  const curr = currentPage.value
  const pages = []

  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= curr - 2 && i <= curr + 2)) {
      pages.push(i)
    } else if (i === curr - 3 || i === curr + 3) {
      pages.push('...')
    }
  }
  return pages
})

const formatDate = (isoStr) => {
  if (!isoStr) return '--'
  return new Date(isoStr).toLocaleString(dateLocale())
}

const getTotalCount = (item) => {
  const summary = item.aiResults?.summary || {}
  return Object.values(summary).reduce((a, b) => a + (b || 0), 0)
}

const hasSummary = (item) => {
  const summary = item.aiResults?.summary || {}
  return Object.keys(summary).length > 0
}

const fetchHistory = async () => {
  const serial = props.camera?.deviceSerial || 'all'

  loading.value = true
  try {
    const res = await api.getAiResults(serial, currentPage.value, limit, props.startDate, props.endDate)
    if (res.data?.success) {
      records.value = res.data.results || []
      totalRecords.value = res.data.total || 0
    } else {
      records.value = []
      totalRecords.value = 0
    }
  } catch (error) {
    ElNotification({ title: t('common.error'), message: t('analytics.historyLoadFailed'), type: 'error' })
  } finally {
    loading.value = false
  }
}

const goToPage = (page) => {
  if (page < 1 || page > totalPages.value || page === currentPage.value) return
  currentPage.value = page
  fetchHistory()
}

const openModal = (item) => {
  selectedItem.value = item
  modalVisible.value = true
}

// Keep the table and the open modal in sync after a review
const onSnapshotUpdated = (snapshot) => {
  records.value = records.value.map(r => (r._id === snapshot._id ? { ...r, ...snapshot } : r))
  if (selectedItem.value?._id === snapshot._id) selectedItem.value = { ...selectedItem.value, ...snapshot }
}

const closeModal = () => {
  modalVisible.value = false
  selectedItem.value = null
}

const getBase64Image = async (url) => {
  if (!url) return null
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeoutId)
    if (!res.ok) return null
    const blob = await res.blob()
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result)
      reader.readAsDataURL(blob)
    })
  } catch (e) {
    return null
  }
}

const exportToPDF = async () => {
  exporting.value = true

  try {
    const doc = new jsPDF({
      orientation: 'p',
      unit: 'mm',
      format: 'a4',
      putOnlyUsedFonts: true
    })

    // Quicksand covers the Vietnamese characters used in localized reports
    addQuicksandFonts(doc)
    try {
      doc.setFont('Quicksand', 'normal')
    } catch (e) {
      console.warn('Font Quicksand fallback to standard', e)
    }

    // Header Title
    doc.setFontSize(18)
    doc.setTextColor(16, 185, 129) // Emerald
    doc.text('FLYBOT INSECT SURVEILLANCE REPORT', 14, 20)

    doc.setFontSize(9)
    doc.setTextColor(100)
    const deviceName = props.camera?.deviceName || t('analytics.report.allCameras')
    const deviceSerial = props.camera?.deviceSerial || 'all'
    doc.text(t('analytics.report.device', { name: deviceName }), 14, 28)
    doc.text(t('analytics.report.serial', { serial: deviceSerial === 'all' ? t('analytics.report.wholeSystem') : deviceSerial }), 14, 33)
    doc.text(t('analytics.report.exportedAt', { time: new Date().toLocaleString(dateLocale()) }), 14, 38)

    // Table Data & Base64 images
    const tableData = []
    const imagesBase64 = []

    const listToExport = records.value.length > 0 ? records.value : (await api.getAiResults(deviceSerial, 1, 50, props.startDate, props.endDate)).data?.results || []

    for (const item of listToExport.slice(0, 30)) {
      const timeStr = formatDate(item.createdAt)
      const total = getTotalCount(item)
      const speciesStr = formatSummary(item.aiResults?.summary, t) || t('analytics.report.notIdentified')
      const desc = item.aiResults?.raw_description || '--'
      const imgUrl = api.getImageUrl(item.imageUrl || item.s3Key)

      tableData.push([timeStr, '', total, speciesStr, desc])
      imagesBase64.push(await getBase64Image(imgUrl))
    }

    autoTable(doc, {
      startY: 44,
      head: [[
        t('analytics.report.colTime'),
        t('analytics.report.colSnapshot'),
        t('analytics.report.colCount'),
        t('analytics.report.colSpecies'),
        t('analytics.report.colAiAssessment')
      ]],
      body: tableData,
      theme: 'grid',
      styles: {
        font: 'Quicksand',
        fontSize: 8,
        valign: 'middle'
      },
      headStyles: {
        fillColor: [16, 185, 129],
        textColor: [255, 255, 255],
        fontStyle: 'bold'
      },
      columnStyles: {
        0: { cellWidth: 35 },
        1: { cellWidth: 32, minCellHeight: 22 },
        2: { cellWidth: 16, halign: 'center' },
        3: { cellWidth: 42 },
        4: { cellWidth: 'auto' }
      },
      didDrawCell: (data) => {
        if (data.section === 'body' && data.column.index === 1) {
          const base64 = imagesBase64[data.row.index]
          if (base64 && typeof base64 === 'string' && base64.startsWith('data:image')) {
            try {
              doc.addImage(base64, 'JPEG', data.cell.x + 2, data.cell.y + 2, 28, 18)
            } catch (err) {
              // Gracefully continue without failing
            }
          }
        }
      }
    })

    const fileName = `FlyBot_Surveillance_Report_${Date.now()}.pdf`
    doc.save(fileName)
    ElNotification({ title: t('common.success'), message: t('analytics.pdfSuccess'), type: 'success' })
  } catch (error) {
    console.error('PDF Export Error:', error)
    ElNotification({ title: t('common.error'), message: t('analytics.report.pdfFailed', { error: error.message }), type: 'error' })
  } finally {
    exporting.value = false
  }
}

watch(
  [() => props.camera, () => props.startDate, () => props.endDate],
  () => {
    currentPage.value = 1
    fetchHistory()
  }
)

onMounted(() => {
  fetchHistory()
})

defineExpose({
  exportToPDF,
  fetchHistory
})
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
.count-text {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.thumb {
  width: 64px;
  height: 40px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
  background-color: var(--el-fill-color-light);
  display: block;
}
.history-table :deep(.el-table__row) {
  cursor: pointer;
}
</style>
