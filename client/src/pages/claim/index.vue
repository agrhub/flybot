<template>
  <div class="claim-page w-full max-w-xl mx-auto flex flex-col gap-4">
    <PageHeader :title="t('claim.title')" :subtitle="t('claim.subtitle')" />

    <!-- Done: the camera is yours, with its first photo -->
    <el-card v-if="claimed" shadow="never" data-test="claim-done">
      <el-result icon="success" :title="t('claim.doneTitle', { name: claimed.camera.deviceName })" :sub-title="t('claim.doneHint')">
        <template #extra>
          <div class="flex flex-col items-center gap-3 w-full">
            <img v-if="previewSrc" :src="previewSrc" :alt="t('claim.previewAlt')" class="claim-preview" data-test="claim-preview" />
            <p v-else class="claim-muted">{{ t('claim.noPreview') }}</p>
            <p v-if="claimed.preview && claimed.preview.count !== null" class="claim-muted">{{ t('claim.previewCount', { count: claimed.preview.count }) }}</p>
            <div class="flex flex-wrap justify-center gap-2">
              <el-button type="primary" @click="openCameras">{{ t('claim.openCamera') }}</el-button>
              <el-button @click="reset">{{ t('claim.another') }}</el-button>
            </div>
          </div>
        </template>
      </el-result>
    </el-card>

    <template v-else>
      <!-- Scan the label QR (CAMOS:1;SN:...;VC:...;;) or type it -->
      <el-card shadow="never">
        <div class="flex flex-col gap-3">
          <div v-if="scanning" class="claim-scanner">
            <video ref="videoRef" autoplay playsinline muted class="w-full h-full object-cover"></video>
            <el-button class="claim-scanner__stop" size="small" @click="stopScan">{{ t('common.cancel') }}</el-button>
          </div>
          <el-button v-else-if="canScan" :icon="Camera" size="large" class="w-full" data-test="scan" @click="startScan">{{ t('claim.scan') }}</el-button>
          <el-alert v-if="scanError" type="warning" :closable="false" show-icon :title="scanError" />
          <p class="claim-muted">{{ canScan ? t('claim.orType') : t('claim.typeHint') }}</p>
        </div>
      </el-card>

      <el-card shadow="never">
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item :label="t('claim.serial')">
            <el-input v-model="form.serial" placeholder="ESPF85B1B92877C" maxlength="20" clearable autocapitalize="characters" data-test="serial" />
          </el-form-item>
          <el-form-item :label="t('claim.code')">
            <el-input v-model="form.verifyCode" placeholder="9WBYWY" maxlength="6" clearable autocapitalize="characters" data-test="code" />
          </el-form-item>
          <el-form-item :label="t('trapKind.label')">
            <el-radio-group v-model="form.trapKind" class="claim-kinds">
              <el-radio v-for="kind in ['lure', 'sticky']" :key="kind" :value="kind" border class="claim-kinds__option">
                <div class="claim-kinds__name">{{ t(`trapKind.${kind}.name`) }}</div>
                <div class="claim-kinds__hint">{{ t(`trapKind.${kind}.hint`) }}</div>
              </el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="farms.length" :label="t('claim.farm')">
            <el-select v-model="form.farmId" clearable :placeholder="t('claim.noFarm')" class="w-full">
              <el-option v-for="f in farms" :key="f.id" :label="f.name" :value="f.id" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('claim.interval')">
            <el-select v-model="form.captureIntervalMinutes" class="w-full">
              <el-option v-for="m in [15, 30, 60, 120]" :key="m" :label="t('cameras.schedule.every', { minutes: m })" :value="m" />
            </el-select>
          </el-form-item>
          <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" class="mb-3" data-test="claim-error" />
          <el-button type="primary" native-type="submit" size="large" class="w-full" :loading="submitting" :disabled="!ready" data-test="claim-submit">
            {{ t('claim.submit') }}
          </el-button>
        </el-form>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Camera } from '@element-plus/icons-vue';
import PageHeader from '@/components/common/PageHeader.vue';
import api from '@/services/api';
import { parseClaimCode } from '@/utils/claimCode';

/**
 * /claim: take over a CamOS camera that registered itself (public firmware). Reached from the QR
 * on the camera's label or its portal (claimUrl ...?sn=<serial>); sign-in comes first (router).
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const form = reactive({ serial: '', verifyCode: '', trapKind: 'lure', farmId: '', captureIntervalMinutes: 30 });
const farms = ref([]);
const submitting = ref(false);
const error = ref('');
const claimed = ref(null);

const ready = computed(() => /^ESP[0-9A-F]{12}$/i.test(form.serial.trim()) && form.verifyCode.trim().length === 6);
const previewSrc = computed(() => (claimed.value?.preview?.imageUrl ? api.getImageUrl(claimed.value.preview.imageUrl) : ''));

const fill = (parsed) => {
  if (parsed?.serial) form.serial = parsed.serial;
  if (parsed?.verifyCode) form.verifyCode = parsed.verifyCode;
};

// ---------- QR scan (BarcodeDetector where the browser has it) ----------
const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
const scanning = ref(false);
const scanError = ref('');
const videoRef = ref(null);
let stream = null;
let timer = null;

async function startScan() {
  scanError.value = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    scanning.value = true;
    await new Promise((r) => requestAnimationFrame(r));
    if (videoRef.value) videoRef.value.srcObject = stream;
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    timer = setInterval(async () => {
      if (!videoRef.value || videoRef.value.readyState < 2) return;
      try {
        const codes = await detector.detect(videoRef.value);
        const parsed = codes.map((c) => parseClaimCode(c.rawValue)).find((p) => p?.serial);
        if (parsed) {
          fill(parsed);
          stopScan();
        }
      } catch {
        // next frame
      }
    }, 400);
  } catch {
    scanError.value = t('claim.scanFailed');
    stopScan();
  }
}

function stopScan() {
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  scanning.value = false;
}

// ---------- Claim ----------
async function submit() {
  if (!ready.value || submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    const res = await api.claimCamera({
      serial: form.serial.trim().toUpperCase(),
      verifyCode: form.verifyCode.trim().toUpperCase(),
      trapKind: form.trapKind,
      captureIntervalMinutes: form.captureIntervalMinutes,
      ...(form.farmId ? { farmId: form.farmId } : {}),
    });
    claimed.value = res.data;
  } catch (err) {
    const code = err.response?.data?.code;
    const limit = err.response?.data?.limit;
    error.value = code === 'NOT_FOUND' ? t('claim.errors.notFound')
      : code === 'LOCKED' ? t('claim.errors.locked')
      : code === 'LIMIT_REACHED' ? t('claim.errors.limit', { limit: limit ?? 3 })
      : code === 'BAD_FARM' ? t('claim.errors.farm')
      : t('claim.errors.generic');
  } finally {
    submitting.value = false;
  }
}

function reset() {
  claimed.value = null;
  Object.assign(form, { serial: '', verifyCode: '', farmId: '' });
}

const openCameras = () => router.push({ path: '/cameras' });

onMounted(async () => {
  fill(parseClaimCode(String(route.query.qr || '')) || {});
  if (route.query.sn) form.serial = String(route.query.sn).toUpperCase().slice(0, 20);
  if (route.query.vc) form.verifyCode = String(route.query.vc).toUpperCase().slice(0, 6);
  try {
    const res = await api.listFarms();
    farms.value = (res.data?.farms || []).filter((f) => f.canEdit);
  } catch {
    farms.value = [];
  }
});
onBeforeUnmount(stopScan);
</script>

<style scoped>
.claim-muted {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
.claim-preview {
  width: 100%;
  max-width: 420px;
  border-radius: 8px;
  border: 1px solid var(--el-border-color);
}
.claim-scanner {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 60vh;
  overflow: hidden;
  border-radius: 8px;
  background: #000;
}
.claim-scanner__stop {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
}
.claim-kinds {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.claim-kinds__option {
  height: auto;
  margin-right: 0 !important;
  padding: 8px 12px;
  white-space: normal;
}
.claim-kinds__name {
  font-weight: 600;
}
.claim-kinds__hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
