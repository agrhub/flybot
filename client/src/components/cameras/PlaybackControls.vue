<template>
  <div class="w-full max-w-5xl mt-5 mb-5 select-none">
    <div class="w-full grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Search Form -->
      <el-card shadow="never" class="md:col-span-1">
        <template #header>
          <span class="playback__title flex items-center gap-2">
            <el-icon class="playback__title-icon"><Calendar /></el-icon>
            {{ t('cameras.playbackTitle') }}
          </span>
        </template>
        <div class="flex flex-col gap-3">
          <el-date-picker v-model="searchDate" type="date" :placeholder="t('cameras.selectDate')" class="!w-full" />
          <el-button @click="searchRecords" :loading="loading" type="primary" :icon="Search" class="w-full">
            {{ t('cameras.queryDAS') }}
          </el-button>
          <el-button @click="backToLive" :icon="VideoCamera" class="w-full !ml-0">
            {{ t('cameras.backToLive') }}
          </el-button>
        </div>
      </el-card>

      <!-- Record List -->
      <el-card shadow="never" class="md:col-span-2">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <span class="playback__title">{{ t('cameras.sdRecords') }}</span>
            <span class="playback__meta">{{ records.length }} {{ t('cameras.clipsUnit') }}</span>
          </div>
        </template>
        <el-scrollbar height="220px" v-loading="loading">
          <el-empty
            v-if="!loading && records.length === 0"
            :image-size="64"
            :description="t('cameras.queryDAS')"
          />
          <div class="flex flex-col gap-2 pr-2">
            <div
              v-for="(clip, index) in records"
              :key="index"
              @click="playPlayback(clip)"
              class="playback__clip flex justify-between items-center gap-3 px-3 py-2.5 cursor-pointer"
            >
              <div class="flex flex-col min-w-0">
                <div class="flex items-center gap-2">
                  <span class="playback__clip-title">{{ t('cameras.clipNumber') }} #{{ index + 1 }}</span>
                  <el-tag type="success" effect="light" size="small">{{ clip.type || 'LOCAL' }}</el-tag>
                  <span v-if="getDuration(clip)" class="playback__meta font-mono">({{ getDuration(clip) }})</span>
                </div>
                <span class="playback__meta font-mono mt-0.5">{{ formatISOToTime(clip.startTime || clip.beginTime) }} - {{ formatISOToTime(clip.endTime || clip.stopTime) }}</span>
              </div>
              <el-button type="primary" circle size="small" :icon="VideoPlay" @click.stop="playPlayback(clip)" />
            </div>
          </div>
        </el-scrollbar>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/services/api'
import { ElNotification } from 'element-plus'
import { Calendar, Search, VideoCamera, VideoPlay } from '@element-plus/icons-vue'

const props = defineProps({
  camera: Object,
})

const emit = defineEmits(['play-playback', 'back-to-live'])

const { t } = useI18n()

const searchDate = ref(new Date())
const records = ref([])
const loading = ref(false)

const searchRecords = async () => {
  if (!props.camera) {
    ElNotification({ title: t('common.error'), message: t('cameras.noCameraSelected'), type: 'error' })
    return
  }
  if (!searchDate.value) {
    ElNotification({ title: t('common.error'), message: t('cameras.selectDate'), type: 'error' })
    return
  }

  loading.value = true
  records.value = []

  const d = new Date(searchDate.value);
  const startTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00:00`;
  const endTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 23:59:59`;

  try {
    const response = await api.getRecords(props.camera.deviceSerial, startTime, endTime)
    const result = response.data

    const isSuccess = (result.meta && (result.meta.code === 200 || result.meta.code === '200')) ||
                      result.code === '200' || result.code === 200

    let list = []
    if (Array.isArray(result.data)) {
      list = result.data
    } else if (Array.isArray(result.data?.list)) {
      list = result.data.list
    } else if (Array.isArray(result.list)) {
      list = result.list
    }

    if (isSuccess && list.length > 0) {
      records.value = list
      ElNotification({ title: t('common.success'), message: `${list.length} ${t('cameras.clipsUnit')}`, type: 'success' })
    } else {
      ElNotification({ title: t('common.error'), message: result.msg || result.meta?.message || t('analytics.noData'), type: 'warning' })
    }
  } catch (error) {
    ElNotification({ title: t('common.error'), message: error.message, type: 'error' })
  } finally {
    loading.value = false
  }
}

const playPlayback = (clip) => {
  emit('play-playback', {
    startTime: clip.startTime || clip.beginTime,
    stopTime: clip.endTime || clip.stopTime,
  })
}

const backToLive = () => {
  emit('back-to-live')
}

const formatISOToTime = (isoString) => {
  if (!isoString) return '--:--'
  const date = new Date(isoString)
  if (isNaN(date.getTime())) {
    const parts = isoString.split(' ')
    return parts.length > 1 ? parts[1].substring(0, 5) : isoString
  }
  return date.toTimeString().substring(0, 5)
}

const getDuration = (clip) => {
  const start = new Date(clip.startTime || clip.beginTime)
  const end = new Date(clip.endTime || clip.stopTime)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null
  const diffSec = Math.floor((end - start) / 1000)
  if (diffSec <= 0) return null
  const m = Math.floor(diffSec / 60)
  const s = diffSec % 60
  return `${m}m${s > 0 ? s + 's' : ''}`
}
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
  color: var(--el-text-color-secondary);
}
.playback__clip {
  border: 1px solid var(--el-border-color);
  border-left: 3px solid var(--el-color-primary);
  border-radius: 8px;
  background: var(--el-bg-color);
  transition: border-color 0.2s, background-color 0.2s;
}
.playback__clip:hover {
  border-color: var(--el-color-primary);
  background: var(--el-fill-color-light);
}
.playback__clip-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
</style>
