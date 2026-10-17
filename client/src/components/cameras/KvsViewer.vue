<template>
  <div class="kvs-viewer w-full h-full relative flex items-center justify-center">
    <video ref="videoRef" autoplay playsinline muted class="w-full h-full object-contain" :class="{ hidden: state !== 'playing' }"></video>
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

/**
 * Live view of a CamOS camera over Kinesis Video Streams WebRTC: the browser joins the camera's
 * signaling channel as VIEWER with the config from GET /api/cameras/:serial/live (channel ARN,
 * signaling endpoints, ICE servers, 15-minute credentials). The camera is the MASTER; it only
 * encodes while a viewer is connected.
 */
const props = defineProps({
  // The viewer config (platform "kinesis")
  config: { type: Object, required: true },
});
const emit = defineEmits(['state']);
const { t } = useI18n();

const videoRef = ref(null);
// connecting | waiting (no master yet) | playing | error
const state = ref('connecting');
const error = ref('');
const stateText = computed(() => (state.value === 'error' ? error.value || t('cameras.kvs.failed') : t(`cameras.kvs.${state.value}`)));

let signaling = null;
let pc = null;
let waitTimer = null;

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
