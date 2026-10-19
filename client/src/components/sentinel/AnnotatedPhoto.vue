<template>
  <!-- FlyBot's own photo with the vision Lambda's boxes drawn on it, and face regions blurred -->
  <div class="annotated-photo" :style="frameStyle" data-test="annotated-photo">
    <img
      v-if="!failed"
      :src="src"
      :alt="alt"
      loading="lazy"
      class="annotated-photo__img"
      :class="{ 'is-blurred': blurAll }"
      @error="failed = true"
    />
    <div v-else class="annotated-photo__missing">{{ t('sentinel.traces.imageUnavailable') }}</div>
    <template v-if="!failed">
      <span v-for="(r, i) in regions" :key="`p${i}`" class="annotated-photo__privacy" :style="boxStyle(r)" />
      <span v-for="(b, i) in boxes" :key="`b${i}`" class="annotated-photo__box" :style="boxStyle(b)" data-test="photo-box" />
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * One photo with an overlay from the analysis: `boxes` and `privacy.regions` are normalised
 * {x, y, w, h}; `privacy.blurAll` blurs the whole picture. The frame keeps the photo's own aspect
 * ratio (width / height) so the boxes land where the detector saw them.
 */
const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, default: '' },
  overlay: { type: Object, default: null }, // { boxes, privacy: { regions, blurAll }, width, height }
});
const { t } = useI18n();

const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });

const valid = (b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite);
const boxes = computed(() => (props.overlay?.boxes || []).filter(valid));
const regions = computed(() => (props.overlay?.privacy?.regions || []).filter(valid));
const blurAll = computed(() => !!props.overlay?.privacy?.blurAll);
const frameStyle = computed(() => {
  const { width, height } = props.overlay || {};
  return { aspectRatio: width > 0 && height > 0 ? `${width} / ${height}` : '4 / 3' };
});
const pct = (v) => `${Math.max(0, Math.min(100, v * 100))}%`;
const boxStyle = (b) => ({ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) });
</script>

<style scoped>
.annotated-photo {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color);
  background-color: var(--el-fill-color-light);
}
.annotated-photo__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
}
.annotated-photo__img.is-blurred {
  filter: blur(18px);
}
.annotated-photo__box {
  position: absolute;
  border: 2px solid var(--el-color-danger);
  border-radius: 2px;
  pointer-events: none;
}
.annotated-photo__privacy {
  position: absolute;
  backdrop-filter: blur(14px);
  background-color: var(--el-mask-color-extra-light);
  pointer-events: none;
}
.annotated-photo__missing {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 90px;
  padding: 8px;
  font-size: 12px;
  text-align: center;
  color: var(--el-text-color-secondary);
}
</style>
