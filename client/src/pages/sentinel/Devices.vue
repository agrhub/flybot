<template>
  <div class="flex flex-col gap-4" data-test="sentinel-devices">
    <el-alert type="info" :closable="false" show-icon :title="t('sentinel.devices.intro')" />
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <div v-loading="loading && !devices.length" :element-loading-text="t('common.loading')" class="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6 min-h-[120px]">
      <el-empty v-if="!loading && !error && !devices.length" :description="t('sentinel.devices.none')" :image-size="80" class="xl:col-span-2" />
      <DeviceCard v-for="d in devices" :key="d.serial" :device="d" :local-history="history[d.serial] || {}" />
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import DeviceCard from '@/components/sentinel/DeviceCard.vue';
import { sentinelGet, sentinelErrorKind, items } from '@/composables/useSentinel';
import { latestTelemetry } from '@/utils/sentinel/devices';

const { t } = useI18n();
const devices = ref([]);
const loading = ref(false);
const error = ref('');
// Values polled while the page is open: only drawn when the API sends no history of its own
const history = reactive({});

function remember(list) {
  const at = new Date().toISOString();
  for (const d of list) {
    const tel = latestTelemetry(d);
    const h = (history[d.serial] ||= { battery: [], rssi: [] });
    if (tel.battery !== null) h.battery = [...h.battery, { at, v: Number(tel.battery) }].slice(-60);
    if (tel.rssi !== null) h.rssi = [...h.rssi, { at, v: Number(tel.rssi) }].slice(-60);
  }
}

async function load() {
  loading.value = true;
  try {
    const list = items(await sentinelGet('devices'));
    devices.value = list;
    remember(list);
    error.value = '';
  } catch (err) {
    error.value = t(`sentinel.errors.${sentinelErrorKind(err)}`);
  } finally {
    loading.value = false;
  }
}

let timer = null;
onMounted(() => {
  load();
  timer = setInterval(load, 30000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
