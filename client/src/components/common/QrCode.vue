<template>
  <!-- The SVG comes from qrcode-generator for our own text; the text itself is not part of the markup -->
  <div class="qr-code" role="img" :aria-label="label" :style="{ width: `${size}px`, height: `${size}px` }" v-html="svg"></div>
</template>

<script setup>
import { computed } from 'vue';
import qrcode from 'qrcode-generator';

/** A QR code drawn as SVG in the browser (no network call), e.g. the CamOS provisioning QR. */
const props = defineProps({
  text: { type: String, required: true },
  size: { type: Number, default: 180 },
  label: { type: String, default: 'QR code' },
});

const svg = computed(() => {
  if (!props.text) return '';
  const qr = qrcode(0, 'M');
  qr.addData(props.text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
});
</script>

<style scoped>
.qr-code {
  background: #fff;
  border-radius: 6px;
  padding: 6px;
  box-sizing: border-box;
}
.qr-code :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
