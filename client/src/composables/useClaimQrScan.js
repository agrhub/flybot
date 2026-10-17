import { onBeforeUnmount, ref } from 'vue';
import { parseClaimCode } from '@/utils/claimCode';

/**
 * Scan a CamOS label QR (CAMOS:1;SN:...;VC:...;;) with the camera of the phone or computer, where the
 * browser has BarcodeDetector. `onFound({ serial, verifyCode })` runs once and the scan stops.
 * Used by the Add camera dialog and the /claim page.
 */
export function useClaimQrScan(onFound, { failedText = '' } = {}) {
  const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  const scanning = ref(false);
  const scanError = ref('');
  const videoRef = ref(null);
  let stream = null;
  let timer = null;

  function stopScan() {
    clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    scanning.value = false;
  }

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
            stopScan();
            onFound(parsed);
          }
        } catch {
          // next frame
        }
      }, 400);
    } catch {
      scanError.value = failedText;
      stopScan();
    }
  }

  onBeforeUnmount(stopScan);
  return { canScan, scanning, scanError, videoRef, startScan, stopScan };
}

export default useClaimQrScan;
