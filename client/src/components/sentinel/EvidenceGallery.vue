<template>
  <div class="evidence-gallery">
    <p v-if="!images.length" class="meta-text">{{ t('sentinel.traces.imagesNone') }}</p>

    <!-- The vision op's aligned pair (previous | current | blend) is one picture; two raw photos side by side otherwise -->
    <figure v-if="pair?.composite" class="evidence-figure">
      <el-image
        :src="srcOf(pair.composite.ref)"
        :alt="altOf(pair.composite)"
        :preview-src-list="previewList"
        :initial-index="indexOf(pair.composite.ref)"
        preview-teleported
        fit="contain"
        loading="lazy"
        class="evidence-image evidence-image--wide"
      >
        <template #error><div class="evidence-missing">{{ t('sentinel.traces.imageUnavailable') }}</div></template>
      </el-image>
      <figcaption>{{ kindLabel('aligned') }} <span class="mono">{{ fileName(pair.composite.ref) }}</span></figcaption>
    </figure>
    <div v-else-if="pair?.left" class="grid grid-cols-1 sm:grid-cols-2 gap-3" data-test="side-by-side">
      <figure v-for="(side, i) in [pair.left, pair.right]" :key="side.ref" class="evidence-figure">
        <el-image
          :src="srcOf(side.ref)"
          :alt="`${i ? t('sentinel.traces.after') : t('sentinel.traces.before')}: ${fileName(side.ref)}`"
          :preview-src-list="previewList"
          :initial-index="indexOf(side.ref)"
          preview-teleported
          fit="cover"
          loading="lazy"
          class="evidence-image"
        >
          <template #error><div class="evidence-missing">{{ t('sentinel.traces.imageUnavailable') }}</div></template>
        </el-image>
        <figcaption>{{ i ? t('sentinel.traces.after') : t('sentinel.traces.before') }}</figcaption>
      </figure>
    </div>

    <div v-if="rest.length" class="evidence-grid">
      <figure v-for="img in rest" :key="img.ref" class="evidence-figure" data-test="evidence-item">
        <el-image
          :src="srcOf(img.ref)"
          :alt="altOf(img)"
          :preview-src-list="previewList"
          :initial-index="indexOf(img.ref)"
          preview-teleported
          fit="cover"
          loading="lazy"
          class="evidence-image"
        >
          <template #error><div class="evidence-missing">{{ t('sentinel.traces.imageUnavailable') }}</div></template>
        </el-image>
        <figcaption>
          <el-tag size="small" effect="plain" round>{{ kindLabel(img.kind) }}</el-tag>
          <span class="mono truncate">{{ fileName(img.ref) }}</span>
        </figcaption>
      </figure>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';
import { alignedPair } from '@/utils/sentinel/trace';

/**
 * Evidence pictures of a trace or a proposal: the aligned pair first, then masks, crops, heat maps
 * and matches. Every picture comes through FlyBot (/api/sentinel/ui/evidence?key=); click to enlarge.
 */
const props = defineProps({
  images: { type: Array, required: true }, // [{ ref, kind, from }]
  obs: { type: Object, default: null },
});
const { t } = useI18n();

const pair = computed(() => alignedPair(props.images, props.obs));
const rest = computed(() => {
  const used = new Set();
  if (pair.value?.composite) used.add(pair.value.composite.ref);
  if (pair.value?.left) {
    used.add(pair.value.left.ref);
    used.add(pair.value.right.ref);
  }
  return props.images.filter((i) => !used.has(i.ref));
});
const ordered = computed(() => [
  ...(pair.value?.composite ? [pair.value.composite] : []),
  ...(pair.value?.left ? [pair.value.left, pair.value.right] : []),
  ...rest.value,
]);
const previewList = computed(() => ordered.value.map((i) => api.sentinelEvidenceUrl(i.ref)));
const indexOf = (ref) => Math.max(0, ordered.value.findIndex((i) => i.ref === ref));

const srcOf = (ref) => api.sentinelEvidenceUrl(ref);
const fileName = (ref) => String(ref).split('/').pop();
const kindLabel = (kind) => (kind ? t(`sentinel.traces.kind.${kind}`) : t('sentinel.traces.kind.photo'));
const altOf = (img) => `${kindLabel(img.kind)}: ${fileName(img.ref)}`;
</script>

<style scoped>
.evidence-gallery {
  display: grid;
  gap: 12px;
}
.evidence-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
}
.evidence-figure {
  margin: 0;
  min-width: 0;
}
.evidence-figure figcaption {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  min-width: 0;
}
.evidence-image {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color);
  background-color: var(--el-fill-color-light);
}
.evidence-image--wide {
  aspect-ratio: auto;
  max-height: 360px;
}
.evidence-missing {
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
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
