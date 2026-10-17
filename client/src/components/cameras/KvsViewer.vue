<template>
  <div class="kvs-viewer w-full h-full relative flex items-center justify-center">
    <video ref="videoRef" autoplay playsinline muted class="w-full h-full object-contain" :class="{ hidden: state !== 'playing' || mode === 'jpeg' }"></video>
    <!-- JPEG mode: the camera's own JPEG pictures over the "camos" data channel -->
    <img v-if="mode === 'jpeg'" v-show="state === 'playing' && jpegUrl" :src="jpegUrl" alt="" class="w-full h-full object-contain" data-test="kvs-jpeg" />
    <div v-if="state !== 'playing'" class="kvs-viewer__scrim absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
      <el-icon v-if="state === 'connecting' || state === 'waiting'" :size="26" class="is-loading"><Loading /></el-icon>
      <el-icon v-else :size="26"><WarningFilled /></el-icon>
      <span class="text-xs font-medium" data-test="kvs-state">{{ stateText }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Loading, WarningFilled } from '@element-plus/icons-vue';
import { CAMOS_CHANNEL, CHANNEL_OPTIONS, JpegAssembler, RateMeter, ackMessage, parseControl, presetFor, qualityMessage } from '@/utils/camosLive';

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
});
// info: { mode: 'h264' | 'jpeg', width, height, fps } about once a second while playing
const emit = defineEmits(['state', 'info']);
const { t } = useI18n();

const videoRef = ref(null);
// connecting | waiting (no master yet) | playing | error
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
    if (m.t === 'hello') askQuality();
    else if (wanted && m.mode === wanted.mode && m.w === wanted.w) wanted = null; // confirmed
  } else if (m.t === 'error' && wanted) {
    wanted = null; // the camera keeps what runs (it could not start the asked size)
  }
}

// Ask for the preset of the chosen quality, again every 2 s (up to 3 times) until the camera confirms it
function askQuality() {
  clearTimeout(askTimer);
  wanted = presetFor(props.quality, channelOpen);
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

function startInfo() {
  clearInterval(infoTimer);
  infoTimer = setInterval(async () => {
    if (state.value !== 'playing') return;
    if (mode.value === 'jpeg') {
      emit('info', { mode: 'jpeg', width: jpegSize.width, height: jpegSize.height, fps: rate.fps(performance.now()) });
    } else {
      const v = videoRef.value;
      emit('info', { mode: 'h264', width: v?.videoWidth || 0, height: v?.videoHeight || 0, fps: await videoFps() });
    }
  }, 1000);
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
onMounted(connect);
onBeforeUnmount(stop);

defineExpose({ reconnect: connect, stop });
</script>

<style scoped>
.kvs-viewer__scrim {
  background: rgba(0, 0, 0, 0.75);
  color: rgba(255, 255, 255, 0.85);
}
</style>
