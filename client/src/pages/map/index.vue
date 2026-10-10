<template>
  <div class="space-y-6 w-full max-w-7xl mx-auto pb-12 select-none">
    <!-- Top Header Banner -->
    <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-3xl p-5 shadow-soft flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="w-2 h-2 rounded-full bg-[var(--primary-green)] animate-pulse"></span>
          <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">
            {{ t('dashboard.mapViewTitle') || 'Bản Đồ Phân Bố Bẫy Côn Trùng (Field Map)' }}
          </h3>
        </div>
        <p class="text-xs text-[var(--el-text-color-secondary)]">
          {{ t('dashboard.mapViewSubtitle') || 'Giám sát vị trí tọa độ GPS, cảnh báo mật độ ruồi vàng và kéo thả marker để cập nhật tọa độ bẫy.' }}
        </p>
      </div>

      <div class="flex items-center gap-3">
        <!-- Outbreak Legend Badges -->
        <div class="flex items-center gap-2 bg-[var(--el-bg-color)] px-3 py-1.5 rounded-2xl border border-[var(--el-border-color)] text-xs">
          <span class="flex items-center gap-1 font-semibold text-emerald-400">
            <span class="w-2 h-2 rounded-full bg-emerald-400"></span> {{ t('map.safe') }}
          </span>
          <span class="text-slate-500">|</span>
          <span class="flex items-center gap-1 font-semibold text-amber-400">
            <span class="w-2 h-2 rounded-full bg-amber-400"></span> {{ t('map.moderate') }}
          </span>
          <span class="text-slate-500">|</span>
          <span class="flex items-center gap-1 font-semibold text-red-400">
            <span class="w-2 h-2 rounded-full bg-red-400"></span> {{ t('map.alert') }}
          </span>
        </div>
      </div>
    </div>

    <!-- Main Map & Side Camera Roster Layout -->
    <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <!-- Left / Center: Interactive Leaflet Map Container -->
      <div class="lg:col-span-3 bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-[28px] overflow-hidden shadow-soft relative h-[620px] flex flex-col">
        <div ref="mapContainerRef" class="w-full h-full z-0 bg-[var(--el-bg-color)]"></div>

        <!-- Google Maps Style Layer Switcher & Hint Overlay (Bottom-Left) -->
        <div class="absolute bottom-4 left-4 z-[400] flex items-center gap-3">
          <button
            @click="toggleBaseLayer"
            type="button"
            class="group relative w-14 h-14 sm:w-16 sm:h-16 rounded-xl overflow-hidden border-2 border-white/90 shadow-2xl hover:scale-105 active:scale-95 transition-all duration-200 cursor-pointer focus:outline-none shrink-0"
            :title="activeLayerType === 'street' ? (t('map.layerEarth') || 'Chuyển sang Vệ tinh') : (t('map.layerStreet') || 'Chuyển sang Bản đồ')"
          >
            <!-- Thumbnail Image -->
            <img
              :src="activeLayerType === 'street' ? satelliteThumbUrl : streetThumbUrl"
              :alt="activeLayerType === 'street' ? 'Satellite' : 'Street'"
              class="w-full h-full object-cover group-hover:brightness-110 transition-all duration-200"
            />

            <!-- Bottom Label Overlay with Google Layers Icon -->
            <div class="absolute inset-x-0 bottom-0 py-0.5 px-1 bg-black/75 backdrop-blur-[2px] flex items-center justify-center gap-1 text-[10px] font-bold text-white tracking-tight leading-tight">
              <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9.07l-9-7-9 7 1.64 1.2L12 16zm0-11.47L17.74 9 12 13.47 6.26 9 12 4.53z" />
              </svg>
              <span class="truncate">{{ activeLayerType === 'street' ? (t('map.satelliteShort') || 'Vệ tinh') : (t('map.streetShort') || 'Bản đồ') }}</span>
            </div>
          </button>

          <!-- Floating Hint Overlay -->
          <div class="hidden sm:flex bg-slate-900/85 backdrop-blur-md text-white text-[11px] px-3.5 py-2 rounded-xl border border-white/10 items-center gap-2 pointer-events-none shadow-lg">
            <span class="w-2 h-2 rounded-full bg-[var(--primary-green)] animate-ping"></span>
            <span>{{ t('map.dragHint') }}</span>
          </div>
        </div>
      </div>

      <!-- Right: Camera Traps Location List & Quick Editor -->
      <div class="space-y-4">
        <div class="bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] rounded-[28px] p-5 shadow-soft flex flex-col h-[620px]">
          <div class="flex items-center justify-between pb-3 mb-3 border-b border-[var(--el-border-color)]">
            <div>
              <h4 class="font-bold text-sm text-[var(--el-text-color-primary)]">{{ t('map.trapList') }}</h4>
              <p class="text-[11px] text-[var(--el-text-color-secondary)]">{{ t('map.monitoringDevices', { count: enrichedCameras.length }) }}</p>
            </div>
          </div>

          <!-- Search Camera by Name or Serial -->
          <div class="mb-3">
            <div class="relative flex items-center">
              <svg class="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                v-model="searchQuery"
                type="text"
                :placeholder="t('map.searchPlaceholder')"
                @keydown.enter="handleSearchEnter"
                class="w-full bg-[var(--el-bg-color)] text-[var(--el-text-color-primary)] placeholder-slate-500 text-xs pl-9 pr-8 py-2 rounded-xl border border-[var(--el-border-color)] focus:border-[var(--primary-green)] focus:outline-none transition-colors"
              />
              <button
                v-if="searchQuery"
                @click="clearSearch"
                class="absolute right-2.5 text-slate-400 hover:text-slate-200 text-xs p-0.5 rounded-full cursor-pointer"
                :title="t('map.clearSearch')"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div v-if="searchQuery" class="flex items-center justify-between mt-1 px-1 text-[10px] text-slate-400">
              <span>{{ t('map.searchResults', { count: filteredCameras.length }) }}</span>
              <button @click="handleSearchEnter" class="text-[var(--primary-green)] hover:underline font-semibold cursor-pointer">
                {{ t('map.focusMatching') }}
              </button>
            </div>
          </div>

          <!-- Scrollable Camera List -->
          <div class="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
            <!-- No search results empty state -->
            <div
              v-if="filteredCameras.length === 0"
              class="py-12 text-center text-xs text-slate-400 space-y-2"
            >
              <svg class="w-8 h-8 mx-auto text-slate-600 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <p>{{ t('map.noTrapsFound') }}</p>
              <button
                v-if="searchQuery"
                @click="clearSearch"
                class="text-[var(--primary-green)] text-[11px] font-semibold hover:underline cursor-pointer"
              >
                {{ t('map.clearSearch') }}
              </button>
            </div>

            <div
              v-for="cam in filteredCameras"
              :key="cam.deviceSerial"
              @click="focusCamera(cam)"
              class="p-3.5 rounded-2xl border transition-all cursor-pointer relative group"
              :class="selectedCam?.deviceSerial === cam.deviceSerial
                ? 'bg-[var(--el-bg-color)] border-[var(--primary-green)] shadow-md'
                : 'bg-[var(--el-bg-color)]/60 border-[var(--el-border-color)] hover:border-slate-400'"
            >
              <div class="flex items-start gap-3">
                <!-- Thumbnail -->
                <div class="w-11 h-11 rounded-xl overflow-hidden shrink-0 border border-[var(--el-border-color)] bg-slate-900/60 flex items-center justify-center relative">
                  <img
                    v-if="cam.thumbnailUrl || cam.picUrl"
                    :src="api.getImageUrl(cam.thumbnailUrl || cam.picUrl)"
                    :alt="cam.deviceName"
                    class="w-full h-full object-cover"
                    @error="(e) => e.target.style.display = 'none'"
                  />
                  <svg v-else class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span
                    class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[var(--el-card-bg-color)] z-10"
                    :class="cam.status ? 'bg-emerald-400' : 'bg-slate-400'"
                  ></span>
                </div>

                <div class="min-w-0 flex-1">
                  <div class="flex items-center justify-between gap-1">
                    <h5 class="text-xs font-bold text-[var(--el-text-color-primary)] truncate">{{ cam.deviceName || cam.deviceSerial }}</h5>
                    <!-- Insect Badge -->
                    <span
                      class="text-[11px] font-extrabold px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1 shadow-sm"
                      :class="getDensityBadgeClass(cam.currentCount)"
                    >
                      <span>{{ cam.currentCount }}</span>
                      <span class="text-[9px] font-normal">{{ t('map.fruitFlyShort') }}</span>
                    </span>
                  </div>
                  <p class="text-[10px] text-[var(--el-text-color-secondary)] font-mono mt-0.5 truncate">{{ cam.deviceSerial }}</p>
                </div>
              </div>

              <!-- Address snippet -->
              <div class="mt-2 text-[11px] text-[var(--el-text-color-secondary)] line-clamp-1 flex items-center gap-1">
                <svg class="w-3 h-3 text-[var(--primary-green)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                </svg>
                <span class="truncate">{{ cam.locationAddress || t('map.noAddress') }}</span>
              </div>

              <!-- Coordinates snippet -->
              <div class="mt-1 flex items-center justify-between text-[10px] text-slate-400 font-mono">
                <span>{{ cam.latitude?.toFixed(4) }}, {{ cam.longitude?.toFixed(4) }}</span>
                <button
                  @click.stop="openEditModal(cam)"
                  class="text-[var(--primary-green)] hover:underline font-sans font-bold flex items-center gap-1"
                >
                  <span>{{ t('map.edit') }}</span>
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit Camera Location & Orchard Address Dialog -->
    <el-dialog
      v-model="editDialogVisible"
      :title="t('map.editModalTitle')"
      width="480px"
      append-to-body
      class="rounded-3xl"
    >
      <div v-if="editingCam" class="space-y-4 pt-1">
        <div class="bg-[var(--el-bg-color)] p-4 rounded-2xl border border-[var(--el-border-color)] text-xs text-[var(--el-text-color-secondary)] leading-relaxed flex items-start gap-3">
          <svg class="w-5 h-5 text-[var(--primary-green)] shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>
            {{ t('map.editModalHint') }}
          </p>
        </div>

        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1">{{ t('map.trapNameAndSerial') }}</label>
          <div class="text-sm font-bold text-[var(--el-text-color-primary)]">
            {{ editingCam.deviceName }} ({{ editingCam.deviceSerial }})
          </div>
        </div>

        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('map.orchardAddress') }}</label>
          <el-input
            v-model="editForm.locationAddress"
            :placeholder="t('map.orchardAddressPlaceholder')"
            size="large"
            clearable
          />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('map.latitude') }}</label>
            <el-input
              v-model.number="editForm.latitude"
              type="number"
              step="0.0001"
              placeholder="11.1345"
              size="large"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('map.longitude') }}</label>
            <el-input
              v-model.number="editForm.longitude"
              type="number"
              step="0.0001"
              placeholder="106.5052"
              size="large"
            />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('map.trapType') }}</label>
            <el-input
              v-model="editForm.trapType"
              :placeholder="t('map.trapTypePlaceholder')"
              size="large"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('map.cropType') }}</label>
            <el-input
              v-model="editForm.cropType"
              :placeholder="t('map.cropTypePlaceholder')"
              size="large"
            />
          </div>
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2.5 pt-2">
          <el-button @click="editDialogVisible = false" size="large" class="!rounded-2xl">
            {{ t('common.cancel') }}
          </el-button>
          <el-button
            type="primary"
            @click="handleSaveLocation"
            :loading="savingLocation"
            size="large"
            class="!rounded-2xl !bg-[var(--primary-green)] !border-none !text-slate-950 font-bold"
          >
            {{ t('common.save') }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import { useCameras } from '@/composables/useCameras';
import api from '@/services/api';
import { ElNotification } from 'element-plus';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import EZUIKit from 'ezuikit-js';

const { t } = useI18n();
const { isDark } = useTheme();
const { cameras } = useCameras();

const mapContainerRef = ref(null);
let map = null;
let streetLayer = null;
let earthLayer = null;
const markersMap = new Map();

const selectedCam = ref(null);
const realtimeData = ref([]);
const editDialogVisible = ref(false);
const editingCam = ref(null);
const savingLocation = ref(false);

const editForm = ref({
  locationAddress: '',
  latitude: 11.1345,
  longitude: 106.5052,
  trapType: 'Bẫy Pheromone thông minh',
  cropType: 'Xoài Cát Chu'
});

// Merge cameras with overview realtime counts
const enrichedCameras = computed(() => {
  return cameras.value.map(cam => {
    const live = realtimeData.value.find(r => r.deviceSerial === cam.deviceSerial);
    return {
      ...cam,
      latitude: cam.latitude || live?.latitude || 11.1345,
      longitude: cam.longitude || live?.longitude || 106.5052,
      locationAddress: cam.locationAddress || live?.locationAddress || '',
      currentCount: live?.currentCount ?? 0,
      riskLevel: live?.riskLevel || (live?.currentCount >= 20 ? 'high' : (live?.currentCount >= 6 ? 'moderate' : 'low')),
      trapType: cam.trapType || live?.trapType || 'Bẫy dính Pheromone',
      cropType: cam.cropType || live?.cropType || 'Cây ăn trái'
    };
  });
});

// Search & Filter state
const searchQuery = ref('');

const filteredCameras = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return enrichedCameras.value;
  return enrichedCameras.value.filter(cam => {
    const name = (cam.deviceName || '').toLowerCase();
    const serial = (cam.deviceSerial || '').toLowerCase();
    const address = (cam.locationAddress || '').toLowerCase();
    return name.includes(q) || serial.includes(q) || address.includes(q);
  });
});

const handleSearchEnter = () => {
  if (filteredCameras.value.length === 1) {
    focusCamera(filteredCameras.value[0]);
  } else if (filteredCameras.value.length > 1) {
    const latLngs = filteredCameras.value.map(c => [Number(c.latitude) || 11.1345, Number(c.longitude) || 106.5052]);
    if (map && latLngs.length > 0) {
      map.fitBounds(L.latLngBounds(latLngs), { padding: [60, 60], maxZoom: 16 });
    }
  }
};

const resetMapView = () => {
  if (!map) return;
  const latLngs = enrichedCameras.value.map(c => [Number(c.latitude) || 11.141, Number(c.longitude) || 106.514]);
  if (latLngs.length > 0) {
    map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 16 });
  } else {
    map.setView([11.141, 106.514], 13);
  }
};

const locateUserOrchard = () => {
  if (!navigator.geolocation) {
    ElNotification({ title: t('common.error') || 'Lỗi', message: 'Trình duyệt không hỗ trợ Geolocation.', type: 'warning' });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      if (map) {
        map.flyTo([lat, lng], 16);
        L.circleMarker([lat, lng], {
          radius: 8,
          fillColor: '#3b82f6',
          color: '#ffffff',
          weight: 2,
          fillOpacity: 0.9
        }).addTo(map).bindPopup(t('map.locateMeTitle') || 'Vị trí thiết bị của bạn').openPopup();
      }
    },
    (err) => {
      ElNotification({ title: 'Định vị GPS', message: 'Không thể lấy tọa độ: ' + err.message, type: 'warning' });
    }
  );
};

const clearSearch = () => {
  searchQuery.value = '';
  resetMapView();
};

const getDensityBadgeClass = (count) => {
  if (count >= 16) return 'bg-red-500/15 text-red-400 border border-red-500/30';
  if (count >= 5) return 'bg-amber-500/15 text-amber-400 border border-amber-500/30';
  return 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
};

const getPinColor = (count) => {
  if (count >= 16) return '#ef4444'; // Red
  if (count >= 5) return '#f59e0b'; // Amber
  return '#10b981'; // Emerald
};

const createCustomIcon = (cam) => {
  const color = getPinColor(cam.currentCount);
  const isHigh = cam.currentCount >= 16;
  const pulseHtml = isHigh ? `<div class="absolute -inset-2 rounded-full animate-ping opacity-40" style="background-color: ${color}"></div>` : '';

  const html = `
    <div class="relative flex flex-col items-center cursor-pointer select-none group" style="transform: translate(-50%, -100%);">
      ${pulseHtml}
      <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full shadow-xl border border-white/20 text-white font-extrabold text-[11px]" style="background-color: ${color}">
        <svg class="w-3.5 h-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 2a6 6 0 00-6 6c0 4.418 6 10 6 10s6-5.582 6-10a6 6 0 00-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z"/>
        </svg>
        <!--<span>${cam.currentCount}</span>-->
      </div>
      <div class="w-2.5 h-2.5 rotate-45 -mt-1 shadow-md" style="background-color: ${color}"></div>
      <div class="bg-slate-900/90 text-white text-[10px] font-bold px-2 py-0.5 rounded-md mt-1 border border-white/10 shadow-lg whitespace-nowrap">
        ${cam.deviceName || cam.deviceSerial} <span style="color: ${color}">(${cam.currentCount})</span>
      </div>
    </div>
  `;

  return L.divIcon({
    className: 'custom-leaflet-marker',
    html: html,
    iconSize: [40, 40],
    iconAnchor: [20, 40]
  });
};

const GOOGLE_MAP_KEY = import.meta.env.VITE_GOOGLE_MAP_KEY || import.meta.env.GOOGLE_MAP_KEY || '';

const getStreetTileUrl = () => {
  return `https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&key=${GOOGLE_MAP_KEY}`;
};

const getEarthTileUrl = () => {
  return `https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&key=${GOOGLE_MAP_KEY}`;
};

const activeLayerType = ref('street');
const satelliteThumbUrl = `https://mt1.google.com/vt/lyrs=y&x=26&y=15&z=5&key=${GOOGLE_MAP_KEY}`;
const streetThumbUrl = `https://mt1.google.com/vt/lyrs=m&x=26&y=15&z=5&key=${GOOGLE_MAP_KEY}`;

const toggleBaseLayer = () => {
  if (!map || !streetLayer || !earthLayer) return;
  if (activeLayerType.value === 'street') {
    streetLayer.remove();
    earthLayer.addTo(map);
    activeLayerType.value = 'earth';
  } else {
    earthLayer.remove();
    streetLayer.addTo(map);
    activeLayerType.value = 'street';
  }
};

const initMap = () => {
  if (!mapContainerRef.value || map) return;

  // Default coordinate center: Cu Chi orchard plot
  const defaultCenter = [11.141, 106.514];
  map = L.map(mapContainerRef.value, {
    zoomControl: false
  }).setView(defaultCenter, 13);

  // 1. Google Maps Street Layer
  streetLayer = L.tileLayer(getStreetTileUrl(), {
    maxZoom: 20,
    subdomains: ['0', '1', '2', '3'],
    className: 'leaflet-google-street-tiles',
    attribution: '&copy; Google Maps'
  });

  // 2. Google Earth (Satellite Hybrid) Layer with API key
  earthLayer = L.tileLayer(getEarthTileUrl(), {
    maxZoom: 20,
    subdomains: ['0', '1', '2', '3'],
    className: 'leaflet-google-earth-tiles',
    attribution: '&copy; Google Maps'
  });

  // Add initial layer based on state
  if (activeLayerType.value === 'street') {
    streetLayer.addTo(map);
  } else {
    earthLayer.addTo(map);
  }

  // 2. Zoom control (+ / -)
  L.control.zoom({ position: 'topright' }).addTo(map);

  // 3. Custom Action Control (My Location & Full View)
  const MapActionControl = L.Control.extend({
    options: {
      position: 'bottomright'
    },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-bar custom-leaflet-action-bar');

      // Locate Me Button
      const locateBtn = L.DomUtil.create('a', 'leaflet-action-btn locate-btn', container);
      locateBtn.href = '#';
      locateBtn.setAttribute('role', 'button');
      locateBtn.title = t('map.locateMeTitle') || t('map.locateMe') || 'Định vị GPS hiện tại';
      locateBtn.innerHTML = `
        <svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3" stroke-width="2.5"></circle>
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
        </svg>
      `;
      L.DomEvent.on(locateBtn, 'click', (e) => {
        L.DomEvent.stop(e);
        locateUserOrchard();
      });

      // Full View Button
      const fullViewBtn = L.DomUtil.create('a', 'leaflet-action-btn fullview-btn', container);
      fullViewBtn.href = '#';
      fullViewBtn.setAttribute('role', 'button');
      fullViewBtn.title = t('map.viewWholeOrchardTitle') || t('map.viewWholeOrchard') || 'Toàn cảnh các bẫy';
      fullViewBtn.innerHTML = `
        <svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      `;
      L.DomEvent.on(fullViewBtn, 'click', (e) => {
        L.DomEvent.stop(e);
        resetMapView();
      });

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    }
  });

  new MapActionControl().addTo(map);

  // Listen to map-level popup close to stop live streaming
  map.on('popupclose', () => {
    stopPopupPlayer();
  });

  renderMarkers();
};

let activePopupPlayer = null;
let activePopupSerial = null;

const stopPopupPlayer = () => {
  if (activePopupPlayer) {
    try {
      if (typeof activePopupPlayer.stop === 'function') activePopupPlayer.stop();
      if (typeof activePopupPlayer.destroy === 'function') activePopupPlayer.destroy();
    } catch (e) {
      console.warn('Error stopping popup player:', e);
    }
    activePopupPlayer = null;
  }

  if (activePopupSerial) {
    const serial = activePopupSerial;
    try {
      api.disableStream(serial);
    } catch (e) {}

    const thumb = document.getElementById(`popup-thumb-${serial}`);
    const playerEl = document.getElementById(`popup-player-${serial}`);
    const overlay = document.getElementById(`popup-play-overlay-${serial}`);
    const loading = document.getElementById(`popup-loading-${serial}`);
    const btn = document.getElementById(`view-stream-${serial}`);

    if (thumb) thumb.style.display = 'block';
    if (playerEl) {
      playerEl.style.display = 'none';
      playerEl.innerHTML = '';
    }
    if (overlay) overlay.style.display = 'flex';
    if (loading) loading.style.display = 'none';
    if (btn) {
      btn.innerHTML = `▶ ${t('dashboard.watchStream') || 'Xem luồng'}`;
      btn.style.background = '#10b981';
      btn.style.color = '#022c22';
    }

    activePopupSerial = null;
  }
};

const playPopupStream = async (cam) => {
  const serial = cam.deviceSerial;

  // Toggle: If this camera is already playing, stop it
  if (activePopupSerial === serial && activePopupPlayer) {
    stopPopupPlayer();
    return;
  }

  // If another camera was playing, stop it first
  if (activePopupPlayer) {
    stopPopupPlayer();
  }

  if (cam.status !== 1) {
    ElNotification({
      title: t('cameras.deviceOffline') || 'Thiết bị ngoại tuyến',
      message: t('cameras.deviceOfflineMsg') || 'Camera hiện đang mất kết nối.',
      type: 'warning'
    });
    return;
  }

  const thumb = document.getElementById(`popup-thumb-${serial}`);
  const playerEl = document.getElementById(`popup-player-${serial}`);
  const overlay = document.getElementById(`popup-play-overlay-${serial}`);
  const loading = document.getElementById(`popup-loading-${serial}`);
  const btn = document.getElementById(`view-stream-${serial}`);

  if (loading) loading.style.display = 'flex';
  if (overlay) overlay.style.display = 'none';
  if (btn) {
    btn.innerHTML = `<span class="popup-spinner-sm"></span> ${t('cameras.connectingStream') || 'Đang kết nối...'}`;
    btn.style.background = '#e2e8f0';
    btn.style.color = '#475569';
  }

  try {
    const res = await api.getLiveStream(serial, '', 1, 1);
    const data = res.data;

    let playUrl = '';
    let accessToken = '';
    let areaDomain = '';
    let validateCode = (cam.validateCode || '').trim();

    if (data.data?.url) {
      playUrl = data.data.url;
      accessToken = data.data.accessToken || '';
      areaDomain = data.data.areaDomain || '';
      if (data.data.validateCode) validateCode = data.data.validateCode;
    } else if (data.url) {
      playUrl = data.url;
    }

    if (!playUrl) {
      throw new Error(data.msg || 'Không thể lấy luồng video.');
    }

    if (loading) loading.style.display = 'none';
    if (thumb) thumb.style.display = 'none';
    if (playerEl) {
      playerEl.style.display = 'block';
      playerEl.innerHTML = '';
    }

    activePopupSerial = serial;

    const box = document.getElementById(`popup-media-box-${serial}`);
    const width = box ? box.clientWidth : 270;
    const height = box ? box.clientHeight : 155;

    activePopupPlayer = new EZUIKit.EZUIKitPlayer({
      id: `popup-player-${serial}`,
      url: playUrl,
      accessToken: accessToken,
      token: accessToken,
      width: width,
      height: height,
      language: 'en',
      download: false,
      scaleMode: 1,
      streamInfoCBType: 1,
      staticPath: window.location.origin + '/ezuikit_static',
      env: {
        domain: areaDomain || 'https://open.ezvizlife.com'
      },
      loggerOptions: {
        level: 'WARN',
        name: `popup-player-${serial}`,
        showTime: false
      },
      handleError: (error) => {
        console.warn(`[Popup Player ${serial}] Error:`, error);
      }
    });

    if (btn) {
      btn.innerHTML = `⏹ ${t('cameras.stopStream') || 'Dừng luồng'}`;
      btn.style.background = '#ef4444';
      btn.style.color = '#ffffff';
    }
  } catch (err) {
    console.error('Failed to start popup stream:', err);
    stopPopupPlayer();
    ElNotification({
      title: t('common.error'),
      message: err.message || t('cameras.streamError') || 'Lỗi phát luồng',
      type: 'error'
    });
  }
};

const renderMarkers = () => {
  if (!map) return;

  // Clear existing markers & any running popup player
  stopPopupPlayer();
  markersMap.forEach(marker => marker.remove());
  markersMap.clear();

  const cams = enrichedCameras.value;
  if (cams.length === 0) return;

  const latLngs = [];

  cams.forEach(cam => {
    const lat = Number(cam.latitude) || 11.1345;
    const lng = Number(cam.longitude) || 106.5052;
    latLngs.push([lat, lng]);

    const marker = L.marker([lat, lng], {
      icon: createCustomIcon(cam),
      draggable: true
    }).addTo(map);

    // Draggable event
    marker.on('dragend', async (e) => {
      const position = e.target.getLatLng();
      cam.latitude = position.lat;
      cam.longitude = position.lng;

      try {
        await api.updateCameraLocation({
          deviceSerial: cam.deviceSerial,
          latitude: position.lat,
          longitude: position.lng
        });
        ElNotification({
          title: t('common.success'),
          message: `Đã cập nhật tọa độ mới cho ${cam.deviceName}: [${position.lat.toFixed(4)}, ${position.lng.toFixed(4)}]`,
          type: 'success'
        });
      } catch (err) {
        ElNotification({
          title: t('common.error'),
          message: 'Không thể lưu tọa độ: ' + err.message,
          type: 'error'
        });
      }
    });

    // Thumbnail & In-place Video Player Container
    const thumbUrl = (cam.thumbnailUrl || cam.picUrl) ? api.getImageUrl(cam.thumbnailUrl || cam.picUrl) : '';
    const thumbImgHtml = thumbUrl
      ? `<img id="popup-thumb-${cam.deviceSerial}" src="${thumbUrl}" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="this.style.display='none'" />`
      : `<div id="popup-thumb-${cam.deviceSerial}" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #0f172a; color: #64748b; font-size: 11px;">Camera Preview</div>`;

    const popupContent = `
      <div style="font-family: inherit; width: 270px; padding: 4px;">
        <!-- Video / Thumbnail Area (In-place Player) -->
        <div id="popup-media-box-${cam.deviceSerial}" style="width: 100%; height: 155px; border-radius: 10px; overflow: hidden; margin-bottom: 8px; background: #020617; position: relative; cursor: pointer;">
          ${thumbImgHtml}
          <div id="popup-player-${cam.deviceSerial}" style="width: 100%; height: 100%; display: none; position: absolute; inset: 0;"></div>
          <div id="popup-play-overlay-${cam.deviceSerial}" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.25); transition: opacity 0.2s;">
            <div style="width: 38px; height: 38px; border-radius: 50%; background: rgba(16, 185, 129, 0.9); display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.4);">
              <svg style="width: 18px; height: 18px; color: #022c22; margin-left: 2px;" fill="currentColor" viewBox="0 0 20 20">
                <path d="M6.3 2.841A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
              </svg>
            </div>
          </div>
          <div id="popup-loading-${cam.deviceSerial}" style="display: none; position: absolute; inset: 0; background: rgba(2,6,23,0.8); backdrop-filter: blur(2px); align-items: center; justify-content: center; flex-direction: column; gap: 6px; color: #34d399; font-size: 11px; font-weight: 700;">
            <div class="popup-spinner"></div>
            <span>${t('cameras.connectingStream') || 'Đang kết nối...'}</span>
          </div>
        </div>

        <!-- Header Info -->
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
          <div style="font-weight: 800; font-size: 13px; color: var(--el-text-color-primary, #f1f5f9); max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${cam.deviceName || cam.deviceSerial}
          </div>
          <span style="font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 9999px; ${cam.status ? 'background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);' : 'background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);'}">
            ${cam.status ? (t('common.online') || 'Online') : (t('common.offline') || 'Offline')}
          </span>
        </div>

        <div style="font-size: 11px; color: var(--el-text-color-secondary, #94a3b8); margin-bottom: 6px; font-family: monospace;">
          SN: ${cam.deviceSerial}
        </div>

        <!-- Density & Orchard Info -->
        <div class="popup-info-box">
          <div><b>${t('dashboard.realtimeByCamera')}:</b> <span style="color: ${getPinColor(cam.currentCount)}; font-weight: 800;">${cam.currentCount} ${t('dashboard.insectsShort')}</span></div>
          <div><b>${t('map.cropType')}:</b> ${cam.cropType}</div>
          <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><b>${t('map.orchardAddress')}:</b> ${cam.locationAddress || t('map.noAddress')}</div>
        </div>

        <!-- In-place Live View Button -->
        <button id="view-stream-${cam.deviceSerial}" style="width: 100%; background: #10b981; color: #022c22; font-weight: 700; font-size: 11px; padding: 7px 10px; border: none; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.2s;">
          ▶ ${t('dashboard.watchStream')}
        </button>
      </div>
    `;

    marker.bindPopup(popupContent);

    marker.on('popupopen', () => {
      selectedCam.value = cam;

      // Click button to toggle stream
      const btn = document.getElementById(`view-stream-${cam.deviceSerial}`);
      if (btn) {
        btn.onclick = () => {
          playPopupStream(cam);
        };
      }

      // Click thumbnail box directly to start stream
      const mediaBox = document.getElementById(`popup-media-box-${cam.deviceSerial}`);
      if (mediaBox) {
        mediaBox.onclick = () => {
          playPopupStream(cam);
        };
      }
    });

    marker.on('popupclose', () => {
      if (activePopupSerial === cam.deviceSerial) {
        stopPopupPlayer();
      }
    });

    markersMap.set(cam.deviceSerial, marker);
  });

  if (latLngs.length > 0) {
    const bounds = L.latLngBounds(latLngs);
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
  }
};

const focusCamera = (cam) => {
  selectedCam.value = cam;
  if (!map) return;
  const lat = Number(cam.latitude) || 11.1345;
  const lng = Number(cam.longitude) || 106.5052;
  map.flyTo([lat, lng], 16, { duration: 1.2 });

  const marker = markersMap.get(cam.deviceSerial);
  if (marker) {
    marker.openPopup();
  }
};


const openEditModal = (cam) => {
  editingCam.value = cam;
  editForm.value = {
    locationAddress: cam.locationAddress || '',
    latitude: Number(cam.latitude) || 11.1345,
    longitude: Number(cam.longitude) || 106.5052,
    trapType: cam.trapType || 'Bẫy Pheromone thông minh',
    cropType: cam.cropType || 'Xoài Cát Chu'
  };
  editDialogVisible.value = true;
};

const handleSaveLocation = async () => {
  if (!editingCam.value) return;
  savingLocation.value = true;
  try {
    const res = await api.updateCameraLocation({
      deviceSerial: editingCam.value.deviceSerial,
      latitude: Number(editForm.value.latitude),
      longitude: Number(editForm.value.longitude),
      locationAddress: editForm.value.locationAddress,
      trapType: editForm.value.trapType,
      cropType: editForm.value.cropType
    });

    if (res.data?.success) {
      editingCam.value.latitude = Number(editForm.value.latitude);
      editingCam.value.longitude = Number(editForm.value.longitude);
      editingCam.value.locationAddress = editForm.value.locationAddress;
      editingCam.value.trapType = editForm.value.trapType;
      editingCam.value.cropType = editForm.value.cropType;

      renderMarkers();
      editDialogVisible.value = false;
      ElNotification({
        title: t('common.success'),
        message: 'Đã lưu thông tin vị trí và lô vườn thành công!',
        type: 'success'
      });
    }
  } catch (err) {
    ElNotification({
      title: t('common.error'),
      message: 'Lưu thông tin thất bại: ' + err.message,
      type: 'error'
    });
  } finally {
    savingLocation.value = false;
  }
};

const loadRealtimeOverview = async () => {
  try {
    const res = await api.getAiOverview();
    if (res.data?.success && res.data.overview?.cameraRealtimeList) {
      realtimeData.value = res.data.overview.cameraRealtimeList;
      await nextTick();
      renderMarkers();
    }
  } catch (err) {
    console.error('Failed to load realtime camera data', err);
  }
};

watch(() => cameras.value, () => {
  renderMarkers();
}, { deep: true });

watch(isDark, () => {
  if (streetLayer && typeof streetLayer.setUrl === 'function') {
    streetLayer.setUrl(getStreetTileUrl());
  }
});

onMounted(async () => {
  await loadRealtimeOverview();
  await nextTick();
  initMap();
});

onUnmounted(() => {
  stopPopupPlayer();
  if (map) {
    map.remove();
    map = null;
  }
});
</script>

<style>
.custom-leaflet-marker {
  background: transparent;
  border: none;
}
.popup-spinner {
  width: 22px;
  height: 22px;
  border: 2.5px solid rgba(16, 185, 129, 0.3);
  border-top-color: #10b981;
  border-radius: 50%;
  animation: popup-spin 0.8s linear infinite;
}
.popup-spinner-sm {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(71, 85, 105, 0.3);
  border-top-color: #475569;
  border-radius: 50%;
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
  animation: popup-spin 0.8s linear infinite;
}
@keyframes popup-spin {
  to { transform: rotate(360deg); }
}

/* Custom Leaflet Controls - Premium Dark/Light UI */
.leaflet-container {
  background-color: var(--el-bg-color, #0b0f19) !important;
}

/* Dark Mode Google Maps Styling */
.dark .leaflet-google-street-tiles {
  filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
}

.leaflet-bar {
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.15)) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25) !important;
  border-radius: 12px !important;
  overflow: hidden;
  background: var(--el-card-bg-color, #182030) !important;
}

.leaflet-bar a {
  background-color: var(--el-card-bg-color, #182030) !important;
  color: var(--el-text-color-primary, #e2e8f0) !important;
  border-bottom: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.1)) !important;
  width: 34px !important;
  height: 34px !important;
  line-height: 34px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  transition: all 0.2s ease !important;
}

.leaflet-bar a:last-child {
  border-bottom: none !important;
}

.leaflet-bar a:hover {
  background-color: var(--el-bg-color, #0f172a) !important;
  color: var(--primary-green, #10b981) !important;
}

.custom-leaflet-action-bar a .action-icon {
  width: 17px;
  height: 17px;
  stroke: currentColor;
}

/* Layer Switcher Control */
.leaflet-control-layers {
  background: var(--el-card-bg-color, #182030) !important;
  color: var(--el-text-color-primary, #e2e8f0) !important;
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.15)) !important;
  border-radius: 14px !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25) !important;
  padding: 8px 12px !important;
  font-family: inherit !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  backdrop-filter: blur(8px);
}

.leaflet-control-layers-base label {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  margin-bottom: 6px !important;
  cursor: pointer !important;
  padding: 4px 6px !important;
  border-radius: 8px !important;
  transition: background 0.15s ease !important;
}

.leaflet-control-layers-base label:last-child {
  margin-bottom: 0 !important;
}

.leaflet-control-layers-base label:hover {
  background: rgba(255, 255, 255, 0.08) !important;
}

.leaflet-control-layers-base input[type="radio"] {
  accent-color: #10b981;
  cursor: pointer;
  margin: 0 !important;
}

/* Leaflet Popup - Theme Adapted */
.leaflet-popup-content-wrapper {
  background: var(--el-card-bg-color, #182030) !important;
  color: var(--el-text-color-primary, #f1f5f9) !important;
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.15)) !important;
  border-radius: 18px !important;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45) !important;
  padding: 2px !important;
  backdrop-filter: blur(12px);
}

.leaflet-popup-tip {
  background: var(--el-card-bg-color, #182030) !important;
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.15)) !important;
  box-shadow: none !important;
}

.leaflet-popup-close-button {
  color: var(--el-text-color-secondary, #94a3b8) !important;
  padding: 8px 8px 0 0 !important;
  font-size: 16px !important;
  transition: all 0.2s ease !important;
}

.leaflet-popup-close-button:hover {
  color: var(--primary-green, #10b981) !important;
}

.popup-info-box {
  background: var(--el-bg-color, rgba(15, 23, 42, 0.75));
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.1));
  color: var(--el-text-color-regular, #cbd5e1);
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 11px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.popup-info-box b {
  color: var(--el-text-color-primary, #f1f5f9);
}

/* Attribution Control */
.leaflet-control-attribution {
  background: var(--el-bg-color, rgba(15, 23, 42, 0.8)) !important;
  color: var(--el-text-color-secondary, #94a3b8) !important;
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, 0.1)) !important;
  border-radius: 6px !important;
  font-size: 10px !important;
  padding: 2px 6px !important;
  margin: 6px !important;
  backdrop-filter: blur(6px);
}

.leaflet-control-attribution a {
  color: var(--primary-green, #10b981) !important;
}
</style>
