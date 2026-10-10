<template>
  <div class="w-full max-w-5xl mt-5 mb-5 select-none">
    <div class="w-full grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Search Form -->
      <div class="md:col-span-1 bg-[var(--el-card-bg-color)] p-5 rounded-2xl shadow-soft border border-[var(--el-border-color)]">
        <h3 class="font-bold mb-3 flex items-center text-[var(--el-text-color-primary)]">
          <svg class="w-4 h-4 mr-2 text-[var(--primary-green)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2-2v12a2 2 0 002 2z"></path></svg>
          {{ t('cameras.playbackTitle') }}
        </h3>
        <div class="space-y-3">
          <el-date-picker v-model="searchDate" type="date" :placeholder="t('cameras.selectDate')" class="!w-full" size="large" />
          <el-button @click="searchRecords" :loading="loading" type="primary" class="w-full !rounded-xl !font-bold" size="large">
            {{ t('cameras.queryDAS') }}
          </el-button>
          <el-button @click="backToLive" class="w-full !rounded-xl !ml-0" size="large">
            {{ t('cameras.backToLive') }}
          </el-button>
        </div>
      </div>

      <!-- Record List -->
      <div class="md:col-span-2 bg-[var(--el-card-bg-color)] p-5 rounded-2xl shadow-soft border border-[var(--el-border-color)] flex flex-col h-[300px]">
        <h3 class="font-bold mb-3 text-[var(--el-text-color-primary)] flex justify-between">
          <span>{{ t('cameras.sdRecords') }}</span>
          <span class="text-xs font-normal text-[var(--el-text-color-secondary)]">{{ records.length }} {{ t('cameras.clipsUnit') }}</span>
        </h3>
        <div class="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
          <div v-if="!loading && records.length === 0" class="flex flex-col items-center justify-center h-full text-slate-500 opacity-60 text-center">
            <svg class="w-12 h-12 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path></svg>
            <p class="text-[11px]">{{ t('cameras.queryDAS') }}</p>
          </div>
          <div v-for="(clip, index) in records" :key="index" @click="playPlayback(clip)" class="flex justify-between items-center p-3 bg-[var(--el-bg-color)] border border-[var(--el-border-color)] rounded-xl hover:border-[var(--primary-green)]/60 cursor-pointer border-l-4 border-l-[var(--primary-green)] text-[11px] shadow-sm transition">
            <div class="flex flex-col">
              <div class="flex items-center space-x-2">
                <span class="font-bold text-[var(--el-text-color-primary)] text-[12px]">{{ t('cameras.clipNumber') }} #{{ index + 1 }}</span>
                <span class="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[9px] font-bold">{{ clip.type || 'LOCAL' }}</span>
                <span v-if="getDuration(clip)" class="text-[10px] text-[var(--el-text-color-secondary)] font-mono">({{ getDuration(clip) }})</span>
              </div>
              <span class="text-[var(--el-text-color-secondary)] mt-0.5 font-mono">{{ formatISOToTime(clip.startTime || clip.beginTime) }} - {{ formatISOToTime(clip.endTime || clip.stopTime) }}</span>
            </div>
            <div class="bg-[var(--primary-green)] p-1.5 rounded-full text-slate-950 shadow-sm">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"></path></svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/services/api'
import { ElNotification } from 'element-plus'

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
