<template>
  <div class="flex flex-col gap-4" data-test="sentinel-density">
    <el-alert v-if="density?.synthetic" type="warning" :closable="false" show-icon :title="t('sentinel.density.synthetic')" data-test="synthetic-note" />
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert v-if="notFound" type="info" :closable="false" show-icon :title="t('sentinel.density.noData', { date })" data-test="no-density" />
    <el-alert v-else-if="density?.status === 'no_geolocated_traps'" type="info" :closable="false" show-icon :title="t('sentinel.density.noGeo')" />

    <div class="grid grid-cols-1 lg:grid-cols-4 gap-4 sm:gap-6">
      <!-- Same map as the Field Map: Google tiles, FlyBot plots, Sentinel heat and hot zones on top -->
      <el-card shadow="never" class="density-map-card lg:col-span-3" body-class="density-map-card__body">
        <div class="relative w-full h-full">
          <div ref="mapEl" class="w-full h-full z-0" role="region" :aria-label="t('sentinel.density.mapLabel')" data-test="map"></div>
          <div class="absolute bottom-4 left-4 z-[400] flex flex-wrap items-center gap-2">
            <el-button-group>
              <el-button size="small" :type="baseLayer === 'street' ? 'primary' : 'default'" :icon="MapLocation" @click="setBase('street')">{{ t('map.streetShort') }}</el-button>
              <el-button size="small" :type="baseLayer === 'satellite' ? 'primary' : 'default'" :icon="Picture" @click="setBase('satellite')">{{ t('map.satelliteShort') }}</el-button>
            </el-button-group>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="density-side">
        <template #header>
          <div class="section-title">{{ t('sentinel.density.title') }}</div>
          <div class="section-subtitle">{{ density?.generatedAt ? t('sentinel.density.generated', { time: dateTime(density.generatedAt, locale) }) : t('sentinel.density.subtitle') }}</div>
        </template>

        <el-form label-position="top" @submit.prevent>
          <el-form-item :label="t('sentinel.density.date')">
            <el-date-picker
              v-model="date"
              type="date"
              value-format="YYYY-MM-DD"
              format="DD/MM/YYYY"
              :clearable="false"
              :disabled-date="disabledDate"
              class="!w-full"
              data-test="density-date"
            />
          </el-form-item>
        </el-form>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
          <div class="flex items-center gap-2">
            <el-switch v-model="showHeat" size="small" :aria-label="t('sentinel.density.heat')" />
            <span class="text-sm">{{ t('sentinel.density.heat') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <el-switch v-model="showPlots" size="small" :aria-label="t('map.plots')" />
            <span class="text-sm">{{ t('map.plots') }}</span>
          </div>
        </div>

        <div v-if="range" class="mb-3" data-test="legend">
          <div class="meta-text mb-1">{{ t('sentinel.density.legend') }}</div>
          <div class="flex items-center gap-2">
            <span class="meta-text font-mono">{{ round(range[0]) }}</span>
            <span class="legend-bar" :style="{ background: legendGradient }" aria-hidden="true"></span>
            <span class="meta-text font-mono">{{ round(range[1]) }}</span>
          </div>
          <el-tag v-if="density?.hotThreshold !== null && density?.hotThreshold !== undefined" type="danger" effect="light" size="small" round class="mt-2">
            {{ t('sentinel.density.hotZones', { count: zones.length, threshold: round(density.hotThreshold) }) }}
          </el-tag>
        </div>

        <el-table :data="rows" size="small" class="w-full" max-height="340" data-test="trap-table" :empty-text="t('sentinel.density.noTraps')">
          <el-table-column :label="t('sentinel.density.trap')" min-width="120">
            <template #default="{ row }">
              <div class="font-mono truncate">{{ row.id }}</div>
              <div v-if="row.name" class="meta-text truncate">{{ row.name }}</div>
            </template>
          </el-table-column>
          <el-table-column :label="t('sentinel.density.value')" width="80" align="right">
            <template #default="{ row }">
              <span class="count-text">{{ row.value ?? '--' }}</span>
            </template>
          </el-table-column>
        </el-table>
        <p v-if="markers.unplaced.length" class="meta-text mt-2" data-test="unplaced">{{ t('sentinel.density.unplaced', { names: markers.unplaced.map((m) => m.id).join(', ') }) }}</p>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MapLocation, Picture } from '@element-plus/icons-vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import api from '@/services/api';
import { createBaseLayers, FALLBACK_CENTER } from '@/utils/mapTiles';
import { sentinelGet, sentinelErrorKind, items } from '@/composables/useSentinel';
import { gridBounds, heatDataUrl, mergeMarkers, normalizeDensity, rampColor } from '@/utils/sentinel/density';
import { dateTime, todayLocal } from '@/utils/sentinel/time';

/**
 * Fruit-fly pressure from Sentinel's daily job: trap values interpolated over the orchard (heat),
 * hot zones outlined, on the same map setup as FlyBot's Field Map (tiles, plots).
 */
const { t, locale } = useI18n();

const date = ref('');
const dates = ref([]);
const density = shallowRef(null);
const devices = ref([]);
const loading = ref(false);
const error = ref('');
const notFound = ref(false);
const showHeat = ref(true);
const showPlots = ref(true);
const baseLayer = ref('street');
const mapEl = ref(null);
let map = null;
let bases = null;
let overlay = null;
let plotLayer = null;

const markers = computed(() => mergeMarkers(devices.value, density.value ? { traps: density.value.traps } : null));
const range = computed(() => density.value?.valueRange || null);
const zones = computed(() => density.value?.hotZones?.features || []);
const legendGradient = computed(() => `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((x) => `rgb(${rampColor(x).join(',')})`).join(', ')})`);
const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
const rows = computed(() => {
  const byId = new Map();
  for (const x of density.value?.traps || []) byId.set(String(x.id), { id: x.id, name: '', value: round(x.value) });
  for (const m of [...markers.value.placed, ...markers.value.unplaced]) {
    const r = byId.get(String(m.id)) || { id: m.id, value: round(m.value) };
    byId.set(String(m.id), { ...r, name: m.name !== m.id ? m.name : '' });
  }
  return [...byId.values()].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
});
// Only the days the daily job computed can be picked
const disabledDate = (d) => {
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return dates.value.length ? !dates.value.includes(key) : d.getTime() > Date.now();
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function load() {
  loading.value = true;
  error.value = '';
  notFound.value = false;
  try {
    if (!dates.value.length) {
      const list = await sentinelGet('density').catch(() => null);
      dates.value = list?.dates || [];
      if (!date.value) {
        date.value = dates.value[0] || todayLocal();
        return; // the date watcher loads that day
      }
    }
    const [dev, dens] = await Promise.all([
      sentinelGet('devices').catch(() => ({ items: [] })),
      sentinelGet('density', { date: date.value }).catch((err) => {
        if (err?.response?.status === 404) return null;
        throw err;
      }),
    ]);
    devices.value = items(dev);
    density.value = dens ? normalizeDensity(dens) : null;
    notFound.value = !dens;
  } catch (err) {
    error.value = t(`sentinel.errors.${sentinelErrorKind(err)}`);
  } finally {
    loading.value = false;
  }
  await nextTick();
  render();
}

function initMap() {
  if (map || !mapEl.value) return;
  map = L.map(mapEl.value, { zoomControl: false, maxZoom: 20 }).setView(FALLBACK_CENTER, 15);
  bases = createBaseLayers(L);
  bases[baseLayer.value].addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  overlay = L.layerGroup().addTo(map);
  plotLayer = L.layerGroup().addTo(map);
  renderPlots();
}

function setBase(name) {
  if (!map || baseLayer.value === name) return;
  bases[baseLayer.value].remove();
  bases[name].addTo(map);
  baseLayer.value = name;
}

// FlyBot's plots (farms), as on the Field Map
async function renderPlots() {
  if (!plotLayer) return;
  plotLayer.clearLayers();
  if (!showPlots.value) return;
  let plots = [];
  try {
    plots = (await api.getFarmMap()).data.plots || [];
  } catch {
    return;
  }
  for (const plot of plots) {
    L.polygon(plot.boundary, { color: plot.color, weight: 2, fillOpacity: 0.08 })
      .bindTooltip(`<strong>${escapeHtml(plot.name)}</strong> · ${escapeHtml(plot.farmName || '')}`, { sticky: true })
      .addTo(plotLayer);
  }
}

function markerIcon(m, vmin, vmax) {
  const v = m.value;
  const color = v === null || v === undefined || !Number.isFinite(v) ? '#909399' : `rgb(${rampColor((v - vmin) / Math.max(1e-9, vmax - vmin)).join(',')})`;
  const value = v === null || v === undefined ? '–' : round(v);
  // Data colors (the heat scale); everything else from the theme
  return L.divIcon({
    className: 'sentinel-marker',
    html: `<div class="sentinel-marker__pin${m.bench ? ' is-bench' : ''}"><span class="sentinel-marker__dot" style="background:${color}"></span>${escapeHtml(value)}</div>`
      + (m.name && m.name !== String(m.id) ? `<div class="sentinel-marker__label">${escapeHtml(m.name)}</div>` : ''),
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

function render() {
  initMap();
  if (!map) return;
  overlay.clearLayers();
  const d = density.value;
  const bounds = [];
  if (d?.grid) {
    const gb = gridBounds(d.grid);
    const url = showHeat.value ? heatDataUrl({ grid: d.grid, value_range: d.valueRange }, d.traps) : null;
    if (gb && url) L.imageOverlay(url, gb, { opacity: 0.75, interactive: false, alt: t('sentinel.density.heat') }).addTo(overlay);
    if (gb) bounds.push(...gb);
  }
  if (zones.value.length) {
    const danger = getComputedStyle(document.documentElement).getPropertyValue('--el-color-danger').trim() || '#f56c6c';
    L.geoJSON(d.hotZones, {
      style: { color: danger, weight: 2, dashArray: '6 4', fillOpacity: 0 },
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        layer.bindTooltip(escapeHtml(t('sentinel.density.hotZoneTitle', { zone: p.zone, peak: round(p.peak), mean: round(p.mean), area: Math.round(p.area_m2 || 0) })), { sticky: true });
      },
    }).addTo(overlay);
  }
  const [vmin, vmax] = range.value || [0, Math.max(1, ...markers.value.placed.map((m) => m.value || 0))];
  for (const m of markers.value.placed) {
    L.marker([m.lat, m.lon], { icon: markerIcon(m, vmin, vmax), title: `${m.name}: ${m.value ?? '–'}`, keyboard: true, riseOnHover: true }).addTo(overlay);
    bounds.push([m.lat, m.lon]);
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
  setTimeout(() => map && map.invalidateSize(), 60);
}

watch(date, (value, old) => {
  if (value && value !== old) load();
});
watch(showHeat, render);
watch(showPlots, renderPlots);

onMounted(load);
onBeforeUnmount(() => {
  if (map) {
    map.remove();
    map = null;
  }
});
</script>

<style scoped>
.density-map-card {
  height: 620px;
  overflow: hidden;
}
.density-map-card :deep(.density-map-card__body) {
  padding: 0;
  height: 100%;
}
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
.count-text {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.legend-bar {
  flex: 1;
  height: 12px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
}
@media (max-width: 767px) {
  .density-map-card {
    height: 420px;
  }
}
</style>

<style>
/* Leaflet draws the markers outside Vue */
.sentinel-marker {
  background: transparent;
  border: none;
}
.sentinel-marker__pin {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 6px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color);
  box-shadow: var(--el-box-shadow-light);
}
.sentinel-marker__pin.is-bench {
  border-radius: 6px;
  border-color: var(--el-color-primary);
}
.sentinel-marker__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid var(--el-border-color-darker);
}
.sentinel-marker__label {
  position: absolute;
  left: 0;
  top: 16px;
  transform: translateX(-50%);
  padding: 1px 6px;
  font-size: 11px;
  white-space: nowrap;
  border-radius: 4px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color-overlay);
  opacity: 0.9;
}
</style>
