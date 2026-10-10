<template>
  <div class="group relative flex flex-col bg-gradient-to-b from-slate-900/90 via-slate-950/95 to-black/95 rounded-[28px] border border-white/10 hover:border-emerald-500/50 shadow-xl shadow-black/60 hover:shadow-2xl hover:shadow-emerald-500/10 transition-all duration-300 overflow-hidden select-none">
    <!-- Top Ambient Accent Line -->
    <div class="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-500/40 group-hover:via-emerald-400 to-transparent transition-all duration-500"></div>

    <!-- 1. Card Header -->
    <div class="p-4 flex items-center justify-between border-b border-white/5 bg-white/[0.02]">
      <!-- Left: Camera Icon + Title + SN -->
      <div class="flex items-center gap-3 min-w-0">
        <!-- Lens Icon Container -->
        <div class="relative w-10 h-10 rounded-2xl bg-slate-800/80 border border-white/10 flex items-center justify-center shrink-0 group-hover:border-emerald-500/40 group-hover:bg-emerald-500/10 transition-all overflow-hidden">
          <img
            v-if="cameraThumbnail"
            :src="cameraThumbnail"
            alt="Thumbnail"
            class="w-full h-full object-cover"
            @error="thumbError = true"
          />
          <svg v-else class="w-5 h-5 text-slate-300 group-hover:text-emerald-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <!-- Live Glow Dot -->
          <span
            class="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-slate-900 z-10"
            :class="camera.status === 1 ? (isPlaying && !hasError ? 'bg-emerald-400 animate-pulse ring-2 ring-emerald-500/30' : 'bg-emerald-500') : 'bg-red-500'"
          ></span>
        </div>

        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <h4 class="font-bold text-sm text-white tracking-tight truncate group-hover:text-emerald-300 transition-colors">
              {{ camera.deviceName || 'Camera' }}
            </h4>
            <!-- Encrypted badge -->
            <span
              v-if="camera.isEncrypt === 1"
              class="text-[10px] text-amber-400 px-1.5 py-0.2 rounded bg-amber-400/10 border border-amber-400/20 shrink-0 flex items-center gap-0.5"
              :title="t('cameras.encrypted')"
            >
              <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </span>
          </div>

          <!-- Serial Number with Quick Copy -->
          <div class="flex items-center gap-1 mt-0.5">
            <span class="text-[10px] font-mono text-slate-400 tracking-wider">SN: {{ camera.deviceSerial }}</span>
            <button
              @click.stop="copySerialNumber"
              class="p-0.5 text-slate-500 hover:text-emerald-400 transition-colors cursor-pointer"
              :title="copiedSn ? 'Copied!' : 'Copy Serial Number'"
            >
              <svg v-if="copiedSn" class="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Right: Status Badges -->
      <div class="flex items-center gap-1.5 shrink-0">
        <!-- HD Stream Quality Tag -->
        <span class="text-[9px] font-black px-2 py-0.5 rounded-lg bg-white/5 text-slate-300 border border-white/10 tracking-wider">
          HD
        </span>

        <!-- Live Status Pill -->
        <span
          v-if="isPlaying && !loading && !hasError"
          class="text-[10px] font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5 shadow-sm shadow-emerald-500/20"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
          LIVE
        </span>
        <span
          v-else-if="loading"
          class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-spin"></span>
          CONNECTING
        </span>
        <span
          v-else
          class="text-[10px] font-bold px-2 py-0.5 rounded-full border"
          :class="camera.status === 1 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'"
        >
          {{ camera.status === 1 ? t('common.online') : t('common.offline') }}
        </span>
      </div>
    </div>

    <!-- 2. Video Viewport Area -->
    <div class="px-3 py-2">
      <div class="aspect-video bg-black rounded-2xl relative flex items-center justify-center overflow-hidden border border-white/5 shadow-inner">
        <!-- Thumbnail Placeholder when not streaming live or on stream error -->
        <img
          v-if="cameraThumbnail && (!isPlaying || hasError)"
          :src="cameraThumbnail"
          alt="Camera preview"
          class="absolute inset-0 w-full h-full object-cover transition-opacity duration-300 z-0 pointer-events-none"
          :class="isPlaying && !hasError ? 'opacity-0' : 'opacity-70'"
          @error="thumbError = true"
        />

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
          <div class="px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-md border border-white/10 flex items-center gap-1.5 text-[10px] text-emerald-300 font-mono font-medium">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>1080P • 25fps</span>
          </div>
        </div>

        <!-- Floating Top-Right Controls on Hover -->
        <div
          v-if="isPlaying && !hasError"
          class="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200"
        >
          <!-- Enter/Update Code Button (if encrypted) -->
          <button
            v-if="camera.isEncrypt === 1"
            @click.stop="openCodeModal"
            class="w-7 h-7 rounded-lg bg-black/70 hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 border border-amber-500/30 flex items-center justify-center backdrop-blur-md shadow cursor-pointer transition-all active:scale-95"
            :title="t('cameras.changeCode')"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </button>

          <!-- Refresh Stream Button -->
          <button
            @click.stop="startLiveStream"
            class="w-7 h-7 rounded-lg bg-black/70 hover:bg-white/20 text-slate-300 hover:text-white border border-white/15 flex items-center justify-center backdrop-blur-md shadow cursor-pointer transition-all active:scale-95"
            :title="t('common.refresh')"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          <!-- Full View Launcher -->
          <button
            @click.stop="emit('expand', camera)"
            class="w-7 h-7 rounded-lg bg-[var(--primary-green)] text-slate-950 flex items-center justify-center shadow shadow-emerald-500/30 cursor-pointer hover:bg-emerald-300 transition-all active:scale-95"
            :title="t('cameras.viewDetails')"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>

        <!-- Live Loading Spinner -->
        <div v-if="loading" class="absolute inset-0 bg-black/80 flex flex-col items-center justify-center text-xs text-emerald-400 font-bold gap-2.5 z-20 pointer-events-none">
          <div class="w-8 h-8 border-3 border-emerald-500/20 border-t-emerald-400 rounded-full animate-spin"></div>
          <span class="tracking-wide">{{ t('cameras.connectingStream') }}</span>
        </div>

        <!-- Error / Decryption / Offline Overlay -->
        <div v-if="hasError && !loading" class="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center p-5 text-center z-20">
          <div class="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-2.5">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p class="text-xs text-slate-300 font-semibold max-w-xs leading-relaxed">
            {{ errorMessage || t('cameras.streamError') }}
          </p>

          <div class="flex items-center gap-2 mt-3">
            <button
              v-if="camera.isEncrypt === 1"
              @click.stop="openCodeModal"
              class="px-3.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-sm active:scale-95"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <span>{{ t('cameras.enterCode') }}</span>
            </button>

            <button
              @click.stop="startLiveStream"
              class="px-3.5 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-sm active:scale-95"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{{ t('common.refresh') }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. Card Footer -->
    <div class="px-4 py-3 bg-white/[0.02] border-t border-white/5 flex items-center justify-between text-xs">
      <!-- Device Model / Type Badge -->
      <div class="flex items-center gap-2 truncate max-w-[190px]">
        <span class="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0"></span>
        <span class="text-[11px] font-mono text-slate-400 truncate" :title="camera.model || camera.deviceType">
          {{ formatModel(camera.model || camera.deviceType) }}
        </span>
      </div>

      <!-- Action: View Details Button -->
      <button
        @click="emit('expand', camera)"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-xs font-bold transition-all cursor-pointer active:scale-95 group/btn"
      >
        <span>{{ t('cameras.viewDetails') }}</span>
        <svg class="w-3.5 h-3.5 group-hover/btn:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>

    <!-- 4. Quick Verification Code Dialog Modal -->
    <el-dialog
      v-model="codeDialogVisible"
      :title="t('live.codeDialogTitle')"
      width="420px"
      append-to-body
      class="rounded-3xl"
    >
      <div class="space-y-4">
        <div class="bg-blue-500/10 border border-blue-500/20 p-3.5 rounded-2xl text-xs text-blue-300 leading-relaxed flex items-start gap-2.5">
          <svg class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>{{ t('live.codeDialogDefault') }}</p>
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-400 mb-1.5">
            {{ camera.deviceName }} ({{ camera.deviceSerial }})
          </label>
          <el-input
            v-model="inputCode"
            placeholder="VD: Gravity01, RDKHAL..."
            size="large"
            clearable
            @keyup.enter="handleSaveCode"
          />
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2 pt-2">
          <el-button @click="codeDialogVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" :loading="savingCode" @click="handleSaveCode">
            {{ t('live.codeDialogSaveAndPlay') }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import EZUIKit from 'ezuikit-js';
import api from '@/services/api';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';

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

const thumbError = ref(false);
const cameraThumbnail = computed(() => {
  if (thumbError.value) return '';
  const url = props.camera?.thumbnailUrl || props.camera?.picUrl;
  return url ? api.getImageUrl(url) : '';
});

const codeDialogVisible = ref(false);
const inputCode = ref('');
const savingCode = ref(false);

let playerInstance = null;

const formatModel = (val) => {
  if (!val) return 'EZVIZ Smart';
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
    ElNotification({ title: t('common.error'), message: 'Please enter verification code!', type: 'warning' });
    return;
  }

  savingCode.value = true;
  try {
    const res = await api.updateCameraCode(props.camera.deviceSerial, code);
    if (res.data?.success) {
      ElNotification({ title: t('common.success'), message: 'Verification code updated!', type: 'success' });
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
      ElNotification({ title: t('common.error'), message: res.data?.message || 'Failed to save verification code.', type: 'error' });
    }
  } catch (err) {
    ElNotification({ title: t('common.error'), message: err.message, type: 'error' });
  } finally {
    savingCode.value = false;
  }
};

const startLiveStream = async () => {
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
      throw new Error(data.msg || 'Unable to retrieve video stream.');
    }

    await nextTick();
    initPlayer(playUrl, accessToken, areaDomain, validateCode);
  } catch (err) {
    console.error(`[GridCameraCard ${props.camera.deviceSerial}] Startup error:`, err);
    hasError.value = true;
    errorMessage.value = err.message || t('cameras.streamError');
    loading.value = false;
  }
};

const initPlayer = (url, accessToken, areaDomain, code) => {
  stopLiveStream();
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
              console.log(`[EZUIKit ${props.camera.deviceSerial}] Decrypting stream with validCode:`, code);
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
        } else if (error.retcode === 5411 || error.code === 5411) {
          hasError.value = true;
          errorMessage.value = 'No permission to view device (Error 5411). Please check verification code.';
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

    console.log(`[Grid EZUIKit ${props.camera.deviceSerial}] Creating EZUIKitPlayer with:`, playerOptions);
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
    errorMessage.value = err.message || t('cameras.streamError');
    loading.value = false;
  }
};

const stopLiveStream = () => {
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
