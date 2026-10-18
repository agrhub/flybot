<template>
  <!-- A rectangle in percent of the picture, drawn on top of the preview: drag on the picture to draw a new one,
       drag the box to move it, drag a corner to resize it -->
  <div
    ref="rootRef"
    class="area-sel absolute inset-0"
    :class="{ 'is-disabled': disabled }"
    data-test="area-selector"
    @pointerdown="onDown($event, 'draw')"
  >
    <div class="area-sel__shade" />
    <div
      class="area-sel__box"
      :style="{ left: `${box[0]}%`, top: `${box[1]}%`, width: `${box[2]}%`, height: `${box[3]}%` }"
      data-test="area-box"
      @pointerdown.stop="onDown($event, 'move')"
    >
      <span v-for="c in corners" :key="c" class="area-sel__handle" :class="`is-${c}`" @pointerdown.stop="onDown($event, c)" />
      <span class="area-sel__label">{{ box[2] }}×{{ box[3]}} %</span>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { applyDrag, normalizeArea } from '@/utils/areaGeometry';

const props = defineProps({
  modelValue: { type: Array, default: () => [0, 0, 100, 100] }, // [x, y, w, h] percent
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const rootRef = ref(null);
const box = ref(normalizeArea(props.modelValue));
const corners = ['nw', 'ne', 'sw', 'se'];
watch(() => props.modelValue, (v) => { if (!drag) box.value = normalizeArea(v); }, { deep: true });

let drag = null;
function pointPct(e) {
  const r = rootRef.value.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100];
}
function onDown(e, kind) {
  if (props.disabled || !rootRef.value) return;
  e.preventDefault();
  drag = { kind, start: pointPct(e), from: [...box.value] };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}
function onMove(e) {
  if (!drag) return;
  box.value = applyDrag(drag.kind, drag.from, drag.start, pointPct(e));
}
function onUp() {
  window.removeEventListener('pointermove', onMove);
  if (drag) emit('update:modelValue', [...box.value]);
  drag = null;
}
onBeforeUnmount(() => window.removeEventListener('pointermove', onMove));
</script>

<style scoped>
.area-sel {
  cursor: crosshair;
  touch-action: none;
  z-index: 3;
}
.area-sel.is-disabled {
  pointer-events: none;
  opacity: 0.5;
}
.area-sel__box {
  position: absolute;
  border: 2px solid var(--el-color-primary);
  background: rgba(64, 158, 255, 0.12);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35);
  cursor: move;
}
.area-sel__handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 2px solid var(--el-color-primary);
  border-radius: 3px;
}
.area-sel__handle.is-nw { left: -7px; top: -7px; cursor: nwse-resize; }
.area-sel__handle.is-ne { right: -7px; top: -7px; cursor: nesw-resize; }
.area-sel__handle.is-sw { left: -7px; bottom: -7px; cursor: nesw-resize; }
.area-sel__handle.is-se { right: -7px; bottom: -7px; cursor: nwse-resize; }
.area-sel__label {
  position: absolute;
  left: 4px;
  top: 4px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  padding: 0 4px;
  border-radius: 3px;
  pointer-events: none;
}
.area-sel__shade {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
</style>
