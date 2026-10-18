<template>
  <div class="w-full max-w-7xl mx-auto pb-12 select-none">
    <!-- SUB-PAGE 1: ALL CAMERAS GRID (DEFAULT VIEW) -->
    <template v-if="subPage === 'grid'">
      <PageHeader :title="t('cameras.title')" :subtitle="t('cameras.subtitle')">
        <template #actions>
          <!-- Grid Columns Switcher -->
          <el-segmented
            v-if="!isMobile"
            :model-value="activeGridCols"
            :options="gridLayouts"
            @change="setGridLayout"
          />

          <!-- Add camera covers claiming a self-registered CamOS camera; people who cannot add cameras
               here may still claim one into their personal workspace -->
          <el-button v-if="!canManageCameras" :icon="Connection" data-test="claim-link" @click="router.push({ name: 'claim' })">
            {{ t('claim.button') }}
          </el-button>
          <!-- Add Camera Button -->
          <el-button v-if="canManageCameras" type="primary" :icon="Plus" @click="openAddCameraModal">
            {{ t('cameras.addCameraBtn') }}
          </el-button>
        </template>
      </PageHeader>

      <!-- Empty State -->
      <el-card v-if="cameras.length === 0" shadow="never">
        <el-empty :description="canManageCameras ? t('settings.noCameras') : t('cameras.noSharedCameras')">
          <template #image>
            <el-icon :size="56" class="cameras-empty__icon"><VideoCamera /></el-icon>
          </template>
          <el-button v-if="canManageCameras" type="primary" :icon="Plus" @click="openAddCameraModal">
            {{ t('cameras.addCameraBtn') }}
          </el-button>
          <el-button v-if="!canManageCameras" @click="router.push({ name: 'claim' })">{{ t('claim.button') }}</el-button>
        </el-empty>
      </el-card>

      <!-- Multi-Camera Live Grid View with Pagination -->
      <div v-else class="flex flex-col gap-6">
        <div class="grid gap-6" :class="gridColClass">
          <GridCameraCard
            v-for="cam in paginatedCameras"
            :key="cam.deviceSerial"
            :ref="el => setCardRef(el, cam.deviceSerial)"
            :camera="cam"
            @expand="openCameraDetail(cam)"
          />
        </div>

        <!-- Pagination Controls Bar -->
        <el-card v-if="cameras.length > 0" shadow="never">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <!-- Left: Range Info -->
            <div class="cameras-meta">
              {{ t('common.showing') }}
              <span class="cameras-meta__strong">
                {{ startIndex + 1 }}-{{ Math.min(startIndex + pageSize, cameras.length) }}
              </span>
              {{ t('common.of') }}
              <span class="cameras-meta__strong">{{ cameras.length }}</span>
              {{ t('nav.cameras').toLowerCase() }}
            </div>

            <!-- Middle: Page Number Buttons -->
            <el-pagination
              class="self-center"
              background
              layout="prev, pager, next"
              :current-page="currentPage"
              :page-size="pageSize"
              :total="cameras.length"
              :prev-icon="ArrowLeft"
              :next-icon="ArrowRight"
              @current-change="changePage"
            />

            <!-- Right: Page Size Selector -->
            <div class="flex items-center gap-2 self-end sm:self-auto">
              <span class="cameras-meta">{{ t('common.perPage') }}:</span>
              <el-segmented
                size="small"
                :model-value="pageSize"
                :options="[4, 6, 9, 12]"
                @change="changePageSize"
              />
            </div>
          </div>
        </el-card>
      </div>
    </template>

    <!-- SUB-PAGE 2: DEDICATED CAMERA DETAIL VIEW -->
    <template v-else-if="subPage === 'detail'">
      <!-- Detail: Back, the camera's name; the camera list sits on the right (a drawer on phones) -->
      <div class="cameras-detail__bar flex items-center gap-3 mb-3 sm:mb-4 min-w-0">
        <el-button :icon="Back" data-test="detail-back" @click="backToGrid">{{ t('cameras.back') }}</el-button>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <h3 class="cameras-detail__title truncate">{{ currentDetailCamera?.deviceName }}</h3>
            <el-tag :type="currentDetailCamera?.status === 1 ? 'success' : 'danger'" effect="light" round size="small" class="shrink-0">
              {{ currentDetailCamera?.status === 1 ? t('common.online') : t('common.offline') }}
            </el-tag>
          </div>
          <p class="cameras-meta font-mono truncate">SN: {{ currentDetailCamera?.deviceSerial }}</p>
        </div>
        <el-button v-if="!isWide" :icon="Menu" data-test="switcher-open" @click="switcherOpen = true">{{ t('cameras.switcher.open') }}</el-button>
      </div>

      <!-- Live view (the camera list beside the video on wide screens), recordings, trap upkeep, then the history -->
      <div class="flex flex-col gap-4 min-w-0">
        <LiveTab :camera="currentDetailCamera">
          <template v-if="isWide" #aside>
            <CameraSwitcher class="h-full" :cameras="cameras" :model-value="currentDetailCamera?.deviceSerial || ''" @select="handleSelectDetailCamera" />
          </template>
        </LiveTab>
        <DetectionHistory
          v-if="currentDetailCamera?.deviceSerial"
          :key="currentDetailCamera.deviceSerial"
          :camera-serials="historySerials"
          :default-range="HISTORY_RANGE"
          :title="t('history.cameraTitle')"
        />
      </div>
      <el-drawer v-if="!isWide" v-model="switcherOpen" :title="t('cameras.switcher.title')" direction="rtl" size="min(360px, 92vw)" append-to-body>
        <CameraSwitcher :cameras="cameras" :model-value="currentDetailCamera?.deviceSerial || ''" @select="(serial) => { handleSelectDetailCamera(serial); switcherOpen = false; }" />
      </el-drawer>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { Plus, Back, ArrowLeft, ArrowRight, VideoCamera, Connection, Menu } from '@element-plus/icons-vue';
import { useCameras } from '@/composables/useCameras';
import { useAuth } from '@/composables/useAuth';
import { useBreakpoints } from '@/composables/useBreakpoints';
import PageHeader from '@/components/common/PageHeader.vue';
import LiveTab from '@/components/cameras/LiveTab.vue';
import GridCameraCard from '@/components/cameras/GridCameraCard.vue';
import CameraSwitcher from '@/components/cameras/CameraSwitcher.vue';
import DetectionHistory from '@/components/history/DetectionHistory.vue';

const { t } = useI18n();
const { cameras, selectedCamera, selectCamera, openAddCameraModal } = useCameras();
const router = useRouter();
const { canManageCameras } = useAuth();
// One camera per row on phones: the 2x2/3x3 switch does not apply
const { isMobile } = useBreakpoints();
// The camera list beside the detail view on wide screens, in a drawer below 1280 px
const switcherOpen = ref(false);
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440);
const onResize = () => { viewportWidth.value = window.innerWidth; };
if (typeof window !== 'undefined') window.addEventListener('resize', onResize, { passive: true });
onUnmounted(() => { if (typeof window !== 'undefined') window.removeEventListener('resize', onResize); });
const isWide = computed(() => viewportWidth.value >= 1280);

// Sub-page state: 'grid' (default: all cameras grid) or 'detail' (single camera sub-page)
const subPage = ref('grid');
const currentDetailCamera = ref(selectedCamera.value || null);
// Stable props for the camera's history table (new arrays on every render would reset its filters)
const HISTORY_RANGE = { preset: '7d' };
const historySerials = computed(() => (currentDetailCamera.value?.deviceSerial ? [currentDetailCamera.value.deviceSerial] : []));
const activeGridCols = ref('3'); // '2' | '3' | 'auto'

const gridLayouts = computed(() => [
  { value: '2', label: t('cameras.layout2x2') },
  { value: '3', label: t('cameras.layout3x3') },
  { value: 'auto', label: t('cameras.layoutAuto') }
]);

// Pagination state
const currentPage = ref(1);
const pageSize = ref(6);

const totalPages = computed(() => Math.ceil(cameras.value.length / pageSize.value) || 1);
const startIndex = computed(() => (currentPage.value - 1) * pageSize.value);
const endIndex = computed(() => Math.min(startIndex.value + pageSize.value, cameras.value.length));
const paginatedCameras = computed(() => cameras.value.slice(startIndex.value, endIndex.value));

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

<style scoped>
.cameras-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cameras-meta__strong {
  font-weight: 600;
  font-family: ui-monospace, monospace;
  color: var(--el-text-color-primary);
}
.cameras-detail__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.cameras-empty__icon {
  color: var(--el-text-color-placeholder);
}
</style>
