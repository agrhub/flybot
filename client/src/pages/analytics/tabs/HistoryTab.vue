<template>
  <div class="space-y-6 w-full max-w-6xl pb-10">
    <div class="bg-[var(--el-card-bg-color)] rounded-[24px] border border-[var(--el-border-color)] shadow-soft overflow-hidden flex flex-col">
      <!-- Header -->
      <div class="p-6 border-b border-[var(--el-border-color)]/60 flex items-center justify-between">
        <div>
          <h3 class="font-bold text-[var(--el-text-color-primary)] text-lg">{{ t('analytics.tabHistory') }}</h3>
          <p class="text-xs text-[var(--el-text-color-secondary)]">{{ t('analytics.subtitle') }}</p>
        </div>

        <button
          @click="exportToPDF"
          :disabled="exporting || records.length === 0"
          class="flex items-center gap-2 px-5 py-2.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-xl text-xs font-bold transition-all border border-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm cursor-pointer"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
          </svg>
          <span>{{ exporting ? (t('common.exporting') || 'Exporting PDF...') : t('analytics.exportPdf') }}</span>
        </button>
      </div>

      <!-- Table Wrapper -->
      <div class="table-container custom-scrollbar min-h-[300px]">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="text-[10px] font-bold text-[var(--el-text-color-secondary)] uppercase tracking-widest bg-[var(--el-bg-color)] border-b border-[var(--el-border-color)]">
              <th class="px-6 py-4">{{ t('analytics.time') }}</th>
              <th class="px-6 py-4">{{ t('analytics.image') }}</th>
              <th class="px-6 py-4">{{ t('analytics.totalCount') }}</th>
              <th class="px-6 py-4">{{ t('analytics.speciesBreakdown') }}</th>
              <th class="px-6 py-4">{{ t('analytics.aiRemarks') }}</th>
            </tr>
          </thead>
          <tbody class="text-sm text-[var(--el-text-color-regular)] divide-y divide-[var(--el-border-color)]">
            <tr v-if="loading">
              <td colspan="5" class="py-16 text-center">
                <div class="flex flex-col items-center gap-3">
                  <div class="w-8 h-8 border-4 border-emerald-500/20 border-t-[var(--primary-green)] rounded-full animate-spin"></div>
                  <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('common.loading') }}</span>
                </div>
              </td>
            </tr>

            <tr v-else-if="records.length === 0">
              <td colspan="5" class="py-20 text-center text-slate-500 italic">
                {{ t('analytics.noData') }}
              </td>
            </tr>

            <tr
              v-else
              v-for="item in records"
              :key="item._id"
              @click="openModal(item)"
              class="hover:bg-[var(--el-bg-color)] transition-colors cursor-pointer group"
            >
              <td class="px-6 py-4 text-xs font-semibold text-[var(--el-text-color-secondary)] whitespace-nowrap">
                {{ formatDate(item.createdAt) }}
              </td>
              <td class="px-6 py-4">
                <div class="w-16 h-10 rounded-lg overflow-hidden bg-black/50 shadow-sm relative border border-[var(--el-border-color)]">
                  <img
                    :src="api.getImageUrl(item.imageUrl || item.s3Key)"
                    alt="Snapshot"
                    class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                    loading="lazy"
                  />
                </div>
              </td>
              <td class="px-6 py-4 font-bold text-[var(--el-text-color-primary)]">
                <span class="px-2.5 py-1 bg-[var(--el-bg-color)] rounded-full text-xs font-black border border-[var(--el-border-color)]">
                  {{ getTotalCount(item) }}
                </span>
              </td>
              <td class="px-6 py-4">
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="(count, name) in (item.aiResults?.summary || {})"
                    :key="name"
                    class="inline-flex bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-bold border border-emerald-500/20"
                  >
                    {{ formatSpeciesName(name) }}: {{ count }}
                  </span>
                  <span v-if="!hasSummary(item)" class="text-xs text-slate-500 italic">--</span>
                </div>
              </td>
              <td class="px-6 py-4 text-xs text-[var(--el-text-color-secondary)] max-w-xs truncate">
                {{ item.aiResults?.raw_description || '--' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination Footer -->
      <div class="p-6 border-t border-[var(--el-border-color)] bg-[var(--el-bg-color)]/50 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p class="text-xs text-[var(--el-text-color-secondary)]">
          {{ t('common.showing') }} <span class="font-bold text-[var(--el-text-color-primary)]">{{ records.length }}</span> {{ t('common.of') }}
          <span class="font-bold text-[var(--el-text-color-primary)]">{{ totalRecords }}</span> {{ t('dashboard.recordsUnit') || 'records' }}
        </p>

        <div v-if="totalPages > 1" class="flex items-center gap-1">
          <!-- Prev -->
          <button
            @click="goToPage(currentPage - 1)"
            :disabled="currentPage === 1"
            class="page-link w-8 h-8 rounded-lg border border-[var(--el-border-color)] text-xs font-bold text-[var(--el-text-color-secondary)] hover:bg-[var(--el-bg-color)] flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            &lt;&lt;
          </button>

          <!-- Page numbers with ellipsis -->
          <template v-for="p in visiblePages" :key="p">
            <span v-if="p === '...'" class="px-2 text-slate-500 text-xs">...</span>
            <button
              v-else
              @click="goToPage(p)"
              :class="currentPage === p ? 'active bg-[var(--primary-green)] text-slate-950 font-bold border-[var(--primary-green)]' : 'bg-[var(--el-card-bg-color)] border-[var(--el-border-color)] text-[var(--el-text-color-secondary)] hover:bg-[var(--el-bg-color)]'"
              class="page-link w-8 h-8 rounded-lg border text-xs font-bold flex items-center justify-center transition cursor-pointer"
            >
              {{ p }}
            </button>
          </template>

          <!-- Next -->
          <button
            @click="goToPage(currentPage + 1)"
            :disabled="currentPage === totalPages"
            class="page-link w-8 h-8 rounded-lg border border-[var(--el-border-color)] text-xs font-bold text-[var(--el-text-color-secondary)] hover:bg-[var(--el-bg-color)] flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            &gt;&gt;
          </button>
        </div>
      </div>
    </div>

    <!-- Image Preview Modal -->
    <DetectionModal
      :visible="modalVisible"
      :item="selectedItem"
      @close="closeModal"
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

const { t, locale } = useI18n()

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
  return new Date(isoStr).toLocaleString('vi-VN')
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
    ElNotification({ title: t('common.error'), message: 'Failed to load detection history.', type: 'error' })
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

    // Use Quicksand font with Vietnamese Unicode support
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
    const deviceName = props.camera?.deviceName || 'Tất cả camera giám sát'
    const deviceSerial = props.camera?.deviceSerial || 'all'
    doc.text(`Thiết bị: ${deviceName}`, 14, 28)
    doc.text(`Mã thiết bị (Serial): ${deviceSerial === 'all' ? 'Toàn bộ hệ thống' : deviceSerial}`, 14, 33)
    doc.text(`Thời gian xuất báo cáo: ${new Date().toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US')}`, 14, 38)

    // Table Data & Base64 images
    const tableData = []
    const imagesBase64 = []

    const listToExport = records.value.length > 0 ? records.value : (await api.getAiResults(deviceSerial, 1, 50, props.startDate, props.endDate)).data?.results || []

    for (const item of listToExport.slice(0, 30)) {
      const timeStr = formatDate(item.createdAt)
      const total = getTotalCount(item)
      const summary = item.aiResults?.summary || {}
      const normalizedSummary = {}
      for (const [n, c] of Object.entries(summary)) {
        const normKey = (n === 'fruit_fly' || n === 'fruit fly' || n === 'fruit-fly') ? 'ruồi vàng' : n
        normalizedSummary[normKey] = (normalizedSummary[normKey] || 0) + (Number(c) || 0)
      }
      const speciesStr = Object.entries(normalizedSummary).map(([n, c]) => `${n}: ${c}`).join(', ') || 'Chưa phân loại'
      const desc = item.aiResults?.raw_description || '--'
      const imgUrl = api.getImageUrl(item.imageUrl || item.s3Key)

      tableData.push([timeStr, '', total, speciesStr, desc])
      imagesBase64.push(await getBase64Image(imgUrl))
    }

    autoTable(doc, {
      startY: 44,
      head: [['Thời Gian', 'Ảnh Snapshot', 'Số Lượng', 'Phân Bố Loài', 'Đánh Giá AI']],
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
    ElNotification({ title: t('common.success'), message: 'Đã xuất file PDF thành công!', type: 'success' })
  } catch (error) {
    console.error('PDF Export Error:', error)
    ElNotification({ title: t('common.error'), message: 'Lỗi khi xuất PDF: ' + error.message, type: 'error' })
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
