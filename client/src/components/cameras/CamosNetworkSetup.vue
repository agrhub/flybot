<template>
  <div class="setup">
    <el-result v-if="online" icon="success" :title="t('cameras.camosSetup.onlineTitle')" :sub-title="t('cameras.camosSetup.onlineHint')" />

    <template v-else-if="!qrDataUrl">
      <el-alert type="info" :closable="false" show-icon :title="t('cameras.camosSetup.intro')" class="mb-4" />
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('cameras.camosSetup.network')">
          <el-radio-group v-model="network">
            <el-radio-button value="wifi">Wi-Fi</el-radio-button>
            <el-radio-button value="cellular">4G</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="network === 'wifi'">
          <el-form-item :label="t('cameras.camosSetup.ssid')">
            <el-input v-model="ssid" :prefix-icon="Connection" clearable />
          </el-form-item>
          <el-form-item :label="t('cameras.camosSetup.password')">
            <el-input v-model="password" :prefix-icon="Lock" show-password clearable autocomplete="off" />
          </el-form-item>
        </template>
        <el-alert v-else type="info" :closable="false" show-icon :title="t('cameras.camosSetup.cellularHint')" />
      </el-form>
    </template>

    <div v-else class="setup__qr">
      <img :src="qrDataUrl" :alt="t('cameras.camosSetup.qrAlt')" class="setup__qr-image" />
      <ol class="setup__steps">
        <li>{{ t('cameras.camosSetup.step1') }}</li>
        <li>{{ t('cameras.camosSetup.step2') }}</li>
        <li>{{ t('cameras.camosSetup.step3') }}</li>
      </ol>
    </div>

    <div v-if="!online && (qrDataUrl || network === 'cellular')" class="setup__waiting">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>{{ expired ? t('cameras.camosSetup.expired') : t('cameras.camosSetup.waiting') }}</span>
    </div>

    <div class="setup__actions">
      <el-button v-if="!online" @click="emit('done')">{{ t('cameras.camosSetup.later') }}</el-button>
      <el-button v-if="!online && !qrDataUrl && network === 'wifi'" type="primary" :disabled="!ssid.trim()" @click="showQr">
        {{ t('cameras.camosSetup.showQr') }}
      </el-button>
      <el-button v-if="!online && qrDataUrl" @click="qrDataUrl = ''">{{ t('cameras.camosSetup.back') }}</el-button>
      <el-button v-if="online" type="primary" @click="emit('done')">{{ t('common.done') }}</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Connection, Lock, Loading } from '@element-plus/icons-vue';
import api from '@/services/api';
import { networkQrText } from '@/utils/camosQr';

/**
 * Second step of adding an AI camera: put it on the network. On Wi-Fi the camera scans a QR code
 * made here; on 4G it connects by itself. Either way, wait until it comes online.
 */
const props = defineProps({
  deviceSerial: { type: String, required: true },
  // { token, expiresAt, mqttHost } from adding the camera
  provision: { type: Object, required: true }
});
const emit = defineEmits(['done', 'online']);
const { t } = useI18n();

const network = ref('wifi');
const ssid = ref('');
const password = ref('');
const qrDataUrl = ref('');
const online = ref(false);
const now = ref(Date.now());
const expired = computed(() => props.provision.expiresAt && now.value > props.provision.expiresAt);

const showQr = async () => {
  const QRCode = await import('qrcode');
  qrDataUrl.value = await QRCode.toDataURL(networkQrText({
    ssid: ssid.value.trim(),
    password: password.value,
    token: props.provision.token,
    mqttHost: props.provision.mqttHost
  }), { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  // Not kept once it is in the QR code
  password.value = '';
};

// The camera is online once CamOS has told FlyBot (webhook); look every few seconds
let timer = null;
const check = async () => {
  now.value = Date.now();
  try {
    const res = await api.getCameras();
    const camera = (res.data?.cameras || []).find(c => c.deviceSerial === props.deviceSerial);
    if (camera?.status === 1) {
      online.value = true;
      clearInterval(timer);
      emit('online');
    }
  } catch {
    // Try again on the next tick
  }
};
onMounted(() => { timer = setInterval(check, 5000); });
onBeforeUnmount(() => clearInterval(timer));
watch(online, (value) => { if (value) qrDataUrl.value = ''; });
</script>

<style scoped>
.setup__qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.setup__qr-image {
  width: min(320px, 100%);
  /* The camera reads it best on white, in dark mode too */
  background: #fff;
  border-radius: 8px;
}
.setup__steps {
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.6;
  list-style: decimal;
}
.setup__waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.setup__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
