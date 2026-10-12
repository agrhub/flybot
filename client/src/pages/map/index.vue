<template>
  <div class="w-full max-w-7xl mx-auto pb-12 select-none">
    <PageHeader :title="t('dashboard.mapViewTitle')" :subtitle="t('dashboard.mapViewSubtitle')">
      <template #actions>
        <div class="flex items-center gap-2 mr-2">
          <el-switch v-model="showHeatmap" size="small" />
          <span class="text-sm">{{ t('map.heatmap') }}</span>
        </div>
        <div class="flex items-center gap-2 mr-2">
          <el-switch v-model="showPlots" size="small" />
          <span class="text-sm">{{ t('map.plots') }}</span>
        </div>
        <!-- Outbreak legend -->
        <el-tag type="success" effect="light" round size="small">{{ t('map.safe') }}</el-tag>
        <el-tag type="warning" effect="light" round size="small">{{ t('map.moderate') }}</el-tag>
        <el-tag type="danger" effect="light" round size="small">{{ t('map.alert') }}</el-tag>
      </template>
    </PageHeader>

    <!-- Main map & side trap roster layout -->
    <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <!-- Interactive Leaflet map -->
      <el-card shadow="never" class="map-card lg:col-span-3">
        <div class="relative w-full h-full">
          <div ref="mapContainerRef" class="w-full h-full z-0"></div>

          <!-- Layer switcher & drag hint overlay (bottom-left) -->
          <div class="absolute bottom-4 left-4 z-[400] flex items-center gap-3">
            <el-button-group>
              <el-button
                size="small"
                :type="activeLayerType === 'street' ? 'primary' : 'default'"
                :icon="MapLocation"
                :title="t('map.layerStreet')"
                @click="activeLayerType !== 'street' && toggleBaseLayer()"
              >
                {{ t('map.streetShort') }}
              </el-button>
              <el-button
                size="small"
                :type="activeLayerType === 'earth' ? 'primary' : 'default'"
                :icon="Picture"
                :title="t('map.layerEarth')"
                @click="activeLayerType !== 'earth' && toggleBaseLayer()"
              >
                {{ t('map.satelliteShort') }}
              </el-button>
            </el-button-group>

            <div class="map-hint hidden sm:flex items-center gap-2 pointer-events-none">
              <el-icon><Rank /></el-icon>
              <span>{{ t('map.dragHint') }}</span>
            </div>
          </div>
        </div>
      </el-card>

      <!-- Trap roster & quick editor -->
      <el-card shadow="never" class="roster-card">
        <template #header>
          <div class="roster-card__title">{{ t('map.trapList') }}</div>
          <div class="roster-card__meta">{{ t('map.monitoringDevices', { count: enrichedCameras.length }) }}</div>
        </template>

        <!-- Search by name, serial or address -->
        <div class="mb-3">
          <el-input
            v-model="searchQuery"
            :placeholder="t('map.searchPlaceholder')"
            :prefix-icon="Search"
            clearable
            @keydown.enter="handleSearchEnter"
            @clear="clearSearch"
          />
          <div v-if="searchQuery" class="flex items-center justify-between mt-1 px-1 roster-card__meta">
            <span>{{ t('map.searchResults', { count: filteredCameras.length }) }}</span>
            <el-button link type="primary" size="small" :icon="Aim" @click="handleSearchEnter">
              {{ t('map.focusMatching') }}
            </el-button>
          </div>
        </div>

        <!-- Scrollable trap list -->
        <div class="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
          <el-empty
            v-if="filteredCameras.length === 0"
            :description="t('map.noTrapsFound')"
            :image-size="80"
          >
            <el-button v-if="searchQuery" link type="primary" @click="clearSearch">
              {{ t('map.clearSearch') }}
            </el-button>
          </el-empty>

          <div
            v-for="cam in filteredCameras"
            :key="cam.deviceSerial"
            @click="focusCamera(cam)"
            class="trap-item"
            :class="{ 'is-active': selectedCam?.deviceSerial === cam.deviceSerial }"
          >
            <div class="flex items-start gap-3">
              <!-- Thumbnail -->
              <div class="trap-item__thumb">
                <img
                  v-if="cam.thumbnailUrl || cam.picUrl"
                  :src="api.getImageUrl(cam.thumbnailUrl || cam.picUrl)"
                  :alt="cam.deviceName"
                  class="w-full h-full object-cover"
                  @error="(e) => e.target.style.display = 'none'"
                />
                <el-icon v-else :size="18"><VideoCamera /></el-icon>
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-1">
                  <div class="trap-item__name truncate">{{ cam.deviceName || cam.deviceSerial }}</div>
                  <!-- Insect density tag -->
                  <el-tag :type="getDensityTagType(cam.riskLevel)" effect="light" round size="small" class="shrink-0">
                    {{ cam.riskValue }} {{ t('map.fruitFlyShort') }}
                  </el-tag>
                </div>
                <div class="flex items-center gap-1 mt-0.5 min-w-0">
                  <span class="trap-item__mono truncate">{{ cam.deviceSerial }}</span>
                  <el-tag v-if="!cam.status" type="info" effect="light" round size="small" class="shrink-0">
                    {{ t('common.offline') }}
                  </el-tag>
                </div>
              </div>
            </div>

            <!-- Address snippet -->
            <div class="trap-item__meta mt-2 flex items-center gap-1 min-w-0">
              <el-icon class="shrink-0"><Location /></el-icon>
              <span class="truncate">{{ cam.locationAddress || t('map.noAddress') }}</span>
            </div>

            <!-- Coordinates & edit -->
            <div class="mt-1 flex items-center justify-between">
              <span v-if="cam.hasLocation" class="trap-item__mono">
                {{ Number(cam.latitude).toFixed(4) }}, {{ Number(cam.longitude).toFixed(4) }}
              </span>
              <el-tag v-else type="warning" effect="light" round size="small">{{ t('map.noLocation') }}</el-tag>
              <el-button v-if="cam.canManage !== false" link type="primary" size="small" :icon="Edit" @click.stop="openEditModal(cam)">
                {{ cam.hasLocation ? t('map.edit') : t('map.setLocation') }}
              </el-button>
            </div>
          </div>
        </div>
      </el-card>
    </div>

    <!-- Edit trap location & orchard details dialog -->
    <el-dialog
      v-model="editDialogVisible"
      :title="t('map.editModalTitle')"
      width="480px"
      append-to-body
    >
      <el-form v-if="editingCam" label-position="top" @submit.prevent>
        <el-alert
          type="info"
          :title="t('map.editModalHint')"
          :closable="false"
          show-icon
          class="mb-4"
        />

        <el-form-item :label="t('map.trapNameAndSerial')">
          <span class="font-semibold">{{ editingCam.deviceName }} ({{ editingCam.deviceSerial }})</span>
        </el-form-item>

        <el-form-item :label="t('map.orchardAddress')">
          <el-input
            v-model="editForm.locationAddress"
            :placeholder="t('map.orchardAddressPlaceholder')"
            clearable
          />
        </el-form-item>

        <div class="grid grid-cols-2 gap-3">
          <el-form-item :label="t('map.latitude')">
            <el-input-number
              v-model="editForm.latitude"
              :step="0.0001"
              :controls="false"
              placeholder="11.1345"
              class="!w-full"
            />
          </el-form-item>
          <el-form-item :label="t('map.longitude')">
            <el-input-number
              v-model="editForm.longitude"
              :step="0.0001"
              :controls="false"
              placeholder="106.5052"
              class="!w-full"
            />
          </el-form-item>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <el-form-item :label="t('map.trapType')">
            <el-input v-model="editForm.trapType" :placeholder="t('map.trapTypePlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('map.cropType')">
            <el-input v-model="editForm.cropType" :placeholder="t('map.cropTypePlaceholder')" />
          </el-form-item>
        </div>
      </el-form>

      <template #footer>
        <el-button @click="editDialogVisible = false">
          {{ t('common.cancel') }}
        </el-button>
        <el-button type="primary" :loading="savingLocation" @click="handleSaveLocation">
          {{ t('common.save') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { requestErrorText } from '@/utils/requestError';
import { useTheme } from '@/utils/theme';
import { useCameras } from '@/composables/useCameras';
import api from '@/services/api';
import { ElNotification } from 'element-plus';
import { Search, MapLocation, Picture, Rank, Aim, VideoCamera, Location, Edit } from '@element-plus/icons-vue';
import PageHeader from '@/components/common/PageHeader.vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { loadEzuikit } from '@/utils/lazyLibs';

const { t } = useI18n();
const { isDark } = useTheme();
const { cameras } = useCameras();

const mapContainerRef = ref(null);
let map = null;
let streetLayer = null;
let earthLayer = null;
const markersMap = new Map();
let clusterGroup = null;
let heatLayer = null;
const showHeatmap = ref(false);
// Plot boundaries (farms)
const showPlots = ref(true);
let plotLayer = null;
const RISK_COLOR = { high: '#f56c6c', moderate: '#e6a23c', low: '#3ecf8e' };
const renderPlots = async () => {
  if (!map) return;
  if (!plotLayer) plotLayer = L.layerGroup().addTo(map);
  plotLayer.clearLayers();
  if (!showPlots.value) return;
  let plots = [];
  try {
    plots = (await api.getFarmMap()).data.plots || [];
  } catch (e) {
    return;
  }
  for (const plot of plots) {
    const stats = plot.stats || {};
    L.polygon(plot.boundary, { color: plot.color, weight: 2, fillOpacity: 0.12 })
      .bindTooltip(
        `<strong>${escapeHtml(plot.name)}</strong> · ${escapeHtml(plot.farmName || '')}<br>` +
        `${escapeHtml(t('farms.stats.traps'))}: ${escapeHtml(stats.cameras ?? 0)} · ${escapeHtml(t('farms.stats.average'))}: ` +
        `<span style="color: ${RISK_COLOR[stats.risk] || RISK_COLOR.low}">${escapeHtml(stats.latestAverage ?? 0)}</span>`,
        { sticky: true }
      )
      .addTo(plotLayer);
  }
};

// Country-level view when no trap has a GPS position yet (never a made-up orchard)
const FALLBACK_CENTER = [16.0, 106.0];
const FALLBACK_ZOOM = 6;

const hasLocation = (cam) => [cam.latitude, cam.longitude].every(v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)));

// Popups are raw HTML strings: escape every value that comes from user or device data
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const selectedCam = ref(null);
const realtimeData = ref([]);
const editDialogVisible = ref(false);
const editingCam = ref(null);
const savingLocation = ref(false);

// Same defaults as the Camera model on the server
const DEFAULT_TRAP_TYPE = 'Yellow Sticky Trap';
const DEFAULT_CROP_TYPE = 'Mango Orchard';

const editForm = ref({
  locationAddress: '',
  latitude: null,
  longitude: null,
  trapType: DEFAULT_TRAP_TYPE,
  cropType: DEFAULT_CROP_TYPE
});

// Merge cameras with overview realtime counts
const enrichedCameras = computed(() => {
  return cameras.value.map(cam => {
    const live = realtimeData.value.find(r => r.deviceSerial === cam.deviceSerial);
    return {
      ...cam,
      latitude: cam.latitude ?? live?.latitude ?? null,
      longitude: cam.longitude ?? live?.longitude ?? null,
      locationAddress: cam.locationAddress || live?.locationAddress || '',
      currentCount: live?.currentCount ?? 0,
      riskValue: live?.riskValue ?? live?.currentCount ?? 0,
      riskBasis: live?.riskBasis || 'latest',
      today: live?.today ?? null,
      ftd7: live?.ftd7 ?? null,
      trapKind: live?.trapKind || cam.trapKind || 'sticky',
      // Computed by the API against each camera's own alert threshold
      riskLevel: live?.riskLevel || 'low',
      alertThreshold: live?.alertThreshold,
      trapType: cam.trapType || live?.trapType || DEFAULT_TRAP_TYPE,
      cropType: cam.cropType || live?.cropType || DEFAULT_CROP_TYPE
    };
  }).map(cam => ({ ...cam, hasLocation: hasLocation(cam) }));
});

const locatedCameras = computed(() => enrichedCameras.value.filter(c => c.hasLocation));

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
    const latLngs = filteredCameras.value.filter(c => c.hasLocation).map(c => [Number(c.latitude), Number(c.longitude)]);
    if (map && latLngs.length > 0) {
      map.fitBounds(L.latLngBounds(latLngs), { padding: [60, 60], maxZoom: 16 });
    }
  }
};

const resetMapView = () => {
  if (!map) return;
  const latLngs = locatedCameras.value.map(c => [Number(c.latitude), Number(c.longitude)]);
  if (latLngs.length > 0) {
    map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 16 });
  } else {
    map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
  }
};

const locateUserOrchard = () => {
  if (!navigator.geolocation) {
    ElNotification({ title: t('common.error'), message: t('map.geolocationUnsupported'), type: 'warning' });
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
        }).addTo(map).bindPopup(t('map.locateMeTitle')).openPopup();
      }
    },
    (err) => {
      ElNotification({ title: t('map.gpsTitle'), message: t('map.gpsFailed', { error: err.message }), type: 'warning' });
    }
  );
};

const clearSearch = () => {
  searchQuery.value = '';
  resetMapView();
};

const getDensityTagType = (riskLevel) => {
  if (riskLevel === 'high') return 'danger';
  if (riskLevel === 'moderate') return 'warning';
  return 'success';
};

const getPinColor = (riskLevel) => {
  if (riskLevel === 'high') return '#ef4444'; // Red
  if (riskLevel === 'moderate') return '#f59e0b'; // Amber
  return '#10b981'; // Emerald
};

const createCustomIcon = (cam) => {
  const color = getPinColor(cam.riskLevel);
  const isHigh = cam.riskLevel === 'high';
  // Risk color is data visualization, so it stays an explicit color
  const pulseHtml = isHigh ? `<div class="map-marker__pulse" style="background-color: ${color}"></div>` : '';

  const html = `
    <div class="map-marker" style="transform: translate(-50%, -100%);">
      ${pulseHtml}
      <div class="map-marker__pin" style="background-color: ${color}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 2a6 6 0 00-6 6c0 4.418 6 10 6 10s6-5.582 6-10a6 6 0 00-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z"/>
        </svg>
      </div>
      <div class="map-marker__tip" style="background-color: ${color}"></div>
      <div class="map-marker__label">
        ${escapeHtml(cam.deviceName || cam.deviceSerial)} <span style="color: ${color}">(${escapeHtml(cam.riskValue)})</span>
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

  map = L.map(mapContainerRef.value, {
    zoomControl: false,
    // markercluster needs a max zoom before any tile layer is added
    maxZoom: 20
  }).setView(FALLBACK_CENTER, FALLBACK_ZOOM);

  // Nearby traps merge into a numbered cluster until zoomed in
  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 17,
    maxClusterRadius: 50
  });
  map.addLayer(clusterGroup);

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
      locateBtn.title = t('map.locateMeTitle');
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
      fullViewBtn.title = t('map.viewWholeOrchardTitle');
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
      btn.innerHTML = `▶ ${t('dashboard.watchStream')}`;
      btn.dataset.state = 'idle';
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
      title: t('cameras.deviceOffline'),
      message: t('cameras.deviceOfflineMsg'),
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
    btn.innerHTML = `<span class="popup-spinner-sm"></span> ${t('cameras.connectingStream')}`;
    btn.dataset.state = 'loading';
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
      throw new Error(data.msg || t('map.streamUnavailable'));
    }

    if (loading) loading.style.display = 'none';
    if (thumb) thumb.style.display = 'none';
    if (playerEl) {
      playerEl.style.display = 'block';
      playerEl.innerHTML = '';
    }

    activePopupSerial = serial;
    const EZUIKit = await loadEzuikit();

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
      btn.innerHTML = `⏹ ${t('cameras.stopStream')}`;
      btn.dataset.state = 'playing';
    }
  } catch (err) {
    console.error('Failed to start popup stream:', err);
    stopPopupPlayer();
    ElNotification({
      title: t('common.error'),
      message: requestErrorText(t, err, t('cameras.streamError')),
      type: 'error'
    });
  }
};

const renderMarkers = () => {
  if (!map) return;

  // Clear existing markers & any running popup player
  stopPopupPlayer();
  clusterGroup?.clearLayers();
  markersMap.clear();
  renderHeatmap();

  // Traps without GPS are listed in the roster (with "set location"), not placed on the map
  const cams = locatedCameras.value;
  if (cams.length === 0) {
    map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
    return;
  }

  const latLngs = [];

  cams.forEach(cam => {
    const lat = Number(cam.latitude);
    const lng = Number(cam.longitude);
    latLngs.push([lat, lng]);

    const marker = L.marker([lat, lng], {
      icon: createCustomIcon(cam),
      // Only people who manage the camera can move it
      draggable: cam.canManage !== false
    });
    clusterGroup.addLayer(marker);

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
          message: t('map.coordsUpdated', { name: cam.deviceName, lat: position.lat.toFixed(4), lng: position.lng.toFixed(4) }),
          type: 'success'
        });
      } catch (err) {
        ElNotification({
          title: t('common.error'),
          message: t('map.coordsSaveFailed', { error: requestErrorText(t, err, err.message) }),
          type: 'error'
        });
      }
    });

    // Thumbnail & In-place Video Player Container
    const thumbUrl = (cam.thumbnailUrl || cam.picUrl) ? api.getImageUrl(cam.thumbnailUrl || cam.picUrl) : '';
    const thumbImgHtml = thumbUrl
      ? `<img id="popup-thumb-${escapeHtml(cam.deviceSerial)}" class="map-popup__thumb" src="${escapeHtml(thumbUrl)}" style="display: block;" onerror="this.style.display='none'" />`
      : `<div id="popup-thumb-${escapeHtml(cam.deviceSerial)}" class="map-popup__placeholder" style="display: flex;">📷</div>`;

    // Popup is a raw HTML string rendered by Leaflet; styled via the .map-popup classes below.
    // Inline display values are kept because the stream logic toggles them directly.
    const popupContent = `
      <div class="map-popup">
        <!-- Video / thumbnail area (in-place player) -->
        <div id="popup-media-box-${escapeHtml(cam.deviceSerial)}" class="map-popup__media">
          ${thumbImgHtml}
          <div id="popup-player-${escapeHtml(cam.deviceSerial)}" class="map-popup__layer" style="display: none;"></div>
          <div id="popup-play-overlay-${escapeHtml(cam.deviceSerial)}" class="map-popup__layer map-popup__overlay" style="display: flex;">
            <div class="map-popup__play">▶</div>
          </div>
          <div id="popup-loading-${escapeHtml(cam.deviceSerial)}" class="map-popup__layer map-popup__loading" style="display: none;">
            <div class="popup-spinner"></div>
            <span>${t('cameras.connectingStream')}</span>
          </div>
        </div>

        <!-- Header info -->
        <div class="map-popup__header">
          <div class="map-popup__title">${escapeHtml(cam.deviceName || cam.deviceSerial)}</div>
          <span class="map-popup__status ${cam.status ? 'is-online' : 'is-offline'}">
            ${cam.status ? (t('common.online')) : (t('common.offline'))}
          </span>
        </div>

        <div class="map-popup__serial">SN: ${escapeHtml(cam.deviceSerial)}</div>

        <!-- Density & orchard info -->
        <div class="popup-info-box">
          <div><b>${cam.riskBasis === 'dailyAverage' ? t('dashboard.averageToday') : t('dashboard.onTrapNow')}:</b> <span style="color: ${getPinColor(cam.riskLevel)}; font-weight: 600;">${cam.riskValue} / ${cam.alertThreshold ?? '--'} ${t('dashboard.insectsShort')}</span></div>
          <div><b>${t('map.popupToday')}:</b> ${cam.today ?? '--'} · <b>${t('map.popupFtd')}:</b> ${cam.ftd7 ?? '--'}</div>
          <div><b>${t('map.cropType')}:</b> ${escapeHtml(cam.cropType)}</div>
          <div class="map-popup__ellipsis"><b>${t('map.orchardAddress')}:</b> ${escapeHtml(cam.locationAddress || t('map.noAddress'))}</div>
        </div>

        <!-- In-place live view button -->
        <button id="view-stream-${escapeHtml(cam.deviceSerial)}" class="map-popup__btn" data-state="idle">
          ▶ ${t('dashboard.watchStream')}
        </button>
      </div>
    `;

    marker.bindPopup(popupContent);

    marker.on('popupopen', () => {
      selectedCam.value = cam;

      // Click button to toggle stream
      const btn = document.getElementById(`view-stream-${escapeHtml(cam.deviceSerial)}`);
      if (btn) {
        btn.onclick = () => {
          playPopupStream(cam);
        };
      }

      // Click thumbnail box directly to start stream
      const mediaBox = document.getElementById(`popup-media-box-${escapeHtml(cam.deviceSerial)}`);
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
  // No GPS yet: open the location editor instead of jumping to a made-up place
  if (!cam.hasLocation) {
    if (cam.canManage !== false) openEditModal(cam);
    return;
  }
  if (!map) return;
  const marker = markersMap.get(cam.deviceSerial);
  if (marker && clusterGroup) {
    // Expands the cluster containing this marker, then opens its popup
    clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
  } else {
    map.flyTo([Number(cam.latitude), Number(cam.longitude)], 16, { duration: 1.2 });
  }
};

// Heatmap: where flies arrive fastest (flies per trap per day over 7 days, relative to the
// busiest trap); traps without that history fall back to their count against their threshold
const renderHeatmap = () => {
  if (!map) return;
  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }
  if (!showHeatmap.value || typeof L.heatLayer !== 'function') return;
  const points = locatedCameras.value
    .filter(c => (c.ftd7 ?? c.currentCount) > 0);
  const maxFtd = Math.max(0, ...points.map(c => c.ftd7 || 0));
  const heat = points.map(c => [
    Number(c.latitude),
    Number(c.longitude),
    maxFtd > 0 && c.ftd7 !== null ? Math.max(0.15, c.ftd7 / maxFtd) : Math.min(1, c.currentCount / (c.alertThreshold || 15))
  ]);
  heatLayer = L.heatLayer(heat, { radius: 40, blur: 30, maxZoom: 17, minOpacity: 0.35 }).addTo(map);
};

watch(showHeatmap, renderHeatmap);
watch(showPlots, renderPlots);


const openEditModal = (cam) => {
  editingCam.value = cam;
  editForm.value = {
    locationAddress: cam.locationAddress || '',
    latitude: cam.hasLocation ? Number(cam.latitude) : Number((map?.getCenter().lat ?? FALLBACK_CENTER[0]).toFixed(6)),
    longitude: cam.hasLocation ? Number(cam.longitude) : Number((map?.getCenter().lng ?? FALLBACK_CENTER[1]).toFixed(6)),
    trapType: cam.trapType || DEFAULT_TRAP_TYPE,
    cropType: cam.cropType || DEFAULT_CROP_TYPE
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
        message: t('map.locationSaved'),
        type: 'success'
      });
    }
  } catch (err) {
    ElNotification({
      title: t('common.error'),
      message: t('map.locationSaveFailed', { error: requestErrorText(t, err, err.message) }),
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
  window.L = L;
  await Promise.all([import('leaflet.markercluster'), import('leaflet.heat')]);
  await loadRealtimeOverview();
  await nextTick();
  initMap();
  renderPlots();
});

onUnmounted(() => {
  stopPopupPlayer();
  if (map) {
    map.remove();
    map = null;
  }
});
</script>

<style scoped>
.map-card {
  height: 620px;
  overflow: hidden;
}
.map-card :deep(.el-card__body) {
  height: 100%;
  padding: 0;
}

.map-hint {
  font-size: 12px;
  padding: 6px 12px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-regular);
  border: 1px solid var(--el-border-color-light);
  box-shadow: var(--el-box-shadow-light);
}

.roster-card {
  height: 620px;
  display: flex;
  flex-direction: column;
}
.roster-card :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.roster-card__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.roster-card__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.trap-item {
  padding: 12px;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color);
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s;
}
.trap-item:hover {
  border-color: var(--el-border-color-darker);
}
.trap-item.is-active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.trap-item__thumb {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
}
.trap-item__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.trap-item__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.trap-item__mono {
  font-size: 12px;
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
  color: var(--el-text-color-secondary);
}
</style>

<style>
/* Global styles for HTML that Leaflet renders outside Vue (markers, popups, controls) */
.custom-leaflet-marker {
  background: transparent;
  border: none;
}

/* Marker */
.map-marker {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.map-marker__pulse {
  position: absolute;
  inset: -8px;
  border-radius: 9999px;
  opacity: 0.4;
  animation: map-marker-ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
}
.map-marker__pin {
  display: flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 9999px;
  color: var(--el-color-white);
  border: 1px solid rgba(255, 255, 255, 0.4);
  box-shadow: var(--el-box-shadow-light);
}
.map-marker__tip {
  width: 10px;
  height: 10px;
  margin-top: -4px;
  transform: rotate(45deg);
}
.map-marker__label {
  margin-top: 4px;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  border-radius: 6px;
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-primary);
  border: 1px solid var(--el-border-color-light);
  box-shadow: var(--el-box-shadow-light);
}
@keyframes map-marker-ping {
  75%, 100% {
    transform: scale(2);
    opacity: 0;
  }
}

/* Popup content */
.map-popup {
  width: 270px;
  padding: 4px;
  font-family: inherit;
}
.map-popup__media {
  position: relative;
  width: 100%;
  height: 155px;
  margin-bottom: 8px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-black); /* video letterbox */
  cursor: pointer;
}
.map-popup__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.map-popup__placeholder {
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  background: var(--el-fill-color-dark);
}
.map-popup__layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.map-popup__overlay {
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
}
.map-popup__play {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 2px;
  font-size: 16px;
  color: var(--el-color-white);
  background: var(--el-color-primary);
}
.map-popup__loading {
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--el-color-white);
  background: rgba(0, 0, 0, 0.7);
}
.map-popup__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}
.map-popup__title {
  max-width: 180px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.map-popup__status {
  flex-shrink: 0;
  font-size: 12px;
  padding: 0 8px;
  line-height: 20px;
  border-radius: 9999px;
  border: 1px solid transparent;
}
.map-popup__status.is-online {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
  border-color: var(--el-color-success-light-8);
}
.map-popup__status.is-offline {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger-light-8);
}
.map-popup__serial {
  margin-bottom: 6px;
  font-size: 12px;
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
  color: var(--el-text-color-secondary);
}
.map-popup__ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.map-popup__btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid transparent;
  border-radius: var(--el-border-radius-base);
  cursor: pointer;
  transition: background-color 0.2s, color 0.2s;
}
.map-popup__btn[data-state="idle"] {
  color: var(--el-color-white);
  background: var(--el-color-primary);
}
.map-popup__btn[data-state="idle"]:hover {
  background: var(--el-color-primary-light-3);
}
.map-popup__btn[data-state="loading"] {
  color: var(--el-text-color-regular);
  background: var(--el-fill-color);
  border-color: var(--el-border-color);
}
.map-popup__btn[data-state="playing"] {
  color: var(--el-color-white);
  background: var(--el-color-danger);
}
.map-popup__btn[data-state="playing"]:hover {
  background: var(--el-color-danger-light-3);
}

.popup-spinner {
  width: 22px;
  height: 22px;
  border: 2.5px solid var(--el-color-primary-light-7);
  border-top-color: var(--el-color-primary);
  border-radius: 50%;
  animation: popup-spin 0.8s linear infinite;
}
.popup-spinner-sm {
  width: 12px;
  height: 12px;
  border: 2px solid var(--el-border-color);
  border-top-color: var(--el-text-color-regular);
  border-radius: 50%;
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
  animation: popup-spin 0.8s linear infinite;
}
@keyframes popup-spin {
  to { transform: rotate(360deg); }
}

.popup-info-box {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 8px;
  padding: 8px 10px;
  font-size: 12px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-regular);
}
.popup-info-box b {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* Leaflet chrome, themed */
.leaflet-container {
  background-color: var(--el-bg-color) !important;
}

/* Dark mode street tiles */
.dark .leaflet-google-street-tiles {
  filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
}

.leaflet-bar {
  border: 1px solid var(--el-border-color) !important;
  box-shadow: var(--el-box-shadow-light) !important;
  border-radius: var(--el-border-radius-base) !important;
  overflow: hidden;
  background: var(--el-bg-color-overlay) !important;
}
.leaflet-bar a {
  background-color: var(--el-bg-color-overlay) !important;
  color: var(--el-text-color-regular) !important;
  border-bottom: 1px solid var(--el-border-color-lighter) !important;
  width: 34px !important;
  height: 34px !important;
  line-height: 34px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  transition: background-color 0.2s, color 0.2s !important;
}
.leaflet-bar a:last-child {
  border-bottom: none !important;
}
.leaflet-bar a:hover {
  background-color: var(--el-fill-color-light) !important;
  color: var(--el-color-primary) !important;
}
.custom-leaflet-action-bar a .action-icon {
  width: 17px;
  height: 17px;
  stroke: currentColor;
}

/* Popup shell */
.leaflet-popup-content-wrapper {
  background: var(--el-bg-color-overlay) !important;
  color: var(--el-text-color-primary) !important;
  border: 1px solid var(--el-border-color-light) !important;
  border-radius: 12px !important;
  box-shadow: var(--el-box-shadow) !important;
  padding: 2px !important;
}
.leaflet-popup-tip {
  background: var(--el-bg-color-overlay) !important;
  border: 1px solid var(--el-border-color-light) !important;
  box-shadow: none !important;
}
.leaflet-popup-close-button {
  color: var(--el-text-color-secondary) !important;
  padding: 8px 8px 0 0 !important;
  font-size: 16px !important;
}
.leaflet-popup-close-button:hover {
  color: var(--el-color-primary) !important;
}

/* Attribution */
.leaflet-control-attribution {
  background: var(--el-bg-color-overlay) !important;
  color: var(--el-text-color-secondary) !important;
  border-radius: 4px !important;
  font-size: 11px !important;
  padding: 2px 6px !important;
  margin: 6px !important;
}
.leaflet-control-attribution a {
  color: var(--el-color-primary) !important;
}
</style>
