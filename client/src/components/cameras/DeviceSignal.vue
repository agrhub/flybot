<template>
  <!-- A phone's status bar for a CamOS camera: its uplink with signal bars, and its battery -->
  <span class="device-signal inline-flex items-center gap-3" data-test="device-signal">
    <el-tooltip v-if="netLabel" :content="signalText" placement="top">
      <span class="inline-flex items-center gap-1" data-test="device-net">
        <span class="device-signal__net">{{ netLabel }}</span>
        <span class="device-signal__bars" :class="`is-${barsLevel}`" aria-hidden="true">
          <i v-for="n in 4" :key="n" :class="{ on: n <= bars }" />
        </span>
      </span>
    </el-tooltip>
    <el-tooltip v-if="battery?.pct != null" :content="batteryText" placement="top">
      <span class="inline-flex items-center gap-1" data-test="device-battery">
        <span class="device-signal__battery" :class="`is-${batteryLevel}`" aria-hidden="true">
          <i :style="{ width: `${Math.max(0, Math.min(100, battery.pct))}%` }" />
        </span>
        <span class="device-signal__pct">{{ battery.pct }} %</span>
        <el-icon v-if="battery.charging" class="device-signal__charging" data-test="device-charging"><Lightning /></el-icon>
      </span>
    </el-tooltip>
  </span>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Lightning } from '@element-plus/icons-vue';
import { signalBars } from '@/utils/battery';

const props = defineProps({
  // camera.device: { net: 'wifi' | '4g', rssi (dBm), battery: { pct, mv, charging }, power: { mode } }
  device: { type: Object, default: () => ({}) },
});
const { t } = useI18n();

const battery = computed(() => props.device?.battery || null);
const netLabel = computed(() => (props.device?.net === '4g' ? '4G' : props.device?.net === 'wifi' ? 'Wi-Fi' : ''));
const bars = computed(() => signalBars(props.device?.net, props.device?.rssi));
const barsLevel = computed(() => (bars.value <= 1 ? 'low' : 'ok'));
const signalText = computed(() => [netLabel.value, props.device?.rssi != null ? `${t('camosDevice.signal')} ${props.device.rssi} dBm` : null].filter(Boolean).join(' · '));
const batteryLevel = computed(() => (battery.value?.charging ? 'charging' : battery.value?.pct <= 20 ? 'low' : 'ok'));
const batteryText = computed(() => {
  const b = battery.value || {};
  return [
    `${b.pct} %`,
    b.mv != null ? `${(b.mv / 1000).toFixed(2)} V` : null,
    b.charge === 'slow' ? t('cameras.battery.chargingSlow') : b.charging === true ? t('cameras.battery.charging') : b.charging === false ? t('cameras.battery.notCharging') : null,
    props.device?.power?.mode ? t(`cameras.power.${props.device.power.mode}`) : null,
    props.device?.power?.level ? t(`cameras.powerLevel.${props.device.power.level}`) : null,
  ].filter(Boolean).join(' · ');
});
</script>

<style scoped>
.device-signal {
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.device-signal__net {
  font-weight: 600;
}
/* Four bars of rising height, like a phone's signal icon */
.device-signal__bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}
.device-signal__bars i {
  width: 3px;
  border-radius: 1px;
  background: var(--el-border-color);
}
.device-signal__bars i:nth-child(1) { height: 25%; }
.device-signal__bars i:nth-child(2) { height: 50%; }
.device-signal__bars i:nth-child(3) { height: 75%; }
.device-signal__bars i:nth-child(4) { height: 100%; }
.device-signal__bars.is-ok i.on { background: var(--el-text-color-primary); }
.device-signal__bars.is-low i.on { background: var(--el-color-danger); }
/* A battery outline with its charge, and the cap on the right */
.device-signal__battery {
  position: relative;
  display: inline-block;
  width: 20px;
  height: 10px;
  padding: 1px;
  border: 1px solid var(--el-text-color-secondary);
  border-radius: 2px;
  margin-right: 2px;
}
.device-signal__battery::after {
  content: '';
  position: absolute;
  top: 2px;
  right: -3px;
  width: 2px;
  height: 4px;
  border-radius: 0 1px 1px 0;
  background: var(--el-text-color-secondary);
}
.device-signal__battery i {
  display: block;
  height: 100%;
  border-radius: 1px;
  background: var(--el-text-color-primary);
}
.device-signal__battery.is-charging i { background: var(--el-color-success); }
.device-signal__battery.is-low i { background: var(--el-color-danger); }
.device-signal__charging {
  color: var(--el-color-success);
  animation: device-signal-blink 1.2s ease-in-out infinite;
}
@keyframes device-signal-blink {
  50% { opacity: 0.25; }
}
@media (prefers-reduced-motion: reduce) {
  .device-signal__charging { animation: none; }
}
</style>
