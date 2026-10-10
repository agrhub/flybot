<template>
  <div class="flex flex-col gap-6 w-full max-w-6xl pb-10">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <!-- Video Player (2 Cols) -->
      <div class="live-tab__viewport lg:col-span-2 bg-black rounded-lg overflow-hidden aspect-video relative group flex items-center justify-center">
        <div id="hls-video" ref="hlsContainer" class="w-full h-full object-contain hidden"></div>
        <video ref="hlsVideo" controls autoplay playsinline class="w-full h-full object-contain hidden"></video>
        <div id="ezopen-video" ref="ezopenVideo" class="w-full h-full object-contain hidden"></div>
        <div v-if="!camera || isPlaceholderVisible" class="live-tab__scrim absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
          <el-icon :size="48" class="live-tab__scrim-icon mb-3"><VideoCamera /></el-icon>
          <p class="text-sm font-medium max-w-md">{{ placeholderText }}</p>
          <el-button
            v-if="camera"
            @click="openValidateCodeDialog"
            type="primary"
            size="small"
            :icon="Key"
            class="mt-4"
          >
            {{ camera.validateCode ? t('cameras.changeCode') : t('cameras.enterCode') }}
          </el-button>
        </div>
      </div>

      <!-- Quick Info Side Cards (1 Col) -->
      <el-card shadow="never">
        <template #header>
          <span class="live-tab__card-title">{{ t('cameras.quickInfo') }}</span>
        </template>
        <el-descriptions :column="1" size="small">
          <el-descriptions-item :label="t('cameras.status')">
            <el-tag :type="camera?.status === 1 ? 'success' : 'info'" effect="light" round size="small">
              {{ camera?.status === 1 ? t('common.online') : t('common.offline') }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item :label="t('cameras.cloudService')">
            <el-tag type="success" effect="light" round size="small">{{ t('cameras.cloudConnected') }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item :label="t('cameras.currentStream')">
            <span class="inline-flex items-center gap-1.5">
              <el-tag type="success" effect="plain" size="small">HD</el-tag>
              <span class="live-tab__value">{{ currentStreamType }}</span>
            </span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('cameras.validateCode')">
            <span class="inline-flex items-center gap-1.5">
              <el-tag type="info" effect="plain" size="small" class="font-mono">
                {{ camera?.validateCode || '--' }}
              </el-tag>
              <el-tooltip v-if="camera" :content="t('cameras.updateCode')" placement="top">
                <el-button
                  @click="openValidateCodeDialog"
                  size="small"
                  text
                  circle
                  type="primary"
                  :icon="EditPen"
                />
              </el-tooltip>
            </span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('cameras.encrypted')">
            <el-tag :type="camera?.isEncrypt === 1 ? 'warning' : 'success'" effect="light" round size="small">
              {{ camera?.isEncrypt === 1 ? t('cameras.encryptOn') : t('cameras.encryptOff') }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="camera?.model || camera?.deviceType" :label="t('cameras.model')">
            <span class="live-tab__value truncate inline-block max-w-[160px] align-bottom" :title="camera?.model || camera?.deviceType">
              {{ camera?.model || camera?.deviceType }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item v-if="camera?.deviceVersion" :label="t('cameras.firmware')">
            <span class="live-tab__meta font-mono truncate inline-block max-w-[160px] align-bottom" :title="camera?.deviceVersion">
              {{ camera?.deviceVersion }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item v-if="typeof camera?.defence !== 'undefined'" :label="t('cameras.defence')">
            <el-tag :type="camera?.defence === 1 ? 'warning' : 'info'" effect="light" round size="small">
              {{ camera?.defence === 1 ? t('cameras.on') : t('cameras.off') }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>
    </div>

    <!-- Playback Controls Section -->
    <div class="w-full">
      <PlaybackControls
        :camera="camera"
        @play-playback="handlePlayPlayback"
        @back-to-live="playLiveStream"
      />
    </div>

    <!-- Verification Code Dialog -->
    <el-dialog
      v-model="validateCodeDialogVisible"
      :title="t('cameras.codeDialogTitle')"
      width="440px"
      append-to-body
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        :title="t('cameras.codeDialogDesc')"
        :description="t('cameras.codeDialogDefault')"
        class="mb-4"
      />

      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="`${t('cameras.codeDialogDeviceLabel')}: ${camera?.deviceName} (${camera?.deviceSerial})`">
          <el-input
            v-model="inputValidateCode"
            :placeholder="t('cameras.codeDialogInputPlaceholder')"
            :prefix-icon="Lock"
            maxlength="32"
            size="large"
            clearable
            @keyup.enter="handleSaveValidateCode"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="validateCodeDialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="updatingCode" @click="handleSaveValidateCode">
          {{ t('cameras.codeDialogSaveAndPlay') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import Hls from 'hls.js'
import HLSPlayer from '@ezuikit/player-hls'
import '@ezuikit/player-hls/dist/style/css.css'
import EZUIKit from 'ezuikit-js'
import api from '@/services/api'
import PlaybackControls from './PlaybackControls.vue'
import { ElNotification } from 'element-plus'
import { VideoCamera, Key, Lock, EditPen } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps({
  camera: Object
})

const emit = defineEmits(['status'])

const hlsContainer = ref(null)
const hlsVideo = ref(null)
const ezopenVideo = ref(null)
const isPlaceholderVisible = ref(true)
const placeholderText = ref(t('cameras.noCameraSelected'))
const currentStreamType = ref(t('cameras.waitingConnection'))
const currentStreamId = ref('')

const validateCodeDialogVisible = ref(false)
const inputValidateCode = ref('')
const updatingCode = ref(false)

const openValidateCodeDialog = () => {
  inputValidateCode.value = props.camera?.validateCode || ''
  validateCodeDialogVisible.value = true
}

let hlsEzPlayer = null
let hlsPlayer = null
let ezPlayer = null

// Use player.changePlayUrl to update validCode directly without destroying player
const updatePlayerValidCode = async (newCode) => {
  const code = (newCode || '').trim()

  if (ezPlayer && typeof ezPlayer.changePlayUrl === 'function') {
    try {
      console.log('[EZUIKit] Updating validCode via player.changePlayUrl:', code)
      placeholderText.value = 'Re-decrypting stream with new verification code...'
      emit('status', { text: 'Decrypting...', class: 'bg-amber-50 text-amber-600 border-amber-200' })

      await ezPlayer.changePlayUrl({
        type: 'live',
        deviceSerial: props.camera?.deviceSerial,
        channelNo: 1,
        validCode: code,
        hd: true
      })

      console.log('[EZUIKit] player.changePlayUrl succeeded!')
      isPlaceholderVisible.value = false
      emit('status', { text: 'Live', class: 'bg-emerald-50 text-emerald-600 border-emerald-200' })
      return true
    } catch (err) {
      console.warn('[EZUIKit] player.changePlayUrl failed, falling back to reload stream:', err)
    }
  }

  // Fallback: if player not initialized or changePlayUrl failed, reload stream normally
  playLiveStream()
  return false
}

const handleSaveValidateCode = async () => {
  const code = inputValidateCode.value?.trim()
  if (!code) {
    ElNotification({ title: t('common.error'), message: 'Please enter verification code!', type: 'error' })
    return
  }

  updatingCode.value = true
  try {
    const res = await api.updateCameraCode(props.camera.deviceSerial, code)
    if (res.data.success) {
      ElNotification({ title: t('common.success'), message: 'Device verification code updated successfully!', type: 'success' })
      if (props.camera) {
        props.camera.validateCode = code
      }
      validateCodeDialogVisible.value = false
      await updatePlayerValidCode(code)
    } else {
      ElNotification({ title: t('common.error'), message: res.data.message || 'Failed to update code.', type: 'error' })
    }
  } catch (error) {
    ElNotification({ title: t('common.error'), message: 'Unable to update verification code.', type: 'error' })
  } finally {
    updatingCode.value = false
  }
}

const resetPlayer = () => {
  if (hlsEzPlayer) {
    try { hlsEzPlayer.destroy() } catch (e) {}
    hlsEzPlayer = null
  }
  if (hlsPlayer) {
    try { hlsPlayer.destroy() } catch (e) {}
    hlsPlayer = null
  }
  if (ezPlayer) {
    try {
      if (typeof ezPlayer.stop === 'function') ezPlayer.stop()
      if (typeof ezPlayer.destroy === 'function') ezPlayer.destroy()
    } catch (e) {}
    ezPlayer = null
  }
  if (hlsContainer.value) {
    hlsContainer.value.classList.add('hidden')
    hlsContainer.value.innerHTML = ''
  }
  if (hlsVideo.value) {
    hlsVideo.value.classList.add('hidden')
    hlsVideo.value.src = ''
  }
  if (ezopenVideo.value) {
    ezopenVideo.value.classList.add('hidden')
    ezopenVideo.value.innerHTML = ''
  }
  isPlaceholderVisible.value = true
}

const initNativeHls = (url) => {
  const video = hlsVideo.value
  if (!video) return
  video.classList.remove('hidden')

  if (Hls.isSupported()) {
    hlsPlayer = new Hls()
    hlsPlayer.loadSource(url)
    hlsPlayer.attachMedia(video)
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {})
      isPlaceholderVisible.value = false
      emit('status', { text: 'Live (HLS)', class: 'bg-emerald-50 text-emerald-600 border-emerald-200' })
    })
    hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
      console.warn('[Hls.js] Error:', data)
    })
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
    video.play().catch(() => {})
    isPlaceholderVisible.value = false
    emit('status', { text: 'Live (HLS)', class: 'bg-emerald-50 text-emerald-600 border-emerald-200' })
  }
}

const initHls = (url, accessToken, areaDomain, requestedDecoder = 'soft') => {
  resetPlayer()
  isPlaceholderVisible.value = false
  const container = hlsContainer.value
  if (!container) return
  container.classList.remove('hidden')

  let targetDomain = areaDomain || 'https://ivnopen.ezvizlife.com'

  try {
    const hlsOptions = {
      id: 'hls-video',
      container: container,
      url: url,
      accessToken: accessToken || props.camera?.accessToken || '',
      domain: targetDomain,
      staticPath: window.location.origin + '/ezuikit_hls',
      autoPlay: true,
      muted: true,
      isLive: true,
      isEzviz: true,
      decoderType: requestedDecoder, // 'soft' (WASM + WebGL) supports full H.265/HEVC and H.264
      height: 360,
      language: 'en',
      template: 'pcLive',
      loggerOptions: {
        name: 'EZ-HLS',
        level: 'INFO',
        showTime: true
      }
    }

    console.log(`[EZUIKit HLS] Initializing @ezuikit/player-hls (decoderType: ${requestedDecoder}) with options:`, hlsOptions)
    hlsEzPlayer = new HLSPlayer(hlsOptions)

    if (hlsEzPlayer && hlsEzPlayer.on) {
      const handleStreamReady = () => {
        console.log('[EZUIKit HLS] Video playback started successfully')
        isPlaceholderVisible.value = false
        emit('status', {
          text: `Live (HLS ${requestedDecoder === 'soft' ? 'WASM' : 'MSE'})`,
          class: 'success'
        })
      }

      hlsEzPlayer.on('play', handleStreamReady)
      hlsEzPlayer.on('timeupdate', handleStreamReady)
      hlsEzPlayer.on('videoInfo', (info) => {
        console.log('[EZUIKit HLS] Video info:', info)
        handleStreamReady()
      })
      hlsEzPlayer.on('initSuccess', (res) => {
        console.log('[EZUIKit HLS] Decoder initialized successfully:', res)
      })
      hlsEzPlayer.on('error', (err) => {
        console.error('[EZUIKit HLS] Error:', err)
        // If error occurs in MSE or auto mode, immediately fallback to soft (WASM)
        if (requestedDecoder !== 'soft') {
          console.warn('[EZUIKit HLS] Hardware decoding error, switching to software decoding (WASM)...')
          initHls(url, accessToken, areaDomain, 'soft')
        }
      })
      hlsEzPlayer.on('MEDIA_ERROR', (err) => {
        console.warn('[EZUIKit HLS] Media Error:', err)
        if (requestedDecoder !== 'soft') {
          initHls(url, accessToken, areaDomain, 'soft')
        }
      })
      hlsEzPlayer.on('loading', () => {
        emit('status', { text: 'Loading HLS...', class: 'primary' })
      })
    }
  } catch (err) {
    console.error('[EZUIKit HLS] Initialization failed, falling back to native hls.js:', err)
    initNativeHls(url)
  }
}

const initEzOpen = (url, accessToken, areaDomain, customCode) => {
  resetPlayer()
  isPlaceholderVisible.value = false
  const container = ezopenVideo.value
  if (!container) return
  container.classList.remove('hidden')

  // Only retrieve verification code when camera encryption is ON (isEncrypt === 1)
  const isEncrypted = props.camera?.isEncrypt === 1
  let code = isEncrypted ? (customCode || props.camera?.validateCode || '').trim() : ''
  // Exclude if Chrome autofilled domain email
  if (code.includes('.') || code.includes('@')) {
    code = ''
  }

  // Ensure initial URL is clean, NO validCode in URL
  const cleanUrl = url;

  // Use proper areaDomain
  let targetDomain = 'https://open.ezvizlife.com';
  try {
    const playerOptions = {
      id: 'ezopen-video',
      container: container,
      accessToken,
      token: accessToken,
      url: cleanUrl,
      template: 'pcLive',
      height: 360,
      language: 'en',
      scaleMode: 1,
      sdkType: 'custom',//base or custom
      staticPath: window.location.origin + '/ezuikit_static',
      env: {
        domain: targetDomain
      },
      handleError: async (error) => {
        console.error('EZUIKit error:', error)
        const isPlayback = cleanUrl.includes('.rec')
        // When video stream is encrypted (nErrorCode 5)
        if (error.type === 'handleRunTimeInfoError' && error.data?.nErrorCode === 5) {
          if (code && ezPlayer && typeof ezPlayer.changePlayUrl === 'function') {
            console.log('[EZUIKit] Encrypted video (nErrorCode 5), triggering changePlayUrl with code:', code)
            try {
              const changeOpts = { validCode: code, code, validateCode: code }
              if (isPlayback) {
                changeOpts.type = 'playback'
              } else {
                changeOpts.type = 'live'
              }
              await ezPlayer.changePlayUrl(changeOpts)
              isPlaceholderVisible.value = false
              emit('status', isPlayback
                ? { text: 'Playback', class: 'primary' }
                : { text: 'Live', class: 'success' }
              )
              return
            } catch (err) {
              console.warn('[EZUIKit] changePlayUrl failed:', err)
            }
          }
          isPlaceholderVisible.value = true
          placeholderText.value = `Video encryption is enabled. Decryption attempted with code [${code || 'empty'}]. Please click "Change Code" to update.`
          emit('status', { text: 'Code Required', class: 'warning' })
          openValidateCodeDialog()
        } else if (error.retcode === 5411 || error.code === 5411) {
          isPlaceholderVisible.value = true
          placeholderText.value = 'EZVIZ: No permission to view device (Error 5411). Please check device sharing permissions or verification code.'
          emit('status', { text: 'Permission Error (5411)', class: 'danger' })
        } else if (error.code === '10001' || error.msg?.includes('illegal parameter')) {
          isPlaceholderVisible.value = true
          placeholderText.value = 'Invalid ezopen stream parameters (Error 10001).'
          emit('status', { text: 'ezopen Error', class: 'danger' })
        } else {
          isPlaceholderVisible.value = true
          placeholderText.value = error.msg || 'Connection error to EZVIZ camera stream.'
          emit('status', { text: 'Stream Error', class: 'danger' })
        }
      }
    }
    ezPlayer = new EZUIKit.EZUIKitPlayer(playerOptions)

    if (ezPlayer && ezPlayer.on) {
      ezPlayer.on(EZUIKit.EZUIKitPlayer.EVENTS?.firstFrameDisplay || 'firstFrameDisplay', () => {
        isPlaceholderVisible.value = false
        const isPlayback = cleanUrl.includes('.rec')
        emit('status', isPlayback
          ? { text: 'Playback', class: 'primary' }
          : { text: 'Live', class: 'success' }
        )
      })
    }

  } catch (err) {
    console.error('EZUIKit init error:', err)
    isPlaceholderVisible.value = true
    placeholderText.value = 'Player initialization error: ' + err.message
  }
}

const playLiveStream = async () => {
  resetPlayer()
  if (!props.camera) {
    placeholderText.value = 'Please select a camera to start'
    emit('status', { text: 'Ready', class: 'info' })
    currentStreamType.value = 'No device selected'
    return
  }

  // Automatically open popup only when camera is ENCRYPTED (isEncrypt === 1) and missing validateCode
  if (props.camera?.isEncrypt === 1 && !props.camera?.validateCode) {
    placeholderText.value = 'Camera encryption is enabled but no verification code is set. Please enter code to decrypt.'
    emit('status', { text: 'Code Required', class: 'warning' })
    currentStreamType.value = 'Code Required'
    openValidateCodeDialog()
    return
  }

  placeholderText.value = 'Loading live stream...'
  emit('status', { text: 'Connecting...', class: 'warning' })

  // Check if camera has pre-configured deviceUrl
  if (props.camera.deviceUrl && props.camera.accessToken && props.camera.areaDomain) {
    const url = props.camera.deviceUrl
    if (url.includes('.m3u8')) {
      initHls(url, props.camera.accessToken, props.camera.areaDomain)
    } else if (url.includes('ezopen://')) {
      initEzOpen(url, props.camera.accessToken, props.camera.areaDomain, props.camera.validateCode)
    }
    emit('status', { text: 'Live', class: 'success' })
    currentStreamType.value = 'Live'
    return
  }

  try {
    // Always request HD main stream (quality = 1) when viewing single camera detail
    const res = await api.getLiveStream(props.camera.deviceSerial, currentStreamId.value, 1)
    const data = res.data
    if (data.code === '200' && data.data?.url) {
      if (data.data?.id) {
        currentStreamId.value = data.data.id
      }
      if (typeof data.data.isEncrypt !== 'undefined' && props.camera) {
        props.camera.isEncrypt = data.data.isEncrypt
      }
      if (data.data.url.includes('.m3u8')) {
        initHls(data.data.url, data.data.accessToken, data.data.areaDomain)
      } else if (data.data.url.includes('ezopen://')) {
        initEzOpen(data.data.url, data.data.accessToken, data.data.areaDomain, data.data.validateCode || props.camera.validateCode)
      }
      emit('status', { text: 'Live', class: 'success' })
      currentStreamType.value = 'Live'
    } else if (data.code === '60019') {
      if (props.camera) {
        props.camera.isEncrypt = 1
      }
      placeholderText.value = 'Camera encryption is enabled but no verification code is set. Please enter code to decrypt.'
      emit('status', { text: 'Code Required', class: 'warning' })
      currentStreamType.value = 'Code Required'
      openValidateCodeDialog()
    } else {
      placeholderText.value = data.msg || 'Unable to retrieve stream.'
      emit('status', { text: 'Offline', class: 'danger' })
      currentStreamType.value = 'Disconnected'
    }
  } catch (error) {
    placeholderText.value = 'Stream system error.'
    emit('status', { text: 'Error', class: 'danger' })
    currentStreamType.value = 'Stream Error'
  }
}

const handlePlayPlayback = async ({ startTime, stopTime }) => {
  resetPlayer()
  if (!props.camera) return

  placeholderText.value = 'Loading playback recording...'
  emit('status', { text: 'Loading Playback...', class: 'info' })

  try {
    const res = await api.getPlaybackStream(props.camera.deviceSerial, startTime, stopTime, currentStreamId.value)
    const data = res.data
    if (data.code === '200' && data.data?.url) {
      if (data.data?.id) {
        currentStreamId.value = data.data.id
      }
      if (data.data.url.includes('.m3u8')) {
        initHls(data.data.url, data.data.accessToken, data.data.areaDomain)
      } else if (data.data.url.includes('ezopen://')) {
        initEzOpen(data.data.url, data.data.accessToken, data.data.areaDomain, data.data.validateCode || props.camera.validateCode)
      }
      emit('status', { text: 'Playback', class: 'info' })
      currentStreamType.value = `Playback (${startTime.slice(11, 16)} - ${stopTime.slice(11, 16)})`
    } else {
      ElNotification({ title: t('common.error'), message: data.msg || 'Unable to load playback stream.', type: 'error' })
      placeholderText.value = 'Unable to replay this video segment.'
      emit('status', { text: 'Playback Error', class: 'danger' })
    }
  } catch (error) {
    ElNotification({ title: t('common.error'), message: 'Error requesting playback stream.', type: 'error' })
    placeholderText.value = 'Error requesting playback stream.'
  }
}

watch(
  () => props.camera,
  (newCam, oldCam) => {
    if (newCam && newCam.deviceSerial !== oldCam?.deviceSerial) {
      playLiveStream()
    } else if (newCam && oldCam && newCam.validateCode !== oldCam.validateCode) {
      updatePlayerValidCode(newCam.validateCode)
    } else if (!newCam) {
      resetPlayer()
    }
  },
  { deep: true }
)

onMounted(() => {
  if (props.camera) {
    playLiveStream()
  }
})

onUnmounted(() => {
  if (props.camera?.deviceSerial) {
    api.disableStream(props.camera.deviceSerial, currentStreamId.value).catch(() => {})
  }
  resetPlayer()
})
</script>

<style scoped>
.live-tab__viewport {
  border: 1px solid var(--el-border-color);
}
/* Placeholder sits on top of the black video area, so it uses a dark scrim with light text in both themes */
.live-tab__scrim {
  background: rgba(0, 0, 0, 0.85);
  color: rgba(255, 255, 255, 0.8);
}
.live-tab__scrim-icon {
  color: rgba(255, 255, 255, 0.55);
}
.live-tab__card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.live-tab__value {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}
.live-tab__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
