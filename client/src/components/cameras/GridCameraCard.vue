<template>
  <el-card shadow="never" class="grid-cam group select-none" body-class="grid-cam__body">
    <!-- 1. Card Header -->
    <div class="grid-cam__header p-4 flex items-center justify-between gap-3">
      <!-- Left: Camera Icon + Title + SN -->
      <div class="flex items-center gap-3 min-w-0">
        <!-- Lens Icon Container -->
        <div class="grid-cam__thumb relative w-10 h-10 shrink-0 flex items-center justify-center">
          <img
            v-if="cameraThumbnail"
            :src="cameraThumbnail"
            :alt="camera.deviceName"
            class="w-full h-full object-cover"
            @error="thumbError = true"
          />
          <img v-else-if="isCamos" src="/images/camos-logo.png" alt="" class="w-7 h-7 object-contain" data-test="camos-logo" />
          <el-icon v-else :size="20"><VideoCamera /></el-icon>
          <!-- Status Dot -->
          <span
            class="grid-cam__dot"
            :class="camera.status === 1 ? (isPlaying && !hasError ? 'is-live' : 'is-online') : 'is-offline'"
          ></span>
        </div>

        <div class="min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <h4 class="grid-cam__title truncate">
              {{ camera.deviceName || camera.deviceSerial }}
            </h4>
            <!-- Encrypted badge -->
            <el-tooltip v-if="camera.isEncrypt === 1" :content="t('cameras.encrypted')" placement="top">
              <el-tag type="warning" effect="light" round size="small" class="shrink-0">
                <el-icon><Lock /></el-icon>
              </el-tag>
            </el-tooltip>
          </div>

          <!-- Serial Number with Quick Copy -->
          <div class="flex items-center gap-1 mt-0.5 min-w-0">
            <span class="grid-cam__meta font-mono whitespace-nowrap truncate min-w-0" :title="camera.deviceSerial">SN: {{ camera.deviceSerial }}</span>
            <el-tooltip :content="copiedSn ? t('cameras.copied') : t('cameras.copySerial')" placement="top">
              <el-button :aria-label="copiedSn ? t('cameras.copied') : t('cameras.copySerial')"
                link
                size="small"
                :type="copiedSn ? 'success' : 'info'"
                :icon="copiedSn ? Check : DocumentCopy"
                @click.stop="copySerialNumber"
              />
            </el-tooltip>
          </div>
        </div>
      </div>

      <!-- Right: Status Badges -->
      <div class="flex items-center gap-1.5 shrink-0">

        <!-- Live Status Pill -->
        <el-tag
          v-if="isPlaying && !loading && !hasError"
          type="success"
          effect="light"
          round
          size="small"
        >
          <span class="inline-flex items-center gap-1">
            <span class="grid-cam__pulse"></span>
            {{ t('cameras.live') }}
          </span>
        </el-tag>
        <el-tag
          v-else-if="loading"
          type="warning"
          effect="light"
          round
          size="small"
        >
          {{ t('cameras.waitingConnection') }}
        </el-tag>
        <el-tag
          v-else-if="sleeping"
          type="warning"
          effect="light"
          round
          size="small"
          data-test="sleeping-pill"
        >
          {{ nextWakeText }}
        </el-tag>
        <el-tag
          v-else
          :type="camera.status === 1 ? 'success' : 'danger'"
          effect="light"
          round
          size="small"
        >
          {{ camera.status === 1 ? t('common.online') : t('common.offline') }}
        </el-tag>
      </div>
    </div>

    <!-- 2. Video Viewport Area -->
    <div class="px-3 py-2">
      <div class="aspect-video bg-black rounded-lg relative flex items-center justify-center overflow-hidden">
        <!-- Thumbnail Placeholder when not streaming live or on stream error -->
        <img
          v-if="cameraThumbnail && (!isPlaying || hasError)"
          :src="cameraThumbnail"
          :alt="camera.deviceName"
          class="absolute inset-0 w-full h-full object-cover transition-opacity duration-300 z-0 pointer-events-none"
          :class="camera.simulated ? 'opacity-100' : isPlaying && !hasError ? 'opacity-0' : 'opacity-70'"
          @error="thumbError = true"
        />

        <!-- CamOS: live view over KVS WebRTC, Low quality (H.264 320x240) to keep a grid of cameras light -->
        <div v-if="kvsConfig" class="absolute inset-0 z-10">
          <KvsViewer
            :config="kvsConfig"
            quality="low"
            :name="camera.deviceSerial"
            controls
            data-test="grid-kvs"
            @state="onKvsState"
          />
        </div>

        <!-- Player Container -->
        <div
          :id="'ez-grid-' + camera.deviceSerial"
          ref="playerContainerRef"
          class="w-full h-full flex items-center justify-center relative z-10"
        ></div>

        <!-- Floating Top HUD on Stream (Timestamp / Live indicator) -->
        <div
          v-if="isPlaying && !hasError && !loading"
          class="absolute top-2.5 left-2.5 z-10 flex items-center gap-2 pointer-events-none"
        >
          <div class="grid-cam__hud px-2 py-0.5 flex items-center gap-1.5 font-mono">
            <span class="grid-cam__pulse"></span>
            <span>{{ t('cameras.live') }}</span>
          </div>
        </div>

        <!-- Floating Top-Right Controls on Hover -->
        <div
          v-if="isPlaying && !hasError"
          class="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
        >
          <!-- Enter/Update Code Button (if encrypted) -->
          <el-tooltip v-if="camera.isEncrypt === 1 && camera.canManage !== false" :content="t('cameras.changeCode')" placement="bottom">
            <el-button :aria-label="t('cameras.changeCode')"
              circle
              size="small"
              type="warning"
              :icon="Key"
              @click.stop="openCodeModal"
            />
          </el-tooltip>

          <!-- Refresh Stream Button -->
          <el-tooltip :content="t('common.refresh')" placement="bottom">
            <el-button :aria-label="t('common.refresh')"
              circle
              size="small"
              :icon="Refresh"
              class="!ml-0"
              @click.stop="startLiveStream"
            />
          </el-tooltip>

          <!-- Full View Launcher -->
          <el-tooltip :content="t('cameras.viewDetails')" placement="bottom">
            <el-button :aria-label="t('cameras.viewDetails')"
              circle
              size="small"
              type="primary"
              :icon="FullScreen"
              class="!ml-0"
              @click.stop="emit('expand', camera)"
            />
          </el-tooltip>
        </div>

        <!-- Live Loading Spinner -->
        <div v-if="loading" class="grid-cam__scrim absolute inset-0 flex flex-col items-center justify-center gap-2.5 z-20 pointer-events-none">
          <el-icon :size="28" class="is-loading"><Loading /></el-icon>
          <span class="text-xs">{{ t('cameras.connectingStream') }}</span>
        </div>

        <!-- CamOS: the camera sleeps between photos; live view is asked for its next wake -->
        <div v-if="isCamos && !camera.simulated && !loading && !isPlaying && !kvsConfig" class="grid-cam__scrim grid-cam__scrim--strong absolute inset-0 flex flex-col items-center justify-center p-5 text-center z-20" data-test="camos-overlay">
          <el-icon :size="26" class="mb-2"><Moon v-if="sleeping" /><VideoCamera v-else /></el-icon>
          <p class="text-xs font-medium max-w-xs leading-relaxed">{{ liveClosed ? liveClosedText : sleeping ? nextWakeText : (camera.status === 1 ? t('cameras.kvs.liveOnRequest') : t('cameras.deviceOffline')) }}</p>
          <div v-if="!liveClosed" class="flex items-center gap-2 mt-3">
            <el-button v-if="camera.status === 1 && !sleeping" type="primary" size="small" :icon="VideoCamera" @click.stop="emit('expand', camera)">{{ t('cameras.live') }}</el-button>
            <el-button size="small" :icon="Clock" :loading="requestingLive" :disabled="liveRequested" @click.stop="requestLive">
              {{ liveRequested ? t('cameras.liveRequested') : t('cameras.requestLive') }}
            </el-button>
          </div>
        </div>

        <!-- Error / Decryption / Offline Overlay -->
        <div v-else-if="hasError && !loading" class="grid-cam__scrim grid-cam__scrim--strong absolute inset-0 flex flex-col items-center justify-center p-5 text-center z-20">
          <el-icon :size="28" class="grid-cam__warn-icon mb-2"><WarningFilled /></el-icon>
          <p class="text-xs font-medium max-w-xs leading-relaxed">
            {{ errorMessage || t('cameras.streamError') }}
          </p>

          <div class="flex items-center gap-2 mt-3">
            <el-button
              v-if="camera.isEncrypt === 1 && camera.canManage !== false"
              type="warning"
              size="small"
              :icon="Key"
              @click.stop="openCodeModal"
            >
              {{ t('cameras.enterCode') }}
            </el-button>

            <el-button
              v-if="!liveClosed"
              size="small"
              :icon="Refresh"
              class="!ml-0"
              @click.stop="startLiveStream"
            >
              {{ t('common.refresh') }}
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. Card Footer -->
    <div class="grid-cam__footer px-4 py-2.5 flex items-center justify-between gap-2">
      <!-- Device Model / Type Badge -->
      <div class="flex items-center gap-1.5 min-w-0 overflow-hidden">
        <!-- Platform, power and stream tags live here so the header keeps the name and serial readable -->
        <!-- Camera platform (EZVIZ cloud, CamOS on AWS IoT Core) -->
        <!-- (a simulated camera shows only its Simulated tag) -->
        <el-tag v-if="!camera.simulated" :type="isCamos ? 'primary' : 'info'" effect="plain" size="small" class="shrink-0" data-test="platform-badge">
          {{ t(`cameras.platform.${platform}`) }}
        </el-tag>
        <!-- CamOS: uplink with its signal bars, and the battery (power mode in its tooltip), as on a phone -->
        <DeviceSignal v-if="isCamos && camera.device && demoAllows(camera, 'device')" :device="camera.device" :online="camera.status === 1" class="shrink-0" />
        <!-- A simulated demo camera: synthetic photos, not field data -->
        <el-tooltip v-if="camera.simulated" :content="t('simulated.cameraHint')" placement="top">
          <el-tag type="warning" effect="dark" size="small" class="shrink-0" data-test="simulated-badge">{{ t('simulated.tag') }}</el-tag>
        </el-tooltip>
        <!-- Paused by an administrator -->
        <el-tooltip v-if="camera.adminDisabled" :content="camera.adminDisabled.reason || t('cameras.paused.desc')" placement="top">
          <el-tag type="danger" effect="dark" size="small" class="shrink-0" data-test="paused-badge">{{ t('cameras.paused.tag') }}</el-tag>
        </el-tooltip>
        <!-- A read-only demo camera (Settings > System > Demo access) -->
        <el-tooltip v-if="camera.access === 'demo'" :content="t('cameras.demo.hint')" placement="top">
          <el-tag type="success" effect="light" size="small" class="shrink-0" data-test="demo-badge">{{ t('cameras.demo.tag') }}</el-tag>
        </el-tooltip>
        <!-- HD Stream Quality Tag -->
        <el-tag v-if="!isCamos && !camera.simulated" type="info" effect="plain" size="small" class="shrink-0">HD</el-tag>
        <span class="grid-cam__meta font-mono truncate min-w-0" :title="camera.model || camera.deviceType">
          {{ formatModel(camera.model || camera.deviceType) }}
        </span>
        <el-tag v-if="cardOverdue" type="warning" effect="light" round size="small" class="shrink-0">
          {{ t('maintenance.overdue') }}
        </el-tag>
        <el-tooltip v-if="imageIssue" :content="t(`cameras.imageQuality.hints.${imageIssue}`)" placement="top">
          <el-tag type="warning" effect="light" round size="small" class="shrink-0">
            {{ t(`cameras.imageQuality.issues.${imageIssue}`) }}
          </el-tag>
        </el-tooltip>
      </div>

      <!-- Action: View Details Button -->
      <el-button type="primary" link class="shrink-0" @click="emit('expand', camera)">
        {{ t('cameras.viewDetails') }}
        <el-icon class="el-icon--right"><ArrowRight /></el-icon>
      </el-button>
    </div>

    <!-- 4. Quick Verification Code Dialog Modal -->
    <el-dialog
      v-model="codeDialogVisible"
      :title="t('cameras.codeDialogTitle')"
      width="420px"
      append-to-body
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        :title="t('cameras.codeDialogDefault')"
        class="mb-4"
      />

      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="`${camera.deviceName} (${camera.deviceSerial})`">
          <el-input
            v-model="inputCode"
            :placeholder="t('cameras.codeDialogInputPlaceholder')"
            :prefix-icon="Lock"
            size="large"
            clearable
            @keyup.enter="handleSaveCode"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="codeDialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="savingCode" @click="handleSaveCode">
          {{ t('cameras.codeDialogSaveAndPlay') }}
        </el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { loadEzuikit } from '@/utils/lazyLibs';
import api from '@/services/api';
import KvsViewer from './KvsViewer.vue';
import { useI18n } from 'vue-i18n';
import { requestErrorText } from '@/utils/requestError';
import { ElNotification } from 'element-plus';
import {
  VideoCamera,
  Lock,
  Key,
  Check,
  DocumentCopy,
  Refresh,
  FullScreen,
  Loading,
  WarningFilled,
  ArrowRight,
  Moon,
  Clock
} from '@element-plus/icons-vue';
import DeviceSignal from './DeviceSignal.vue';
import { demoAllows } from '@/utils/demoCamera';

const props = defineProps({
  camera: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['expand']);
const { t } = useI18n();

const playerContainerRef = ref(null);
const isPlaying = ref(false);
const loading = ref(false);
const hasError = ref(false);
const errorMessage = ref('');
const copiedSn = ref(false);

// Platform: EZVIZ cloud camera (default) or a CamOS trap camera on AWS IoT Core
const platform = computed(() => props.camera?.platform || 'ezviz');
const isCamos = computed(() => platform.value === 'camos' || platform.value === 'kinesis');
const sleeping = computed(() => !!props.camera?.device?.sleeping);
const nextWakeAt = computed(() => props.camera?.device?.nextWakeAt || props.camera?.device?.wakeAt || null);
const nextWakeText = computed(() => (nextWakeAt.value
  ? t('cameras.sleepingNextWake', { time: new Date(nextWakeAt.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
  : t('cameras.sleeping')));
const liveRequested = ref(!!props.camera?.device?.liveRequested);
const requestingLive = ref(false);
const requestLive = async () => {
  requestingLive.value = true;
  try {
    const res = await api.requestCameraLive(props.camera.deviceSerial, 5);
    liveRequested.value = true;
    ElNotification({ title: t('common.success'), message: res.data?.sent ? t('cameras.liveStarting') : t('cameras.liveRequestedNote'), type: 'success' });
  } catch (err) {
    ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('cameras.streamError')), type: 'error' });
  } finally {
    requestingLive.value = false;
  }
};

const thumbError = ref(false);
const cameraThumbnail = computed(() => {
  if (thumbError.value) return '';
  const url = props.camera?.thumbnailUrl || props.camera?.picUrl;
  return url ? api.getImageUrl(url) : '';
});

// Sticky card past its reminder date
const cardOverdue = computed(() => !!props.camera?.cardDueAt && new Date(props.camera.cardDueAt) <= new Date());
// Most serious problem in the latest photo
const imageIssue = computed(() => props.camera?.imageQuality?.issues?.[0] || null);
const codeDialogVisible = ref(false);
const inputCode = ref('');
const savingCode = ref(false);

let playerInstance = null;

const formatModel = (val) => {
  if (!val) return isCamos.value ? 'CamOS ESP32' : 'EZVIZ Smart';
  if (val.length > 20) {
    return val.substring(0, 18) + '...';
  }
  return val;
};

const copySerialNumber = async () => {
  try {
    await navigator.clipboard.writeText(props.camera.deviceSerial);
    copiedSn.value = true;
    setTimeout(() => {
      copiedSn.value = false;
    }, 2000);
  } catch (e) {
    console.error('Copy failed', e);
  }
};

const openCodeModal = () => {
  inputCode.value = props.camera?.validateCode || '';
  codeDialogVisible.value = true;
};

const handleSaveCode = async () => {
  const code = (inputCode.value || '').trim();
  if (!code) {
    ElNotification({ title: t('common.error'), message: t('cameras.player.codeRequiredInput'), type: 'warning' });
    return;
  }

  savingCode.value = true;
  try {
    const res = await api.updateCameraCode(props.camera.deviceSerial, code);
    if (res.data?.success) {
      ElNotification({ title: t('common.success'), message: t('cameras.player.codeUpdated'), type: 'success' });
      props.camera.validateCode = code;
      codeDialogVisible.value = false;

      // Try updating directly via player or reload stream
      if (playerInstance && typeof playerInstance.changePlayUrl === 'function') {
        try {
          await playerInstance.changePlayUrl({
            type: 'live',
            deviceSerial: props.camera?.deviceSerial,
            channelNo: 1,
            validCode: code,
            hd: true
          });
          hasError.value = false;
          isPlaying.value = true;
          return;
        } catch (e) {
          console.warn('changePlayUrl failed, reloading stream:', e);
        }
      }
      startLiveStream();
    } else {
      ElNotification({ title: t('common.error'), message: res.data?.message || t('cameras.player.codeUpdateFailed'), type: 'error' });
    }
  } catch (err) {
    ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('cameras.streamError')), type: 'error' });
  } finally {
    savingCode.value = false;
  }
};

// CamOS: play right away in the grid when the camera is awake and has cloud live view; a sleeping camera keeps the
// "request live at next wake" overlay
const kvsConfig = ref(null);
const liveSupported = computed(() => props.camera?.device?.liveSupported !== false);
// A read-only demo camera whose live view the administrator has not opened to visitors, or a
// simulated demo camera (no device at all)
const liveClosed = computed(() => props.camera?.liveOpen === false);
const liveClosedText = computed(() => (props.camera?.simulated ? t('simulated.noLive') : t('cameras.demo.liveClosed')));
const onKvsState = (state) => {
  isPlaying.value = state === 'playing';
  if (state === 'error') kvsConfig.value = null;
};
const startCamosLive = async () => {
  if (props.camera.status !== 1 || sleeping.value || !liveSupported.value || liveClosed.value) return;
  loading.value = true;
  try {
    const res = await api.getCameraLive(props.camera.deviceSerial);
    const data = res.data;
    if (data?.platform === 'kinesis' && data.channelARN) kvsConfig.value = data;
  } catch {
    // the overlay offers the detail view and a live request
  } finally {
    loading.value = false;
  }
};

const startLiveStream = async () => {
  // A simulated camera has no live view: its latest photo stays on the card (the Simulated tag says why)
  if (props.camera?.simulated) return;
  if (isCamos.value) return startCamosLive();
  if (liveClosed.value) {
    hasError.value = true;
    errorMessage.value = liveClosedText.value;
    return;
  }
  if (props.camera.status !== 1) {
    hasError.value = true;
    errorMessage.value = t('cameras.deviceOffline');
    return;
  }

  loading.value = true;
  hasError.value = false;
  errorMessage.value = '';

  try {
    // Protocol 1: ezopen (standard EZUIKit multi.html demo), quality 1 (HD)
    const res = await api.getLiveStream(props.camera.deviceSerial, '', 1, 1);
    const data = res.data;

    let playUrl = '';
    let accessToken = '';
    let areaDomain = '';
    let validateCode = (props.camera.validateCode || '').trim();

    if (data.data?.url) {
      playUrl = data.data.url;
      accessToken = data.data.accessToken || '';
      areaDomain = data.data.areaDomain || '';
      if (data.data.validateCode) validateCode = data.data.validateCode;
    } else if (data.url) {
      playUrl = data.url;
    }

    if (!playUrl) {
      throw new Error(data.msg || t('cameras.player.streamUnavailable'));
    }

    await nextTick();
    initPlayer(playUrl, accessToken, areaDomain, validateCode);
  } catch (err) {
    console.error(`[GridCameraCard ${props.camera.deviceSerial}] Startup error:`, err);
    hasError.value = true;
    errorMessage.value = requestErrorText(t, err, t('cameras.streamError'));
    loading.value = false;
  }
};

const initPlayer = async (url, accessToken, areaDomain, code) => {
  stopLiveStream();
  const EZUIKit = await loadEzuikit();
  // The card may have been closed while the player library was loading
  const container = playerContainerRef.value;
  if (!container) return;
  container.innerHTML = '';

  const containerId = 'ez-grid-' + props.camera.deviceSerial;
  const targetDomain = areaDomain || 'https://open.ezvizlife.com';

  try {
    // Standard configuration based on EZUIKit multi.html demo
    const playerOptions = {
      id: containerId,
      url: url,
      accessToken: accessToken || props.camera?.accessToken || '',
      token: accessToken || props.camera?.accessToken || '',
      width: container.clientWidth || 360,
      height: container.clientHeight || 220,
      language: 'en',
      download: false,
      scaleMode: 1,
      streamInfoCBType: 1,
      staticPath: window.location.origin + '/ezuikit_static',
      env: {
        domain: targetDomain
      },
      loggerOptions: {
        level: 'WARN',
        name: 'ez-grid-' + props.camera.deviceSerial,
        showTime: false
      },
      handleError: async (error) => {
        console.warn(`[EZUIKit ${props.camera.deviceSerial}] handleError:`, error);
        loading.value = false;

        // If camera is encrypted (nErrorCode === 5)
        if (error.type === 'handleRunTimeInfoError' && error.data?.nErrorCode === 5) {
          if (code && playerInstance && typeof playerInstance.changePlayUrl === 'function') {
            try {
              await playerInstance.changePlayUrl({
                type: 'live',
                deviceSerial: props.camera?.deviceSerial,
                channelNo: 1,
                validCode: code,
                hd: true
              });
              hasError.value = false;
              isPlaying.value = true;
              return;
            } catch (decErr) {
              console.warn('[EZUIKit] changePlayUrl failed:', decErr);
            }
          }
          hasError.value = true;
          errorMessage.value = t('cameras.encryptedWarning');
        } else if (String(error.retcode ?? error.code) === '5411') {
          hasError.value = true;
          errorMessage.value = t('cameras.player.permissionError');
        } else if (String(error.retcode ?? error.code) === '5556') {
          // EZVIZ cloud could not pull the live stream (sleeping battery/4G cam, or EZVIZ service)
          hasError.value = true;
          errorMessage.value = t('cameras.player.streamServiceError');
        } else {
          hasError.value = true;
          errorMessage.value = error.msg || t('cameras.streamError');
        }
      },
      handleSuccess: () => {
        loading.value = false;
        hasError.value = false;
        isPlaying.value = true;
      }
    };

    playerInstance = new EZUIKit.EZUIKitPlayer(playerOptions);

    if (playerInstance && playerInstance.on) {
      playerInstance.on(EZUIKit.EZUIKitPlayer.EVENTS?.firstFrameDisplay || 'firstFrameDisplay', () => {
        loading.value = false;
        hasError.value = false;
        isPlaying.value = true;
      });
    }

    isPlaying.value = true;
  } catch (err) {
    console.error(`[EZUIKit ${props.camera.deviceSerial}] Player initialization error:`, err);
    hasError.value = true;
    errorMessage.value = requestErrorText(t, err, t('cameras.streamError'));
    loading.value = false;
  }
};

const stopLiveStream = () => {
  kvsConfig.value = null;
  isPlaying.value = false;
  loading.value = false;
  if (playerInstance) {
    try {
      if (typeof playerInstance.stop === 'function') playerInstance.stop();
      if (typeof playerInstance.destroy === 'function') playerInstance.destroy();
    } catch (e) {}
    playerInstance = null;
  }
  if (playerContainerRef.value) {
    playerContainerRef.value.innerHTML = '';
  }
};

onMounted(() => {
  startLiveStream();
});

onUnmounted(() => {
  stopLiveStream();
});

defineExpose({
  startLiveStream,
  stopLiveStream,
  isPlaying
});
</script>

<style scoped>
.grid-cam {
  display: flex;
  flex-direction: column;
  transition: border-color 0.2s;
}
.grid-cam:hover {
  border-color: var(--el-color-primary);
}
.grid-cam :deep(.grid-cam__body) {
  padding: 0;
}
.grid-cam__header {
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.grid-cam__footer {
  border-top: 1px solid var(--el-border-color-lighter);
}
.grid-cam__thumb {
  border-radius: 10px;
  overflow: visible;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
}
.grid-cam__thumb img {
  border-radius: 9px;
}
.grid-cam__dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--el-bg-color);
  z-index: 1;
}
.grid-cam__dot.is-online {
  background: var(--el-color-success);
}
.grid-cam__dot.is-live {
  background: var(--el-color-success);
  animation: grid-cam-pulse 1.6s ease-in-out infinite;
}
.grid-cam__dot.is-offline {
  background: var(--el-color-danger);
}
.grid-cam__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.grid-cam__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.grid-cam__pulse {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-success);
  animation: grid-cam-pulse 1.6s ease-in-out infinite;
}
/* Overlays sit on top of video, so they use a dark scrim with light text in both themes */
.grid-cam__hud {
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
}
.grid-cam__scrim {
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
}
.grid-cam__scrim--strong {
  background: rgba(0, 0, 0, 0.85);
}
.grid-cam__warn-icon {
  color: var(--el-color-warning);
}
@keyframes grid-cam-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
