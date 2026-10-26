<template>
  <div class="w-full max-w-7xl mx-auto pb-12 select-none">
    <!-- SUB-PAGE 1: ALL CAMERAS GRID (DEFAULT VIEW) -->
    <template v-if="subPage === 'grid'">
      <PageHeader :title="t('cameras.title')" :subtitle="t('cameras.subtitle')" tour="cameras">
        <template #actions>
          <!-- Columns per row (phones: always one) -->
          <el-segmented
            v-if="!isMobile"
            :model-value="activeGridCols"
            :options="gridLayouts"
            data-test="grid-cols"
            data-tour="cameras-layout"
            @change="setGridLayout"
          />

          <!-- Add camera covers claiming a self-registered CamOS camera; people who cannot add cameras
               here may still claim one into their personal workspace -->
          <el-button v-if="!canManageCameras" :icon="Connection" data-test="claim-link" data-tour="cameras-add" @click="router.push({ name: 'claim' })">
            {{ t('claim.button') }}
          </el-button>
          <!-- Add Camera Button -->
          <el-button v-if="canManageCameras" type="primary" :icon="Plus" data-tour="cameras-add" @click="openAddCameraModal">
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
        <!-- Search and filters over the whole list; the grid shows one page of the result -->
        <el-card shadow="never" data-tour="cameras-filters">
          <div class="flex flex-wrap items-center gap-2">
            <el-input v-model="filters.query" :placeholder="t('cameras.switcher.search')" :prefix-icon="Search" clearable class="cameras-filters__search" data-test="cameras-search" />
            <el-select v-model="filters.status" class="cameras-filters__select" :aria-label="t('cameras.switcher.status')" data-test="cameras-status">
              <el-option value="all" :label="t('cameras.switcher.allStatus')" />
              <el-option value="online" :label="t('common.online')" />
              <el-option value="offline" :label="t('common.offline')" />
            </el-select>
            <el-select v-model="filters.type" class="cameras-filters__select" :aria-label="t('cameras.switcher.type')" data-test="cameras-type">
              <el-option value="all" :label="t('cameras.switcher.allTypes')" />
              <el-option value="ezviz" :label="t('cameras.platform.ezviz')" />
              <el-option value="camos" :label="t('cameras.platform.camos')" />
            </el-select>
            <el-select v-model="filters.kind" class="cameras-filters__select" :aria-label="t('trapKind.label')" data-test="cameras-kind">
              <el-option value="all" :label="t('cameras.filters.allKinds')" />
              <el-option value="sticky" :label="t('trapKind.sticky.short')" />
              <el-option value="lure" :label="t('trapKind.lure.short')" />
            </el-select>
            <el-select v-if="hasSimulated" v-model="filters.source" class="cameras-filters__select" :aria-label="t('cameras.filters.source')" data-test="cameras-source">
              <el-option value="all" :label="t('cameras.filters.allSources')" />
              <el-option value="real" :label="t('cameras.filters.real')" />
              <el-option value="simulated" :label="t('cameras.filters.simulated')" />
            </el-select>
            <span class="cameras-meta ml-auto" data-test="cameras-count">{{ t('cameras.switcher.count', { shown: filteredCameras.length, total: cameras.length }) }}</span>
          </div>
        </el-card>

        <el-empty v-if="!filteredCameras.length" :description="t('cameras.switcher.none')" :image-size="72" />

        <div v-else class="grid gap-6" :class="gridColClass" data-tour="cameras-grid">
          <GridCameraCard
            v-for="cam in paginatedCameras"
            :key="cam.deviceSerial"
            :ref="el => setCardRef(el, cam.deviceSerial)"
            :camera="cam"
            @expand="openCameraDetail(cam)"
          />
        </div>

        <!-- Pagination Controls Bar -->
        <el-card v-if="filteredCameras.length > 0" shadow="never" data-tour="cameras-pager">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <!-- Left: Range Info -->
            <div class="cameras-meta">
              {{ t('common.showing') }}
              <span class="cameras-meta__strong">
                {{ startIndex + 1 }}-{{ Math.min(startIndex + pageSize, filteredCameras.length) }}
              </span>
              {{ t('common.of') }}
              <span class="cameras-meta__strong">{{ filteredCameras.length }}</span>
              {{ t('nav.cameras').toLowerCase() }}
            </div>

            <!-- Middle: Page Number Buttons -->
            <!-- Phones: smaller, with fewer page numbers, so the pager fits 375 px -->
            <el-pagination
              class="self-center"
              background
              :size="isMobile ? 'small' : 'default'"
              :pager-count="isMobile ? 5 : 7"
              layout="prev, pager, next"
              :current-page="currentPage"
              :page-size="pageSize"
              :total="filteredCameras.length"
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
                :options="pageSizes"
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
            <el-tag :type="STATE_TAG[cameraState(currentDetailCamera)]" effect="light" round size="small" class="shrink-0" data-test="detail-state">
              {{ cameraStateLabel(currentDetailCamera, t) }}
            </el-tag>
          </div>
          <p class="cameras-meta font-mono truncate">SN: {{ currentDetailCamera?.deviceSerial }}</p>
        </div>
        <el-button v-if="!isWide" :icon="Menu" data-test="switcher-open" data-tour="camera-switcher" @click="switcherOpen = true">{{ t('cameras.switcher.open') }}</el-button>
        <PageTour page="camera" />
      </div>

      <!-- Live view (the camera list beside the video on wide screens), recordings, trap upkeep, then the history -->
      <div class="flex flex-col gap-4 min-w-0">
        <LiveTab :camera="currentDetailCamera">
          <template v-if="isWide" #aside>
            <CameraSwitcher class="h-full" data-tour="camera-switcher" :cameras="cameras" :model-value="currentDetailCamera?.deviceSerial || ''" @select="handleSelectDetailCamera" />
          </template>
        </LiveTab>
        <DetectionHistory
          v-if="currentDetailCamera?.deviceSerial"
          :key="currentDetailCamera.deviceSerial"
          :camera-serials="historySerials"
          :default-range="HISTORY_RANGE"
          :title="t('history.cameraTitle')"
          data-tour="camera-history"
        />
      </div>
      <el-drawer v-if="!isWide" v-model="switcherOpen" :title="t('cameras.switcher.title')" direction="rtl" size="min(360px, 92vw)" append-to-body>
        <CameraSwitcher :cameras="cameras" :model-value="currentDetailCamera?.deviceSerial || ''" @select="(serial) => { handleSelectDetailCamera(serial); switcherOpen = false; }" />
      </el-drawer>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onUnmounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { Plus, Back, ArrowLeft, ArrowRight, VideoCamera, Connection, Menu, Search } from '@element-plus/icons-vue';
import { filterCameras, cameraState, cameraStateLabel, STATE_TAG } from '@/utils/cameraFilter';
import { useCameras } from '@/composables/useCameras';
import { useAuth } from '@/composables/useAuth';
import { useBreakpoints } from '@/composables/useBreakpoints';
import PageHeader from '@/components/common/PageHeader.vue';
import PageTour from '@/components/common/PageTour.vue';
import LiveTab from '@/components/cameras/LiveTab.vue';
import GridCameraCard from '@/components/cameras/GridCameraCard.vue';
import CameraSwitcher from '@/components/cameras/CameraSwitcher.vue';
import DetectionHistory from '@/components/history/DetectionHistory.vue';

const { t } = useI18n();
const { cameras, selectedCamera, selectCamera, openAddCameraModal } = useCameras();
const router = useRouter();
const route = useRoute();
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

// Sub-page from the URL: /cameras is the grid, /cameras/:serial one camera's page (so Back and the browser's back
// both return to the grid)
const routeSerial = computed(() => (typeof route.params.serial === 'string' ? route.params.serial : ''));
const subPage = computed(() => (routeSerial.value ? 'detail' : 'grid'));
const currentDetailCamera = ref(selectedCamera.value?.deviceSerial === routeSerial.value ? selectedCamera.value : null);
// Stable props for the camera's history table (new arrays on every render would reset its filters)
const HISTORY_RANGE = { preset: '7d' };
const historySerials = computed(() => (currentDetailCamera.value?.deviceSerial ? [currentDetailCamera.value.deviceSerial] : []));
// Columns per row (2 to 5), remembered per browser; a page holds whole rows
const COLS = [2, 3, 4, 5];
const COLS_KEY = 'flybot.cameras.cols';
const storedCols = () => {
  try { return Number(localStorage.getItem(COLS_KEY)); } catch { return 0; }
};
const activeGridCols = ref(COLS.includes(storedCols()) ? storedCols() : 3);
const gridLayouts = computed(() => COLS.map((n) => ({ value: n, label: t('cameras.layoutCols', { n }) })));
const pageSizes = computed(() => [2, 3, 4].map((rows) => rows * activeGridCols.value));

// Search and filters over the whole list
const filters = reactive({ query: '', status: 'all', type: 'all', kind: 'all', source: 'all' });
const filteredCameras = computed(() => filterCameras(cameras.value, filters));
const hasSimulated = computed(() => cameras.value.some((c) => c.simulated));

// Pagination state
const currentPage = ref(1);
const pageSize = ref(activeGridCols.value * 3);

const totalPages = computed(() => Math.ceil(filteredCameras.value.length / pageSize.value) || 1);
const startIndex = computed(() => (currentPage.value - 1) * pageSize.value);
const endIndex = computed(() => Math.min(startIndex.value + pageSize.value, filteredCameras.value.length));
const paginatedCameras = computed(() => filteredCameras.value.slice(startIndex.value, endIndex.value));

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
  try { localStorage.setItem(COLS_KEY, String(cols)); } catch { /* private mode: not remembered */ }
  changePageSize(cols * 3);
};

// A filter change starts again at page 1 (and stops the streams of the cards that leave)
watch(() => JSON.stringify(filters), () => {
  stopAllStreams();
  cardRefsMap.clear();
  currentPage.value = 1;
});

// Fewer columns on narrower screens; the chosen count from xl up
const GRID_CLASS = {
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
  5: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'
};
const gridColClass = computed(() => GRID_CLASS[activeGridCols.value] || GRID_CLASS[3]);

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
  selectCamera(cam);
  router.push({ name: 'camera-detail', params: { serial: cam.deviceSerial } });
};

// Back to the grid this page came from (as the browser's back does), or to the grid when the page was opened directly
const backToGrid = () => {
  if (window.history.state?.back === router.resolve({ name: 'cameras' }).fullPath) router.back();
  else router.push({ name: 'cameras' });
};

// Another camera from the list beside the video: same page, so it replaces this one in the history
const handleSelectDetailCamera = (serial) => {
  if (cameras.value.some(c => c.deviceSerial === serial)) router.replace({ name: 'camera-detail', params: { serial } });
};

// The URL decides what shows: the camera it names (once the list has loaded), or the grid with its streams playing
watch([routeSerial, () => cameras.value.length], ([serial], [before] = []) => {
  if (!serial) {
    if (before) nextTick(() => playAllStreams());
    return;
  }
  const found = cameras.value.find(c => c.deviceSerial === serial);
  if (found) {
    if (currentDetailCamera.value?.deviceSerial !== serial) stopAllStreams();
    currentDetailCamera.value = found;
    selectCamera(found);
  } else if (cameras.value.length) {
    // Not a camera this person can see
    router.replace({ name: 'cameras' });
  }
}, { immediate: true });

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
.cameras-filters__search {
  width: min(320px, 100%);
}
.cameras-filters__select {
  width: 150px;
}
</style>
