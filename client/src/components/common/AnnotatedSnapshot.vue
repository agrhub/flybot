<template>
  <div class="snap" :class="{ 'is-clickable': !!item }" @click.stop="item && emit('open', item)">
    <el-skeleton v-if="loading" animated class="snap__fill">
      <template #template><el-skeleton-item variant="image" class="snap__fill" /></template>
    </el-skeleton>
    <img v-else-if="src" :src="src" :alt="title" class="snap__fill snap__img" />
    <div v-else class="snap__fill snap__empty">
      <el-icon :size="24"><Picture /></el-icon>
      <span>{{ t('dashboard.noSnapshotYet') }}</span>
    </div>
    <div v-if="item && !loading" class="snap__title">
      <span class="truncate">{{ title }}</span>
      <span class="shrink-0">{{ subtitle }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Picture } from '@element-plus/icons-vue';
import { annotatedImage } from '@/utils/detectionImage';
import { latestOnly } from '@/utils/latestOnly';

/**
 * A snapshot with its AI detections drawn on it (a box and the species around each insect),
 * captioned with a title and the photo time. Click: `open` with the snapshot.
 * `item`: { createdAt, imageUrl|s3Key, aiResults: { insects, summary } } or null.
 */
const props = defineProps({
  item: { type: Object, default: null },
  title: { type: String, default: '' },
  count: { type: [Number, String], default: null },
});
const emit = defineEmits(['open']);
const { t, locale } = useI18n();

const src = ref('');
const loading = ref(false);

const subtitle = computed(() => {
  if (!props.item?.createdAt) return '';
  const d = new Date(props.item.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  return props.count === null ? time : `${t('dashboard.snapshotCount', { count: props.count })} · ${time}`;
});

const renderRequest = latestOnly();
const render = async () => {
  const isLatest = renderRequest();
  if (!props.item) {
    src.value = '';
    return;
  }
  loading.value = true;
  const image = await annotatedImage(props.item, { t, maxWidth: 720, quality: 0.82 });
  if (!isLatest()) return;
  src.value = image?.dataUrl || '';
  loading.value = false;
};

// Labels are drawn in the current language
watch(() => [props.item?._id, props.item?.createdAt, locale.value], render, { immediate: true });
</script>

<style scoped>
.snap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-lighter);
  background-color: var(--el-fill-color-light);
}
.snap.is-clickable {
  cursor: zoom-in;
}
.snap__fill {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.snap__img {
  object-fit: cover;
}
.snap__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.snap__title {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
  background-color: var(--el-overlay-color-light);
  color: var(--el-color-white);
}
</style>
