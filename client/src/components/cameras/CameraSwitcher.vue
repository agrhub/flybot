<template>
  <div class="cam-switch flex flex-col gap-2 min-h-0" data-test="camera-switcher">
    <el-input v-model="query" :placeholder="t('cameras.switcher.search')" :prefix-icon="Search" clearable size="default" data-test="switcher-search" />
    <div class="flex items-center gap-2">
      <el-select v-model="status" size="small" class="flex-1" :aria-label="t('cameras.switcher.status')" data-test="switcher-status">
        <el-option value="all" :label="t('cameras.switcher.allStatus')" />
        <el-option value="online" :label="t('common.online')" />
        <el-option value="offline" :label="t('common.offline')" />
      </el-select>
      <el-select v-model="type" size="small" class="flex-1" :aria-label="t('cameras.switcher.type')" data-test="switcher-type">
        <el-option value="all" :label="t('cameras.switcher.allTypes')" />
        <el-option value="ezviz" :label="t('cameras.platform.ezviz')" />
        <el-option value="camos" :label="t('cameras.platform.camos')" />
      </el-select>
    </div>
    <p class="cam-switch__count">{{ t('cameras.switcher.count', { shown: filtered.length, total: cameras.length }) }}</p>
    <div class="cam-switch__list flex flex-col gap-1.5 overflow-y-auto min-h-0">
      <button
        v-for="cam in filtered"
        :key="cam.deviceSerial"
        type="button"
        class="cam-switch__item"
        :class="{ 'is-active': cam.deviceSerial === modelValue }"
        :aria-current="cam.deviceSerial === modelValue ? 'true' : undefined"
        :data-test="`switcher-${cam.deviceSerial}`"
        @click="emit('select', cam.deviceSerial)"
      >
        <span class="cam-switch__thumb">
          <img v-if="thumbOf(cam)" :src="thumbOf(cam)" alt="" loading="lazy" @error="broken[cam.deviceSerial] = true" />
          <img v-else-if="isCamos(cam)" src="/images/camos-logo.png" alt="" class="cam-switch__logo" />
          <el-icon v-else :size="18"><VideoCamera /></el-icon>
          <span class="cam-switch__dot" :class="'is-' + cameraState(cam)"></span>
        </span>
        <span class="min-w-0 flex-1 text-left">
          <span class="cam-switch__name truncate">{{ cam.deviceName || cam.deviceSerial }}</span>
          <span class="cam-switch__meta truncate">{{ t(`cameras.platform.${platformOf(cam)}`) }} · {{ cameraStateLabel(cam, t) }}</span>
        </span>
      </button>
      <p v-if="!filtered.length" class="cam-switch__count text-center py-4">{{ t('cameras.switcher.none') }}</p>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Search, VideoCamera } from '@element-plus/icons-vue';
import api from '@/services/api';
import { filterCameras, cameraState, cameraStateLabel } from '@/utils/cameraFilter';

/** The camera list beside the detail view: thumbnails, search, online/offline and type filters. */
const props = defineProps({
  cameras: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' }, // serial of the camera shown
});
const emit = defineEmits(['select']);
const { t } = useI18n();

const query = ref('');
const status = ref('all');
const type = ref('all');
const broken = reactive({});

const platformOf = (cam) => (cam?.platform === 'camos' || cam?.platform === 'kinesis' ? 'camos' : 'ezviz');
const isCamos = (cam) => platformOf(cam) === 'camos';
const thumbOf = (cam) => {
  if (broken[cam.deviceSerial]) return '';
  const url = cam.thumbnailUrl || cam.picUrl;
  return url ? api.getImageUrl(url) : '';
};
const filtered = computed(() => filterCameras(props.cameras, { query: query.value, status: status.value, type: type.value }));
</script>

<style scoped>
.cam-switch__count {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cam-switch__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.cam-switch__item:hover {
  background: var(--el-fill-color-light);
}
.cam-switch__item.is-active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.cam-switch__thumb {
  position: relative;
  width: 56px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.7);
}
.cam-switch__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cam-switch__thumb img.cam-switch__logo {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.cam-switch__dot {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid #000;
}
.cam-switch__dot.is-online {
  background: var(--el-color-success);
}
.cam-switch__dot.is-offline {
  background: var(--el-color-danger);
}
.cam-switch__dot.is-sleeping {
  background: var(--el-color-info);
}
.cam-switch__name {
  display: block;
  font-size: 13px;
  font-weight: 600;
}
.cam-switch__meta {
  display: block;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
