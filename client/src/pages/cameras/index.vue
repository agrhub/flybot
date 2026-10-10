<template>
  <div class="space-y-6 w-full max-w-7xl mx-auto pb-12 select-none">
    <!-- SUB-PAGE 1: ALL CAMERAS GRID (DEFAULT VIEW) -->
    <template v-if="subPage === 'grid'">
      <!-- Grid Page Header -->
      <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-5 shadow-soft flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">
            {{ t('cameras.title') }}
          </h3>
          <p class="text-xs text-[var(--el-text-color-secondary)] mt-0.5">
            {{ t('cameras.subtitle') }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <!-- Grid Columns Switcher -->
          <div class="flex bg-[var(--el-bg-color)] p-1 rounded-xl border border-[var(--el-border-color)]">
            <button
              v-for="layout in gridLayouts"
              :key="layout.cols"
              @click="setGridLayout(layout.cols)"
              class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer"
              :class="activeGridCols === layout.cols ? 'bg-[var(--primary-green)] text-slate-950 shadow-sm' : 'text-[var(--el-text-color-secondary)] hover:text-[var(--el-text-color-primary)]'"
            >
              {{ layout.label }}
            </button>
          </div>

          <!-- Add Camera Button -->
          <button
            @click="openAddCameraModal"
            class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[var(--primary-green)] text-slate-950 text-xs font-bold transition-all cursor-pointer shadow-md shadow-emerald-500/20 hover:opacity-95 active:scale-95"
          >
            <span>{{ t('cameras.addCameraBtn') }}</span>
          </button>
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="cameras.length === 0" class="p-16 text-center bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl">
        <svg class="w-12 h-12 text-slate-500 mx-auto mb-3 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <p class="text-sm font-semibold text-[var(--el-text-color-secondary)]">{{ t('settings.noCameras') }}</p>
        <button
          @click="emit('open-add-camera')"
          class="mt-4 px-4 py-2 rounded-xl bg-[var(--primary-green)] text-slate-950 text-xs font-bold shadow-md cursor-pointer inline-flex items-center gap-1.5"
        >
          <span>{{ t('cameras.addCameraBtn') }}</span>
        </button>
      </div>

      <!-- Multi-Camera Live Grid View with Pagination -->
      <div
        v-else
        class="space-y-6"
      >
        <div
          class="grid gap-6"
          :class="gridColClass"
        >
          <GridCameraCard
            v-for="cam in paginatedCameras"
            :key="cam.deviceSerial"
            :ref="el => setCardRef(el, cam.deviceSerial)"
            :camera="cam"
            @expand="openCameraDetail(cam)"
          />
        </div>

        <!-- Pagination Controls Bar -->
        <div
          v-if="cameras.length > 0"
          class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-2xl p-4 shadow-soft flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <!-- Left: Range Info -->
          <div class="text-xs text-[var(--el-text-color-secondary)]">
            {{ t('common.showing') }}
            <span class="font-bold text-[var(--el-text-color-primary)] font-mono">
              {{ startIndex + 1 }}-{{ Math.min(startIndex + pageSize, cameras.length) }}
            </span>
            {{ t('common.of') }}
            <span class="font-bold text-[var(--el-text-color-primary)] font-mono">
              {{ cameras.length }}
            </span>
            {{ t('nav.cameras').toLowerCase() }}
          </div>

          <!-- Middle: Page Number Buttons -->
          <div class="flex items-center gap-1.5 self-center">
            <!-- Prev Button -->
            <button
              @click="changePage(currentPage - 1)"
              :disabled="currentPage <= 1"
              class="p-2 rounded-xl bg-[var(--el-bg-color)] border border-[var(--el-border-color)] text-[var(--el-text-color-primary)] hover:border-[var(--primary-green)] disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              :title="t('common.prevPage')"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            <!-- Numeric Page buttons -->
            <template v-for="p in visiblePages" :key="p">
              <span v-if="p === '...'" class="px-2 text-xs text-[var(--el-text-color-secondary)]">...</span>
              <button
                v-else
                @click="changePage(p)"
                class="w-8 h-8 rounded-xl text-xs font-bold transition-all cursor-pointer border"
                :class="currentPage === p
                  ? 'bg-[var(--primary-green)] text-slate-950 border-[var(--primary-green)] shadow-md shadow-emerald-500/20'
                  : 'bg-[var(--el-bg-color)] text-[var(--el-text-color-primary)] border-[var(--el-border-color)] hover:border-[var(--primary-green)]'"
              >
                {{ p }}
              </button>
            </template>

            <!-- Next Button -->
            <button
              @click="changePage(currentPage + 1)"
              :disabled="currentPage >= totalPages"
              class="p-2 rounded-xl bg-[var(--el-bg-color)] border border-[var(--el-border-color)] text-[var(--el-text-color-primary)] hover:border-[var(--primary-green)] disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              :title="t('common.nextPage')"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          <!-- Right: Page Size Selector -->
          <div class="flex items-center gap-2 self-end sm:self-auto">
            <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('common.perPage') }}:</span>
            <div class="flex bg-[var(--el-bg-color)] p-0.5 rounded-xl border border-[var(--el-border-color)]">
              <button
                v-for="size in [4, 6, 9, 12]"
                :key="size"
                @click="changePageSize(size)"
                class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer"
                :class="pageSize === size ? 'bg-[var(--primary-green)] text-slate-950 shadow-sm' : 'text-[var(--el-text-color-secondary)] hover:text-[var(--el-text-color-primary)]'"
              >
                {{ size }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- SUB-PAGE 2: DEDICATED CAMERA DETAIL VIEW -->
    <template v-else-if="subPage === 'detail'">
      <!-- Detail Sub-page Navigation Bar -->
      <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-4 shadow-soft flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <!-- Back to Grid button & Breadcrumb -->
        <div class="flex items-center gap-3">
          <button
            @click="backToGrid"
            class="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[var(--el-bg-color)] hover:bg-[var(--el-border-color)]/60 text-[var(--el-text-color-primary)] text-xs font-bold border border-[var(--el-border-color)] transition-all cursor-pointer shadow-sm active:scale-95"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span>{{ t('cameras.backToGrid') }}</span>
          </button>

          <div class="h-6 w-px bg-[var(--el-border-color)]"></div>

          <div>
            <div class="flex items-center gap-2">
              <h3 class="font-bold text-sm text-[var(--el-text-color-primary)]">
                {{ currentDetailCamera?.deviceName }}
              </h3>
              <span
                class="text-[9px] font-bold px-2 py-0.5 rounded-full border"
                :class="currentDetailCamera?.status === 1 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'"
              >
                {{ currentDetailCamera?.status === 1 ? t('common.online') : t('common.offline') }}
              </span>
            </div>
            <p class="text-[10px] font-mono text-[var(--el-text-color-secondary)]">
              SN: {{ currentDetailCamera?.deviceSerial }}
            </p>
          </div>
        </div>

        <!-- Fast Camera Switcher Dropdown in Detail Sub-page -->
        <div class="flex items-center gap-2">
          <span class="text-xs text-[var(--el-text-color-secondary)] hidden md:inline">
            {{ t('cameras.selectCamera') }}:
          </span>
          <el-select
            :model-value="currentDetailCamera?.deviceSerial"
            @change="handleSelectDetailCamera"
            size="default"
            class="!w-60"
          >
            <el-option
              v-for="cam in cameras"
              :key="cam.deviceSerial"
              :label="`${cam.deviceName} (${cam.status === 1 ? 'Online' : 'Offline'})`"
              :value="cam.deviceSerial"
            />
          </el-select>
        </div>
      </div>

      <!-- Live Player and Playback Section -->
      <div class="w-full flex justify-center">
        <LiveTab
          :camera="currentDetailCamera"
          @status="emit('status', $event)"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCameras } from '@/composables/useCameras';
import LiveTab from '@/components/cameras/LiveTab.vue';
import GridCameraCard from '@/components/cameras/GridCameraCard.vue';

const { t } = useI18n();
const { cameras, selectedCamera, selectCamera, openAddCameraModal } = useCameras();

// Sub-page state: 'grid' (default: all cameras grid) or 'detail' (single camera sub-page)
const subPage = ref('grid');
const currentDetailCamera = ref(selectedCamera.value || null);
const activeGridCols = ref('3'); // '2' | '3' | 'auto'

const gridLayouts = [
  { cols: '2', label: '2x2' },
  { cols: '3', label: '3x3' },
  { cols: 'auto', label: 'Auto' }
];

// Pagination state
const currentPage = ref(1);
const pageSize = ref(6);

const totalPages = computed(() => Math.ceil(cameras.value.length / pageSize.value) || 1);
const startIndex = computed(() => (currentPage.value - 1) * pageSize.value);
const endIndex = computed(() => Math.min(startIndex.value + pageSize.value, cameras.value.length));
const paginatedCameras = computed(() => cameras.value.slice(startIndex.value, endIndex.value));

const visiblePages = computed(() => {
  const total = totalPages.value;
  const current = currentPage.value;
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, '...', total];
  }
  if (current >= total - 3) {
    return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, '...', current - 1, current, current + 1, '...', total];
});

const changePage = (page) => {
  if (page < 1 || page > totalPages.value || page === currentPage.value) return;
  stopAllStreams();
  cardRefsMap.clear();
  currentPage.value = page;
};

const changePageSize = (size) => {
  if (size === pageSize.value) return;
  stopAllStreams();
  cardRefsMap.clear();
  pageSize.value = size;
  currentPage.value = 1;
};

const setGridLayout = (cols) => {
  activeGridCols.value = cols;
  if (cols === '2') {
    changePageSize(4);
  } else if (cols === '3') {
    changePageSize(9);
  } else if (cols === 'auto') {
    changePageSize(6);
  }
};

const gridColClass = computed(() => {
  if (activeGridCols.value === '2') {
    return 'grid-cols-1 md:grid-cols-2';
  } else if (activeGridCols.value === '3') {
    return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3';
  }
  return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';
});

// Card references to control multi-stream playback
const cardRefsMap = new Map();
const setCardRef = (el, serial) => {
  if (el) {
    cardRefsMap.set(serial, el);
  } else {
    cardRefsMap.delete(serial);
  }
};

const playAllStreams = () => {
  cardRefsMap.forEach((card) => {
    if (card && typeof card.startLiveStream === 'function') {
      card.startLiveStream();
    }
  });
};

const stopAllStreams = () => {
  cardRefsMap.forEach((card) => {
    if (card && typeof card.stopLiveStream === 'function') {
      card.stopLiveStream();
    }
  });
};

const openCameraDetail = (cam) => {
  stopAllStreams();
  currentDetailCamera.value = cam;
  subPage.value = 'detail';
  selectCamera(cam);
};

const backToGrid = () => {
  subPage.value = 'grid';
  nextTick(() => {
    playAllStreams();
  });
};

const handleSelectDetailCamera = (serial) => {
  const found = cameras.value.find(c => c.deviceSerial === serial);
  if (found) {
    currentDetailCamera.value = found;
    selectCamera(found);
  }
};

// Leave page or switch tab: Stop all cameras
onUnmounted(() => {
  stopAllStreams();
});

watch(
  () => selectedCamera.value,
  (newCam) => {
    if (newCam) {
      currentDetailCamera.value = newCam;
    }
  }
);

watch(
  () => cameras.value.length,
  () => {
    if (currentPage.value > totalPages.value) {
      currentPage.value = Math.max(1, totalPages.value);
    }
  }
);
</script>
