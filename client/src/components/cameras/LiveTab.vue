<template>
  <div class="space-y-6 w-full max-w-6xl pb-10">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <!-- Video Player (2 Cols) -->
      <div class="lg:col-span-2 bg-black rounded-[2rem] overflow-hidden aspect-video shadow-2xl relative group flex items-center justify-center border-2 border-[var(--el-border-color)]">
        <div id="hls-video" ref="hlsContainer" class="w-full h-full object-contain hidden"></div>
        <video ref="hlsVideo" controls autoplay playsinline class="w-full h-full object-contain hidden"></video>
        <div id="ezopen-video" ref="ezopenVideo" class="w-full h-full object-contain hidden"></div>
        <div v-if="!camera || isPlaceholderVisible" class="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-950/90 p-6 text-center">
          <div class="bg-slate-900/80 p-5 rounded-3xl mb-3 text-slate-400 border border-slate-800">
            <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
            </svg>
          </div>
          <p class="text-sm font-medium max-w-md">{{ placeholderText }}</p>
          <el-button
            v-if="camera"
            @click="openValidateCodeDialog"
            type="primary"
            size="small"
            class="mt-4 rounded-full shadow-lg"
          >
            <svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
            </svg>
            {{ camera.validateCode ? t('cameras.changeCode') : t('cameras.enterCode') }}
          </el-button>
        </div>
      </div>

      <!-- Quick Info Side Cards (1 Col) -->
      <div class="space-y-6">
        <div class="bg-[var(--el-card-bg-color)] rounded-[24px] p-6 border border-[var(--el-border-color)] shadow-soft">
          <h3 class="font-bold text-[var(--el-text-color-primary)] mb-4 text-xs uppercase tracking-wider text-[var(--el-text-color-secondary)]">{{ t('cameras.quickInfo') }}</h3>
          <div class="space-y-4">
            <div class="flex justify-between items-center">
              <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('cameras.status') }}</span>
              <span class="text-sm font-bold" :class="camera?.status === 1 ? 'text-emerald-400' : 'text-slate-400'">
                {{ camera?.status === 1 ? t('common.online') : t('common.offline') }}
              </span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('cameras.cloudService') }}</span>
              <span class="text-sm font-bold text-emerald-400">{{ t('cameras.cloudConnected') }}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('cameras.currentStream') }}</span>
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] font-black px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">HD</span>
                <span class="text-xs font-bold text-[var(--primary-green)]">{{ currentStreamType }}</span>
              </div>
            </div>
            <div class="flex justify-between items-center pt-2 border-t border-[var(--el-border-color)]/60">
              <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('cameras.validateCode') }}</span>
              <div class="flex items-center space-x-1.5">
                <span class="text-xs font-mono font-bold bg-[var(--el-bg-color)] px-2 py-0.5 rounded text-[var(--el-text-color-primary)] tracking-wider border border-[var(--el-border-color)]">
                  {{ camera?.validateCode || '--' }}
                </span>
                <el-button
                  v-if="camera"
                  @click="openValidateCodeDialog"
                  size="small"
                  text
                  circle
                  type="primary"
                  :title="t('cameras.updateCode')"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </el-button>
              </div>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('cameras.encrypted') }}</span>
              <span
                class="text-xs font-bold"
                :class="camera?.isEncrypt === 1 ? 'text-amber-400' : 'text-emerald-400'"
              >
                {{ camera?.isEncrypt === 1 ? t('cameras.encryptOn') : t('cameras.encryptOff') }}
              </span>
            </div>
            <div v-if="camera?.model || camera?.deviceType" class="flex justify-between items-center">
              <span class="text-xs text-[var(--el-text-color-secondary)]">Model</span>
              <span class="text-xs font-medium text-[var(--el-text-color-primary)] truncate max-w-[160px]" :title="camera?.model || camera?.deviceType">
                {{ camera?.model || camera?.deviceType }}
              </span>
            </div>
            <div v-if="camera?.deviceVersion" class="flex justify-between items-center">
              <span class="text-xs text-[var(--el-text-color-secondary)]">Firmware</span>
              <span class="text-xs font-mono text-[var(--el-text-color-secondary)] truncate max-w-[160px]" :title="camera?.deviceVersion">
                {{ camera?.deviceVersion }}
              </span>
            </div>
            <div v-if="typeof camera?.defence !== 'undefined'" class="flex justify-between items-center">
              <span class="text-xs text-[var(--el-text-color-secondary)]">{{ t('cameras.defence') }}</span>
              <span class="text-xs font-bold" :class="camera?.defence === 1 ? 'text-amber-400' : 'text-slate-500'">
                {{ camera?.defence === 1 ? t('cameras.on') : t('cameras.off') }}
              </span>
            </div>
          </div>
        </div>
      </div>
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
      :title="t('live.codeDialogTitle')"
      width="440px"
      append-to-body
      class="rounded-3xl"
    >
      <div class="space-y-4">
        <div class="bg-blue-50 dark:bg-blue-950/40 p-4 rounded-2xl text-blue-700 dark:text-blue-300 text-xs leading-relaxed flex items-start space-x-3">
          <svg class="w-5 h-5 flex-shrink-0 text-blue-500 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p class="font-bold mb-1">{{ t('live.codeDialogDesc') }}</p>
            <p>{{ t('live.codeDialogDefault') }}</p>
          </div>
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-zinc-400 mb-1.5">{{ t('live.codeDialogDeviceLabel') }}: {{ camera?.deviceName }} ({{ camera?.deviceSerial }})</label>
          <el-input
            v-model="inputValidateCode"
            :placeholder="t('live.codeDialogInputPlaceholder')"
            maxlength="32"
            size="large"
            clearable
            @keyup.enter="handleSaveValidateCode"
          >
            <template #prefix>
              <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </template>
          </el-input>
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end space-x-2 pt-2">
          <el-button @click="validateCodeDialogVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" :loading="updatingCode" @click="handleSaveValidateCode">
            {{ t('live.codeDialogSaveAndPlay') }}
          </el-button>
        </div>
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
