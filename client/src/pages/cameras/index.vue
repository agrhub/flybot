<template>
  <div class="w-full max-w-7xl mx-auto pb-12 select-none">
    <!-- SUB-PAGE 1: ALL CAMERAS GRID (DEFAULT VIEW) -->
    <template v-if="subPage === 'grid'">
      <PageHeader :title="t('cameras.title')" :subtitle="t('cameras.subtitle')">
        <template #actions>
          <!-- Grid Columns Switcher -->
          <el-segmented
            :model-value="activeGridCols"
            :options="gridLayouts"
            @change="setGridLayout"
          />

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
      <!-- Detail Sub-page Navigation Bar -->
      <el-card shadow="never" class="mb-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <!-- Back to Grid button & Breadcrumb -->
          <div class="flex items-center gap-3 min-w-0">
            <el-button :icon="Back" @click="backToGrid">
              {{ t('cameras.backToGrid') }}
            </el-button>

            <el-divider direction="vertical" />

            <div class="min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <h3 class="cameras-detail__title truncate">
                  {{ currentDetailCamera?.deviceName }}
                </h3>
                <el-tag
                  :type="currentDetailCamera?.status === 1 ? 'success' : 'danger'"
                  effect="light"
                  round
                  size="small"
                >
                  {{ currentDetailCamera?.status === 1 ? t('common.online') : t('common.offline') }}
                </el-tag>
              </div>
              <p class="cameras-meta font-mono">
                SN: {{ currentDetailCamera?.deviceSerial }}
              </p>
            </div>
          </div>

          <!-- Fast Camera Switcher Dropdown in Detail Sub-page -->
          <div class="flex items-center gap-2">
            <span class="cameras-meta hidden md:inline">
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
                :label="`${cam.deviceName} (${cam.status === 1 ? t('common.online') : t('common.offline')})`"
                :value="cam.deviceSerial"
              />
            </el-select>
          </div>
        </div>
      </el-card>

      <!-- Live Player and Playback Section -->
      <div class="w-full flex justify-center">
        <LiveTab
          :camera="currentDetailCamera"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Back, ArrowLeft, ArrowRight, VideoCamera } from '@element-plus/icons-vue';
import { useCameras } from '@/composables/useCameras';
import { useAuth } from '@/composables/useAuth';
import PageHeader from '@/components/common/PageHeader.vue';
import LiveTab from '@/components/cameras/LiveTab.vue';
import GridCameraCard from '@/components/cameras/GridCameraCard.vue';

const { t } = useI18n();
const { cameras, selectedCamera, selectCamera, openAddCameraModal } = useCameras();
const { canManageCameras } = useAuth();

// Sub-page state: 'grid' (default: all cameras grid) or 'detail' (single camera sub-page)
const subPage = ref('grid');
const currentDetailCamera = ref(selectedCamera.value || null);
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
