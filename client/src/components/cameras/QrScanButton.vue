<template>
  <!-- Shown only where the browser can read QR codes (Chrome on Android, desktop Chrome/Edge) -->
  <el-button v-if="supported" :icon="FullScreen" @click="open">{{ t('cameras.qrScan.button') }}</el-button>

  <el-dialog v-model="visible" :title="t('cameras.qrScan.title')" width="min(420px, 94vw)" append-to-body @closed="stop">
    <div class="qr-scan">
      <video ref="video" class="qr-scan__video" autoplay muted playsinline></video>
    </div>
    <p class="qr-scan__hint">{{ error || t('cameras.qrScan.hint') }}</p>
  </el-dialog>
</template>

<script setup>
import { ref, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { FullScreen } from '@element-plus/icons-vue';

const emit = defineEmits(['detected']);
const { t } = useI18n();

const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
const visible = ref(false);
const video = ref(null);
const error = ref('');
let stream = null;
let timer = null;

const stop = () => {
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
};

const open = async () => {
  error.value = '';
  visible.value = true;
  await nextTick();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.value.srcObject = stream;
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    timer = setInterval(async () => {
      if (!video.value || video.value.readyState < 2) return;
      try {
        const codes = await detector.detect(video.value);
        if (codes.length) {
          emit('detected', codes[0].rawValue);
          visible.value = false;
          stop();
        }
      } catch {
        // A frame that cannot be read: try the next one
      }
    }, 300);
  } catch {
    error.value = t('cameras.qrScan.noCamera');
  }
};

onBeforeUnmount(stop);
</script>

<style scoped>
.qr-scan {
  aspect-ratio: 1;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  overflow: hidden;
}
.qr-scan__video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.qr-scan__hint {
  margin-top: 10px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
