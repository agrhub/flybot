<template>
  <div>
    <div class="relative w-full rounded-lg overflow-hidden boundary-map">
      <div ref="mapEl" class="w-full h-full z-0"></div>
      <div class="absolute top-2 left-2 z-[400] flex flex-wrap gap-1.5">
        <el-button size="small" :icon="Back" :disabled="!points.length" @click="undo">{{ t('farms.boundary.undo') }}</el-button>
        <el-button size="small" :icon="Delete" :disabled="!points.length" @click="clear">{{ t('farms.boundary.clear') }}</el-button>
        <el-button size="small" @click="toggleLayer">{{ satellite ? t('map.layerStreet') : t('map.layerEarth') }}</el-button>
      </div>
    </div>
    <p class="boundary-hint mt-1.5">
      {{ points.length >= 3 ? t('farms.boundary.done', { count: points.length }) : t('farms.boundary.hint') }}
    </p>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Back, Delete } from '@element-plus/icons-vue';
import { createBaseLayers, FALLBACK_CENTER } from '@/utils/mapTiles';

const props = defineProps({
  // [[lat, lng], ...]
  modelValue: { type: Array, default: () => [] },
  color: { type: String, default: '#3ecf8e' },
  // Traps for orientation: [{ deviceName, latitude, longitude }]
  cameras: { type: Array, default: () => [] },
  // Other plots of the farm, drawn faintly: [{ name, color, boundary }]
  others: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue']);

const { t } = useI18n();
const mapEl = ref(null);
const points = ref([...props.modelValue]);
const satellite = ref(true);
let map = null;
let layers = null;
let shape = null;
let vertices = null;

const draw = () => {
  if (!map) return;
  shape?.remove();
  vertices?.clearLayers();
  if (points.value.length >= 3) {
    shape = L.polygon(points.value, { color: props.color, weight: 2, fillOpacity: 0.25 }).addTo(map);
  } else if (points.value.length === 2) {
    shape = L.polyline(points.value, { color: props.color, weight: 2, dashArray: '4 4' }).addTo(map);
  } else {
    shape = null;
  }
  points.value.forEach((p) => L.circleMarker(p, { radius: 5, color: props.color, fillColor: '#ffffff', fillOpacity: 1, weight: 2 }).addTo(vertices));
};

const commit = () => {
  emit('update:modelValue', points.value.map(([lat, lng]) => [lat, lng]));
  draw();
};
const undo = () => {
  points.value = points.value.slice(0, -1);
  commit();
};
const clear = () => {
  points.value = [];
  commit();
};
const toggleLayer = () => {
  satellite.value = !satellite.value;
  layers.street.remove();
  layers.satellite.remove();
  (satellite.value ? layers.satellite : layers.street).addTo(map);
};

onMounted(async () => {
  await nextTick();
  map = L.map(mapEl.value, { zoomControl: true }).setView(FALLBACK_CENTER, 15);
  layers = createBaseLayers(L);
  layers.satellite.addTo(map);
  vertices = L.layerGroup().addTo(map);

  // Context: other plots and the farm's traps
  const bounds = [];
  for (const other of props.others) {
    if ((other.boundary || []).length >= 3) {
      L.polygon(other.boundary, { color: other.color, weight: 1, fillOpacity: 0.08, dashArray: '3 3' }).bindTooltip(other.name).addTo(map);
      bounds.push(...other.boundary);
    }
  }
  for (const cam of props.cameras) {
    if (Number.isFinite(cam.latitude) && Number.isFinite(cam.longitude)) {
      L.circleMarker([cam.latitude, cam.longitude], { radius: 6, color: '#e6a23c', fillOpacity: 0.9, weight: 2 }).bindTooltip(cam.deviceName).addTo(map);
      bounds.push([cam.latitude, cam.longitude]);
    }
  }
  // Zoom to this plot when it has a boundary, otherwise to the whole farm
  const focus = points.value.length >= 3 ? points.value : [...bounds, ...points.value];
  const fit = () => {
    if (focus.length) map.fitBounds(L.latLngBounds(focus), { padding: [40, 40], maxZoom: 17 });
  };
  fit();

  map.on('click', (e) => {
    if (points.value.length >= 200) return;
    points.value = [...points.value, [Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6]];
    commit();
  });
  draw();
  // Inside a dialog the size is known only after it opens: measure, then zoom again
  setTimeout(() => {
    if (!map) return;
    map.invalidateSize();
    fit();
  }, 300);
});

watch(() => props.color, draw);

onBeforeUnmount(() => {
  map?.remove();
  map = null;
});
</script>

<style scoped>
.boundary-map {
  height: 320px;
  border: 1px solid var(--el-border-color);
}
.boundary-hint {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
