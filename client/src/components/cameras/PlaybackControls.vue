<template>
  <el-card shadow="never" class="playback w-full select-none">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="playback__title flex items-center gap-2">
          <el-icon class="playback__title-icon"><Film /></el-icon>
          {{ t('cameras.playbackTitle') }}
          <span class="playback__meta">· {{ records.length }} {{ t('cameras.clipsUnit') }}</span>
        </span>
        <div class="flex flex-wrap items-center gap-2">
          <el-button :icon="ArrowLeft" circle size="small" :aria-label="t('cameras.prevDay')" @click="shiftDay(-1)" />
          <el-date-picker v-model="searchDate" type="date" format="DD/MM/YYYY" :clearable="false" :disabled-date="(d) => d.getTime() > Date.now()" class="playback__date" />
          <el-button :icon="ArrowRight" circle size="small" :disabled="isToday" :aria-label="t('cameras.nextDay')" @click="shiftDay(1)" />
          <el-button :icon="Refresh" size="small" :loading="loading" @click="searchRecords">{{ t('common.refresh') }}</el-button>
          <el-button type="primary" plain :icon="VideoCamera" size="small" :disabled="!playing" @click="backToLive">{{ t('cameras.backToLive') }}</el-button>
        </div>
      </div>
    </template>

    <div v-loading="loading">
      <!-- Clips, left to right in time order -->
      <el-scrollbar v-if="clips.length" ref="stripRef" class="playback__strip">
        <div class="flex gap-3 pb-2">
          <div
            v-for="clip in clips"
            :key="clip.key"
            :data-clip="clip.key"
            class="playback__clip"
            :class="{ 'is-playing': playing?.key === clip.key }"
            role="button"
            tabindex="0"
            @click="playClip(clip)"
            @keydown.enter.prevent="playClip(clip)"
            @keydown.space.prevent="playClip(clip)"
          >
            <div class="playback__thumb">
              <el-image v-if="clip.thumb" :src="clip.thumb" alt="" fit="cover" class="w-full h-full" lazy />
              <el-icon v-else :size="22"><VideoCamera /></el-icon>
              <span class="playback__badge playback__badge--start">{{ formatTime(clip.start) }}</span>
              <span class="playback__badge playback__badge--duration">{{ formatDuration(clip) }}</span>
              <el-icon class="playback__play" :size="22"><VideoPlay /></el-icon>
            </div>
          </div>
        </div>
      </el-scrollbar>
      <el-empty v-else-if="!loading" :image-size="56" :description="t('cameras.noClips')" />

      <!-- 24-hour timeline: recorded spans, the playing clip, zoom -->
      <div class="flex items-center gap-2 mt-2">
        <div ref="timelineScroll" class="playback__timeline-scroll">
          <div
            class="playback__timeline"
            :style="{ width: `${zoom * 100}%` }"
            role="slider"
            tabindex="0"
            :aria-label="t('cameras.timeline')"
            aria-valuemin="0"
            aria-valuemax="1439"
            :aria-valuenow="playing ? minuteOf(playing.start) : undefined"
            :aria-valuetext="playing ? formatTime(playing.start) : t('cameras.timelineIdle')"
            @click="onTimelineClick"
            @keydown="onTimelineKey"
          >
            <div
              v-for="clip in clips"
              :key="clip.key"
              class="playback__span"
              :class="{ 'is-playing': playing?.key === clip.key }"
              :style="spanStyle(clip)"
            ></div>
            <div v-if="playing" class="playback__cursor" :style="{ left: `${percentOf(playing.start)}%` }">
              <span class="playback__cursor-label">{{ formatTime(playing.start) }}</span>
            </div>
            <div v-for="h in ticks" :key="h" class="playback__tick" :style="{ left: `${(h / 24) * 100}%` }">
              <span>{{ String(h).padStart(2, '0') }}:00</span>
            </div>
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <el-button :icon="ZoomIn" circle size="small" :disabled="zoom >= ZOOMS.at(-1)" :aria-label="t('cameras.zoomIn')" @click="setZoom(1)" />
          <el-button :icon="ZoomOut" circle size="small" :disabled="zoom <= ZOOMS[0]" :aria-label="t('cameras.zoomOut')" @click="setZoom(-1)" />
        </div>
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import { ArrowLeft, ArrowRight, Film, Refresh, VideoCamera, VideoPlay, ZoomIn, ZoomOut } from '@element-plus/icons-vue';
import api from '@/services/api';
import { latestOnly } from '@/utils/latestOnly';

/**
 * Recordings of one day as a horizontal strip of clips (with the nearest AI photo as a thumbnail)
 * above a 24-hour timeline. Clicking a clip, or a recorded span on the timeline, plays it.
 */
const props = defineProps({
  camera: Object,
});
const emit = defineEmits(['play-playback', 'back-to-live']);
const { t, locale } = useI18n();

const ZOOMS = [1, 2, 4, 8];
const searchDate = ref(new Date());
const records = ref([]);
const photos = ref([]);
const loading = ref(false);
const playing = ref(null);
const zoom = ref(1);
const stripRef = ref(null);
const timelineScroll = ref(null);

const isToday = computed(() => new Date(searchDate.value).toDateString() === new Date().toDateString());
const dayStart = computed(() => {
  const d = new Date(searchDate.value);
  d.setHours(0, 0, 0, 0);
  return d;
});
const pad = (n) => String(n).padStart(2, '0');
const dayText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Clip times come as "YYYY-MM-DD HH:mm:ss" (local), ISO strings or epoch milliseconds
const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return new Date(Number(value));
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
};

const clips = computed(() => records.value
  .map((clip, i) => {
    const start = toDate(clip.startTime || clip.beginTime);
    const end = toDate(clip.endTime || clip.stopTime);
    if (!start) return null;
    return { key: `${i}-${start.getTime()}`, raw: clip, start, end: end || start };
  })
  .filter(Boolean)
  .sort((a, b) => a.start - b.start)
  .map((clip) => {
    // Thumbnail: the AI photo taken during the clip, or the last one before it
    let thumb = null;
    for (const photo of photos.value) {
      if (photo.at <= clip.end) thumb = photo.url;
      else break;
    }
    return { ...clip, thumb };
  }));

const percentOf = (date) => Math.min(100, Math.max(0, ((date - dayStart.value) / 86400000) * 100));
const spanStyle = (clip) => {
  const left = percentOf(clip.start);
  return { left: `${left}%`, width: `${Math.max(0.15, percentOf(clip.end) - left)}%` };
};
const ticks = computed(() => {
  const step = zoom.value >= 4 ? 1 : zoom.value === 2 ? 2 : 3;
  return Array.from({ length: Math.ceil(24 / step) }, (_, i) => i * step);
});

const formatTime = (date) => date.toLocaleTimeString(locale.value === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const formatDuration = (clip) => {
  const seconds = Math.max(0, Math.round((clip.end - clip.start) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}'${pad(s)}"` : `${s}"`;
};

const loadPhotos = async () => {
  try {
    const res = await api.getHistory({ deviceSerials: [props.camera.deviceSerial], startDate: dayStart.value.toISOString(), endDate: dayText(dayStart.value), limit: 500 });
    return (res.data?.results || [])
      .map(r => ({ at: new Date(r.createdAt), url: api.getImageUrl(r.imageUrl || r.s3Key) }))
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
};

// The clips of the last day asked for (quick day changes can answer out of order)
const recordsRequest = latestOnly();
const searchRecords = async () => {
  if (!props.camera?.deviceSerial) return;
  const isLatest = recordsRequest();
  loading.value = true;
  records.value = [];
  const day = dayText(dayStart.value);
  try {
    const [response, dayPhotos] = await Promise.all([
      // A read-only demo camera whose recordings are not open to visitors: its photos only
      props.camera.playbackOpen === false
        ? Promise.resolve({ data: { data: [] } })
        : api.getRecords(props.camera.deviceSerial, `${day} 00:00:00`, `${day} 23:59:59`),
      loadPhotos(),
    ]);
    if (!isLatest()) return;
    photos.value = dayPhotos;
    const result = response.data;
    const list = Array.isArray(result.data) ? result.data
      : Array.isArray(result.data?.list) ? result.data.list
        : Array.isArray(result.list) ? result.list : [];
    records.value = list;
  } catch (error) {
    if (isLatest()) ElNotification({ title: t('common.error'), message: error.response?.data?.message || error.message, type: 'error' });
  } finally {
    if (isLatest()) loading.value = false;
  }
};

const playClip = (clip) => {
  playing.value = clip;
  emit('play-playback', {
    startTime: clip.raw.startTime || clip.raw.beginTime,
    stopTime: clip.raw.endTime || clip.raw.stopTime,
  });
  nextTick(() => {
    stripRef.value?.$el?.querySelector(`[data-clip="${clip.key}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
};

// A click on the timeline plays the clip at that time, or the next one after it
const onTimelineClick = (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  const at = new Date(dayStart.value.getTime() + ((event.clientX - rect.left) / rect.width) * 86400000);
  const clip = clips.value.find(c => c.start <= at && c.end >= at) || clips.value.find(c => c.start >= at);
  if (clip) playClip(clip);
};

const minuteOf = (date) => Math.round((date - dayStart.value) / 60000);

// Keyboard on the timeline: arrows go to the previous / next clip, Page Up / Down an hour,
// Home / End the first / last clip of the day
const TIMELINE_KEYS = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
const onTimelineKey = (event) => {
  const list = clips.value;
  if (!list.length || !TIMELINE_KEYS.includes(event.key)) return;
  event.preventDefault();
  const i = playing.value ? list.findIndex(c => c.key === playing.value.key) : -1;
  const later = list[Math.min(list.length - 1, i + 1)];
  const earlier = list[i < 0 ? list.length - 1 : Math.max(0, i - 1)];
  const hourAway = (hours) => {
    const at = new Date((playing.value?.start || dayStart.value).getTime() + hours * 3600000);
    return hours > 0 ? list.find(c => c.start >= at) : list.findLast(c => c.start <= at);
  };
  const next = {
    ArrowRight: later,
    ArrowUp: later,
    ArrowLeft: earlier,
    ArrowDown: earlier,
    PageUp: hourAway(1),
    PageDown: hourAway(-1),
    Home: list[0],
    End: list.at(-1)
  }[event.key];
  if (next && next.key !== playing.value?.key) playClip(next);
};

const setZoom = async (direction) => {
  const i = ZOOMS.indexOf(zoom.value) + direction;
  if (i < 0 || i >= ZOOMS.length) return;
  zoom.value = ZOOMS[i];
  await nextTick();
  // Keep the playing clip (or now) in view
  const box = timelineScroll.value;
  if (box) {
    const focus = playing.value ? percentOf(playing.value.start) : (isToday.value ? percentOf(new Date()) : 50);
    box.scrollLeft = (focus / 100) * box.scrollWidth - box.clientWidth / 2;
  }
};

const shiftDay = (days) => {
  const d = new Date(searchDate.value);
  d.setDate(d.getDate() + days);
  if (d.getTime() <= Date.now()) searchDate.value = d;
};

const backToLive = () => {
  playing.value = null;
  emit('back-to-live');
};

watch(searchDate, () => {
  playing.value = null;
  searchRecords();
});
watch(() => props.camera?.deviceSerial, (serial, old) => {
  if (serial && serial !== old) {
    playing.value = null;
    searchRecords();
  }
});
onMounted(searchRecords);
</script>

<style scoped>
.playback__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.playback__title-icon {
  color: var(--el-color-primary);
}
.playback__meta {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.playback__date {
  width: 150px;
}
.playback__clip {
  flex: 0 0 auto;
  width: 148px;
  cursor: pointer;
  border-radius: var(--el-border-radius-base);
  border: 2px solid transparent;
  transition: border-color 0.2s;
}
.playback__clip:hover,
.playback__clip:focus-visible {
  border-color: var(--el-color-primary-light-5);
  outline: none;
}
.playback__clip.is-playing {
  border-color: var(--el-color-primary);
}
.playback__thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: calc(var(--el-border-radius-base) - 2px);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--el-fill-color-dark);
  color: var(--el-text-color-secondary);
}
.playback__badge {
  position: absolute;
  top: 4px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  background-color: var(--el-overlay-color-light);
  color: var(--el-color-white);
}
.playback__badge--start {
  left: 4px;
}
.playback__badge--duration {
  right: 4px;
}
.playback__play {
  position: absolute;
  color: var(--el-color-white);
  opacity: 0.85;
}
.playback__timeline-scroll {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 4px;
}
.playback__timeline {
  position: relative;
  height: 46px;
  min-width: 100%;
  cursor: pointer;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
.playback__span {
  position: absolute;
  top: 6px;
  height: 14px;
  border-radius: 3px;
  background-color: var(--el-color-primary-light-5);
}
.playback__span.is-playing {
  background-color: var(--el-color-primary);
}
.playback__cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background-color: var(--el-color-primary);
  pointer-events: none;
}
.playback__cursor-label {
  position: absolute;
  top: -2px;
  left: 4px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  background-color: var(--el-color-primary);
  color: var(--el-color-white);
}
.playback__tick {
  position: absolute;
  bottom: 0;
  height: 10px;
  border-left: 1px solid var(--el-border-color-darker);
  pointer-events: none;
}
.playback__tick span {
  position: absolute;
  bottom: 10px;
  left: 3px;
  font-size: 10px;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
}
</style>
