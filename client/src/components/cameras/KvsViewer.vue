<template>
  <div ref="rootRef" class="kvs-viewer w-full h-full relative flex items-center justify-center">
    <video ref="videoRef" autoplay playsinline muted class="w-full h-full object-contain" :class="{ hidden: state !== 'playing' || mode === 'jpeg' }"></video>
    <!-- JPEG mode: the camera's own JPEG pictures over the "camos" data channel -->
    <img v-if="mode === 'jpeg'" v-show="state === 'playing' && jpegUrl" :src="jpegUrl" alt="" class="w-full h-full object-contain" data-test="kvs-jpeg" />
    <div v-if="state !== 'playing'" class="kvs-viewer__scrim absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
      <el-icon v-if="state === 'connecting' || state === 'waiting'" :size="26" class="is-loading"><Loading /></el-icon>
      <el-icon v-else :size="26"><WarningFilled /></el-icon>
      <span class="text-xs font-medium" data-test="kvs-state">{{ stateText }}</span>
      <el-button v-if="controls && (state === 'stopped' || state === 'error')" type="primary" size="small" :icon="VideoPlay" class="mt-1" data-test="kvs-play-center" @click.stop="connect">
        {{ t('cameras.kvs.controls.play') }}
      </el-button>
    </div>

    <!-- Player controls (like the EZVIZ player): play / stop, what plays, quality, screenshot, full screen -->
    <div v-if="controls" class="kvs-viewer__bar absolute inset-x-0 bottom-0 flex items-center gap-1 px-2 py-1.5" data-test="kvs-controls" @click.stop>
      <el-tooltip :content="isStopped ? t('cameras.kvs.controls.play') : t('cameras.kvs.controls.stop')" placement="top">
        <el-button link :icon="isStopped ? VideoPlay : VideoPause" class="kvs-viewer__btn" data-test="kvs-toggle"
          :aria-label="isStopped ? t('cameras.kvs.controls.play') : t('cameras.kvs.controls.stop')"
          @click="isStopped ? connect() : stopByUser()" />
      </el-tooltip>
      <span v-if="state === 'playing' && infoText" class="kvs-viewer__info truncate" data-test="kvs-info">{{ infoText }}</span>
      <span class="flex-1"></span>
      <el-dropdown v-if="showQuality" trigger="click" placement="top-end" @command="onQuality">
        <el-button link class="kvs-viewer__btn kvs-viewer__quality" data-test="kvs-quality">
          {{ choiceShort(quality) }}
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="q in menuChoices" :key="q" :command="q" :class="{ 'is-active': q === quality }">
              {{ choiceLabel(q) }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-tooltip :content="t('cameras.kvs.controls.screenshot')" placement="top">
        <el-button link :icon="Camera" class="kvs-viewer__btn" :disabled="state !== 'playing'" :aria-label="t('cameras.kvs.controls.screenshot')" data-test="kvs-screenshot" @click="screenshot" />
      </el-tooltip>
      <el-tooltip :content="fullscreen ? t('cameras.kvs.controls.exitFullscreen') : t('cameras.kvs.controls.fullscreen')" placement="top">
        <el-button link :icon="FullScreen" class="kvs-viewer__btn" :aria-label="fullscreen ? t('cameras.kvs.controls.exitFullscreen') : t('cameras.kvs.controls.fullscreen')" data-test="kvs-fullscreen" @click="toggleFullscreen" />
      </el-tooltip>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Loading, WarningFilled, VideoPlay, VideoPause, Camera, FullScreen } from '@element-plus/icons-vue';
import { CAMOS_CHANNEL, CHANNEL_OPTIONS, JpegAssembler, RateMeter, ackMessage, parseControl, presetFor, qualityChoices, qualityMessage, sizeOf } from '@/utils/camosLive';

/**
 * Live view of a CamOS camera over Kinesis Video Streams WebRTC: the browser joins the camera's
 * signaling channel as VIEWER with the config from GET /api/cameras/:serial/live (channel ARN,
 * signaling endpoints, ICE servers, 15-minute credentials). The camera is the MASTER; it only
 * encodes while a viewer is connected.
 *
 * The viewer also opens the "camos" data channel (utils/camosLive.js): a camera that answers it can send JPEG
 * pictures over it instead of H.264 on the video track (quality medium / high / auto); a camera on older
 * firmware leaves the channel closed and keeps sending H.264.
 */
const props = defineProps({
  // The viewer config (platform "kinesis")
  config: { type: Object, required: true },
  // auto | low | medium | high (utils/camosLive.js QUALITY_PRESETS)
  quality: { type: String, default: 'auto' },
  // Player control bar; the quality menu in it only where the parent handles update:quality
  controls: { type: Boolean, default: false },
  showQuality: { type: Boolean, default: false },
  // File name prefix of a screenshot (the camera serial)
  name: { type: String, default: 'camera' },
});
// info: { mode: 'h264' | 'jpeg', width, height, fps } about once a second while playing
const emit = defineEmits(['state', 'info', 'update:quality']);
const { t } = useI18n();

const videoRef = ref(null);
const rootRef = ref(null);
// connecting | waiting (no master yet) | playing | stopped (by the viewer) | error
const state = ref('connecting');
const error = ref('');
const stateText = computed(() => (state.value === 'error' ? error.value || t('cameras.kvs.failed') : t(`cameras.kvs.${state.value}`)));

let signaling = null;
let pc = null;
let waitTimer = null;
let channel = null;
let channelOpen = false;
let assembler = null;
let infoTimer = null;
const rate = new RateMeter(3000);
const mode = ref('h264');
const jpegUrl = ref('');
const jpegSize = { width: 0, height: 0 };

let askTimer = null;
let wanted = null; // the preset asked for and not confirmed yet

// The camera's answer to the channel ("hello") or a quality change ("mode"): which picture to show
function onControl(m) {
  if (m.t === 'hello' || m.t === 'mode') {
    mode.value = m.mode === 'jpeg' ? 'jpeg' : 'h264';
    jpegSize.width = m.w || 0;
    jpegSize.height = m.h || 0;
    if (m.t === 'hello') {
      cameraSizes.value = Array.isArray(m.sizes) ? m.sizes : null;
      askQuality();
    }
    else if (wanted && m.mode === wanted.mode && m.w === wanted.w) wanted = null; // confirmed
  } else if (m.t === 'error' && wanted) {
    wanted = null; // the camera keeps what runs (it could not start the asked size)
  }
}

// Ask for the preset of the chosen quality, again every 2 s (up to 3 times) until the camera confirms it
function askQuality() {
  clearTimeout(askTimer);
  wanted = presetFor(props.quality, channelOpen, cameraSizes.value);
  let tries = 0;
  const send = () => {
    if (!wanted || channel?.readyState !== 'open' || tries++ >= 3) return;
    try { channel.send(qualityMessage(wanted)); } catch { return; }
    askTimer = setTimeout(send, 2000);
  };
  send();
}

function showJpeg(frame) {
  const url = URL.createObjectURL(new Blob([frame.bytes], { type: 'image/jpeg' }));
  const old = jpegUrl.value;
  jpegUrl.value = url;
  if (old) URL.revokeObjectURL(old);
  rate.tick(performance.now());
  if (state.value !== 'playing') {
    clearTimeout(waitTimer);
    setState('playing');
  }
}

function openChannel() {
  assembler = new JpegAssembler();
  channel = pc.createDataChannel(CAMOS_CHANNEL, CHANNEL_OPTIONS);
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => { channelOpen = true; };
  channel.onclose = () => {
    channelOpen = false;
    mode.value = 'h264';
  };
  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const m = parseControl(event.data);
      if (m) onControl(m);
      return;
    }
    const frame = assembler.push(event.data);
    if (!frame) return;
    try { channel.send(ackMessage(frame.seq)); } catch { /* closing */ }
    if (mode.value === 'jpeg') showJpeg(frame);
  };
}

async function videoFps() {
  try {
    const report = await pc?.getStats();
    let fps = 0;
    report?.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video' && s.framesPerSecond) fps = s.framesPerSecond;
    });
    return Math.round(fps * 10) / 10;
  } catch {
    return 0;
  }
}

const lastInfo = ref(null);
const infoText = computed(() => (lastInfo.value?.width
  ? t('cameras.kvs.liveInfo', { mode: lastInfo.value.mode === 'jpeg' ? 'JPEG' : 'H.264', width: lastInfo.value.width, height: lastInfo.value.height, fps: lastInfo.value.fps })
  : ''));

function startInfo() {
  clearInterval(infoTimer);
  infoTimer = setInterval(async () => {
    if (state.value !== 'playing') return;
    let info;
    if (mode.value === 'jpeg') {
      info = { mode: 'jpeg', width: jpegSize.width, height: jpegSize.height, fps: rate.fps(performance.now()) };
    } else {
      const v = videoRef.value;
      info = { mode: 'h264', width: v?.videoWidth || 0, height: v?.videoHeight || 0, fps: await videoFps() };
    }
    lastInfo.value = info;
    emit('info', info);
  }, 1000);
}

// ---------- controls ----------
const isStopped = computed(() => state.value === 'stopped' || state.value === 'error');
// The JPEG sizes this camera streams (its hello), for the quality menu
const cameraSizes = ref(null);
const menuChoices = computed(() => qualityChoices(cameraSizes.value));
const choiceLabel = (q) => {
  const size = sizeOf(q);
  if (q === 'auto' || q === 'low') return t(`cameras.kvs.qualityOptions.${q}`);
  return size ? t('cameras.kvs.qualityOptions.jpegSize', { w: size[0], h: size[1] }) : q;
};
const choiceShort = (q) => {
  const size = sizeOf(q);
  if (q === 'auto' || q === 'low') return t(`cameras.kvs.qualityShort.${q}`);
  return size ? `${size[0]}×${size[1]}` : q;
};
const onQuality = (q) => emit('update:quality', q);

function stopByUser() {
  stop();
  lastInfo.value = null;
  setState('stopped');
}

// The picture on screen as a JPEG file (the video frame, or the last JPEG picture)
function screenshot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const save = (href) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = `${props.name}-${stamp}.jpg`;
    a.click();
  };
  if (mode.value === 'jpeg' && jpegUrl.value) {
    save(jpegUrl.value);
    return;
  }
  const v = videoRef.value;
  if (!v?.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  save(canvas.toDataURL('image/jpeg', 0.92));
}

const fullscreen = ref(false);
const onFullscreenChange = () => { fullscreen.value = document.fullscreenElement === rootRef.value; };
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else rootRef.value?.requestFullscreen?.().catch(() => {});
}

const setState = (next, message = '') => {
  state.value = next;
  error.value = message;
  emit('state', next);
};

async function connect() {
  stop();
  const cfg = props.config;
  if (!cfg?.channelARN || !cfg.signalingEndpoints?.WSS || !cfg.credentials) {
    setState('error', t('cameras.kvs.badConfig'));
    return;
  }
  setState('connecting');
  let SignalingClient;
  let Role;
  try {
    ({ SignalingClient, Role } = await import('amazon-kinesis-video-streams-webrtc'));
  } catch (err) {
    setState('error', t('cameras.kvs.failed'));
    return;
  }
  try {
    pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [], iceTransportPolicy: 'all' });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    openChannel(); // before the offer, so the SDP has its application line
    startInfo();
    pc.addEventListener('track', (event) => {
      if (videoRef.value && event.streams?.[0]) {
        videoRef.value.srcObject = event.streams[0];
        videoRef.value.play?.().catch(() => {});
      }
      clearTimeout(waitTimer);
      setState('playing');
    });
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected', 'closed'].includes(pc?.connectionState)) setState('error', t('cameras.kvs.disconnected'));
    });
    signaling = new SignalingClient({
      channelARN: cfg.channelARN,
      channelEndpoint: cfg.signalingEndpoints.WSS,
      clientId: cfg.clientId,
      role: Role.VIEWER,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.credentials.accessKeyId,
        secretAccessKey: cfg.credentials.secretAccessKey,
        sessionToken: cfg.credentials.sessionToken,
      },
      systemClockOffset: 0,
    });
    signaling.on('open', async () => {
      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      signaling.sendSdpOffer(pc.localDescription);
      // No answer for a while: the camera is not on the channel yet (asleep, or joining after live.start, which
      // takes a few seconds on battery). KVS only delivers an offer to a MASTER that is connected, so offer again
      // every 8 s for up to 2 minutes; the SDP already carries the gathered ICE candidates.
      let offers = 1;
      const reoffer = () => {
        if (state.value === 'playing' || state.value === 'error' || !pc || !signaling) return;
        if (state.value === 'connecting') setState('waiting');
        if (offers >= 15) return;
        offers++;
        try { signaling.sendSdpOffer(pc.localDescription); } catch { /* closed: the close handler reports it */ }
        waitTimer = setTimeout(reoffer, 8000);
      };
      waitTimer = setTimeout(reoffer, 8000);
    });
    signaling.on('sdpAnswer', async (answer) => {
      await pc.setRemoteDescription(answer);
    });
    signaling.on('iceCandidate', (candidate) => {
      pc.addIceCandidate(candidate).catch(() => {});
    });
    signaling.on('close', () => {
      if (state.value !== 'playing') setState('error', t('cameras.kvs.disconnected'));
    });
    signaling.on('error', (err) => {
      setState('error', err?.message || t('cameras.kvs.failed'));
    });
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) signaling?.sendIceCandidate(candidate);
    });
    signaling.open();
  } catch (err) {
    setState('error', err?.message || t('cameras.kvs.failed'));
  }
}

function stop() {
  clearTimeout(waitTimer);
  clearTimeout(askTimer);
  clearInterval(infoTimer);
  try {
    channel?.close();
  } catch {
    // already closed
  }
  channel = null;
  channelOpen = false;
  mode.value = 'h264';
  if (jpegUrl.value) URL.revokeObjectURL(jpegUrl.value);
  jpegUrl.value = '';
  try {
    signaling?.close();
  } catch {
    // already closed
  }
  signaling = null;
  try {
    pc?.close();
  } catch {
    // already closed
  }
  pc = null;
  if (videoRef.value) videoRef.value.srcObject = null;
}

watch(() => props.config?.clientId, () => connect());
watch(() => props.quality, () => askQuality());
onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  connect();
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  stop();
});

defineExpose({ reconnect: connect, stop });
</script>

<style scoped>
.kvs-viewer__bar {
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0));
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 2;
}
.kvs-viewer:hover .kvs-viewer__bar,
.kvs-viewer:focus-within .kvs-viewer__bar {
  opacity: 1;
}
@media (hover: none) {
  .kvs-viewer__bar {
    opacity: 1;
  }
}
.kvs-viewer__btn {
  color: rgba(255, 255, 255, 0.9) !important;
  font-size: 16px;
}
.kvs-viewer__quality {
  font-size: 12px;
}
.kvs-viewer__info {
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}
.kvs-viewer__scrim {
  background: rgba(0, 0, 0, 0.75);
  color: rgba(255, 255, 255, 0.85);
}
</style>
