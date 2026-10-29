<template>
  <div class="flex flex-col gap-4" data-test="camos-device-tab">
    <!-- Device Information of the camera's web console, as FlyBot last heard it -->
    <el-descriptions v-if="section === 'info'" :column="isMobile ? 1 : 2" border size="small" data-test="device-info">
      <el-descriptions-item :label="t('camosDevice.model')">{{ info.model || dash }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.firmware')">{{ info.fw || dash }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.sensor')">{{ info.sensor || dash }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.mac')">{{ info.mac || dash }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.network')">{{ networkText }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.signal')">{{ info.rssi != null ? `${info.rssi} dBm` : dash }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.battery')">{{ batteryText }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.power')">{{ powerText }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.location')">{{ locationText }}</el-descriptions-item>
      <el-descriptions-item :label="t('camosDevice.lastSeen')">{{ info.lastSeenAt ? new Date(info.lastSeenAt).toLocaleString() : dash }}</el-descriptions-item>
    </el-descriptions>
    <div v-if="section === 'info' && !readOnly" class="flex flex-wrap gap-2">
      <el-button size="small" :icon="Refresh" :loading="busy === 'refresh'" data-test="device-refresh" @click="run('refresh')">{{ t('camosDevice.refresh') }}</el-button>
      <el-button size="small" :icon="Location" :loading="busy === 'locate'" data-test="device-locate" @click="run('locate')">{{ t('camosDevice.locate') }}</el-button>
      <el-button size="small" type="warning" plain :icon="SwitchButton" :loading="busy === 'restart'" data-test="device-restart" @click="restart">{{ t('camosDevice.restart') }}</el-button>
    </div>

    <!-- Battery over time: consumption and charging -->
    <template v-if="section === 'info'">
      <el-divider class="!my-1" />
      <CamosPowerCard :camera="camera" />
    </template>

    <!-- Network of the camera's web console: Wi-Fi or the 4G APN, stored now and used from the next boot -->
    <template v-if="section === 'network'">
      <el-alert type="info" :closable="false" show-icon :title="t('camosDevice.networkHint')" />
      <el-form label-position="top" size="small" @submit.prevent>
        <el-form-item :label="t('camosDevice.wifiSsid')">
          <el-input v-model="wifi.ssid" maxlength="32" autocomplete="off" data-test="device-ssid" />
        </el-form-item>
        <el-form-item :label="t('camosDevice.wifiPassword')">
          <el-input v-model="wifi.password" type="password" show-password maxlength="63" autocomplete="new-password" data-test="device-password" />
        </el-form-item>
        <el-button size="small" type="primary" :disabled="!wifi.ssid" :loading="busy === 'wifi'" data-test="device-wifi" @click="run('wifi', { ssid: wifi.ssid, password: wifi.password })">{{ t('camosDevice.sendWifi') }}</el-button>
        <el-form-item :label="t('camosDevice.apn')" class="mt-4">
          <el-input v-model="apn" maxlength="63" :placeholder="t('camosDevice.apnPlaceholder')" data-test="device-apn" />
        </el-form-item>
        <el-button size="small" type="primary" :disabled="!apn" :loading="busy === 'apn'" data-test="device-apn-send" @click="run('apn', { apn })">{{ t('camosDevice.sendApn') }}</el-button>
      </el-form>
    </template>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessageBox, ElNotification } from 'element-plus';
import { Location, Refresh, SwitchButton } from '@element-plus/icons-vue';
import api from '@/services/api';
import { requestErrorText } from '@/utils/requestError';
import { locationText as formatLocation } from '@/utils/location';
import { useBreakpoints } from '@/composables/useBreakpoints';
import CamosPowerCard from './CamosPowerCard.vue';

/**
 * The parts of the camera's web console that are not settings: Device Information with refresh, GPS fix and restart and
 * the battery history, and the Network page (Wi-Fi or 4G APN). Each action is one RPC through FlyBot (POST .../device-action).
 */
const props = defineProps({
  camera: { type: Object, required: true },
  info: { type: Object, default: () => ({}) },
  // 'info' or 'network'
  section: { type: String, default: 'info' },
  // A visitor's demo camera: the information without the actions
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(['done']);
const { t } = useI18n();
const { isMobile } = useBreakpoints();
const dash = '—';
const busy = ref('');
const wifi = reactive({ ssid: '', password: '' });
const apn = ref('');

const networkText = computed(() => {
  const net = props.info.net === '4g' ? '4G' : props.info.net === 'wifi' ? 'Wi-Fi' : '';
  return [net, props.info.operator].filter(Boolean).join(' · ') || dash;
});
const batteryText = computed(() => {
  const b = props.info.battery;
  if (!b) return dash;
  const parts = [b.pct != null ? `${b.pct} %` : null, b.mv != null ? `${(b.mv / 1000).toFixed(2)} V` : null, b.charge === 'slow' ? t('camosDevice.chargingSlow') : b.charging === true ? t('camosDevice.charging') : b.charging === false ? t('camosDevice.notCharging') : null];
  return parts.filter(Boolean).join(' · ') || dash;
});
const powerText = computed(() => [props.info.power ? t(`cameras.power.${props.info.power}`) : null, props.info.powerLevel ? t(`cameras.powerLevel.${props.info.powerLevel}`) : null].filter(Boolean).join(' · ') || dash);
const locationText = computed(() => formatLocation(props.info.location, t) || dash);

async function run(action, extra = {}) {
  busy.value = action;
  try {
    const res = await api.cameraDeviceAction(props.camera.deviceSerial, { action, ...extra });
    // A GPS fix for a camera that is away waits for its next connection
    const queued = action === 'locate' && res.data?.queued;
    ElNotification({ title: t('common.success'), message: queued ? t('camosDevice.locateQueued') : t(`camosDevice.done.${action}`), type: 'success' });
    if (action === 'wifi') wifi.password = '';
    emit('done', action);
  } catch (err) {
    ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('camosDevice.failed')), type: 'error' });
  } finally {
    busy.value = '';
  }
}

async function restart() {
  try {
    await ElMessageBox.confirm(t('camosDevice.restartConfirm'), t('camosDevice.restart'), { type: 'warning', confirmButtonText: t('camosDevice.restart'), cancelButtonText: t('common.cancel') });
  } catch {
    return;
  }
  run('restart');
}
</script>
