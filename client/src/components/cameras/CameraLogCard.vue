<template>
  <el-card shadow="never" data-test="camera-log">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <span class="log-title">{{ t('cameraLog.title') }}</span>
          <el-tag v-if="state.on || state.requested" type="success" effect="light" round size="small">
            {{ state.until ? t('cameraLog.onUntil', { time: timeText(state.until) }) : t('cameraLog.on') }}
          </el-tag>
          <el-tag v-else type="info" effect="light" round size="small">{{ t('cameraLog.off') }}</el-tag>
          <el-tag v-if="state.lastCrash" type="danger" effect="light" round size="small" class="cursor-pointer" data-test="log-crash" @click="openCrashes">
            {{ t('cameraLog.lastCrash', { reason: reasonText(state.lastCrash.reason), time: dateText(state.lastCrash.at) }) }}
          </el-tag>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <template v-if="!readOnly">
            <el-select v-model="level" size="small" class="!w-32" :aria-label="t('cameraLog.level')">
              <el-option v-for="l in LEVELS" :key="l" :value="l" :label="t(`cameraLog.levels.${l}`)" />
            </el-select>
            <el-select v-model="minutes" size="small" class="!w-28" :aria-label="t('cameraLog.duration')">
              <el-option v-for="m in [5, 15, 30, 60]" :key="m" :value="m" :label="t('cameraLog.minutes', { n: m })" />
            </el-select>
            <el-button type="primary" size="small" :icon="VideoPlay" :loading="starting" data-test="log-start" @click="start">
              {{ state.on || state.requested ? t('cameraLog.extend') : t('cameraLog.start') }}
            </el-button>
            <el-button v-if="state.on || state.requested" size="small" :icon="VideoPause" :loading="stopping" @click="stop">{{ t('cameraLog.stop') }}</el-button>
          </template>
          <el-button size="small" :icon="Download" :disabled="!lines.length" @click="download">{{ t('cameraLog.download') }}</el-button>
        </div>
      </div>
    </template>

    <el-alert v-if="state.requested && !state.on" type="info" :closable="false" show-icon :title="t('cameraLog.waiting')" class="mb-3" />

    <div class="flex flex-wrap items-center gap-2 mb-2">
      <el-segmented v-model="show" :options="showOptions" size="small" />
      <el-input v-model="query" size="small" clearable :prefix-icon="Search" :placeholder="t('cameraLog.search')" class="!w-56" />
      <el-switch v-model="paused" size="small" :active-text="t('cameraLog.pause')" />
      <span class="log-meta">{{ t('cameraLog.count', { n: visible.length }) }}</span>
    </div>

    <div ref="box" class="log-box" data-test="log-lines" @scroll="onScroll">
      <div v-if="!visible.length" class="log-empty">{{ loading ? t('common.loading') : t('cameraLog.empty') }}</div>
      <div v-for="(l, i) in visible" :key="i" class="log-line" :class="`log-line--${l.lvl}`">
        <span class="log-time">{{ clockText(l.at) }}</span>
        <span class="log-lvl">{{ LETTERS[l.lvl] }}</span>
        <span v-if="l.tag" class="log-tag">{{ l.tag }}</span>
        <span class="log-msg">{{ l.msg }}</span>
      </div>
    </div>
    <p class="log-meta mt-2">{{ t('cameraLog.hint') }}</p>

    <!-- Crash reports -->
    <el-dialog v-model="crashVisible" :title="t('cameraLog.crashesTitle')" width="min(720px, 96vw)" append-to-body>
      <el-empty v-if="!crashes.length" :description="t('cameraLog.noCrashes')" :image-size="56" />
      <el-collapse v-else>
        <el-collapse-item v-for="c in crashes" :key="c.id" :name="c.id">
          <template #title>
            <div class="flex flex-wrap items-center gap-2">
              <el-tag type="danger" effect="light" round size="small">{{ reasonText(c.reason) }}</el-tag>
              <span>{{ dateText(c.at) }}</span>
              <span class="log-meta">{{ t('cameraLog.firmware', { v: c.fw || '?' }) }}</span>
            </div>
          </template>
          <el-descriptions v-if="c.coredump" :column="1" size="small" border class="mb-2">
            <el-descriptions-item :label="t('cameraLog.task')">{{ c.coredump.task || '--' }}</el-descriptions-item>
            <el-descriptions-item label="PC"><span class="font-mono">{{ c.coredump.pc || '--' }}</span></el-descriptions-item>
            <el-descriptions-item :label="t('cameraLog.backtrace')">
              <span class="font-mono break-all">{{ (c.coredump.backtrace || []).join(' ') || '--' }}</span>
            </el-descriptions-item>
          </el-descriptions>
          <p v-else class="log-meta mb-2">{{ t('cameraLog.noCoredump') }}</p>
          <pre class="log-box log-pre">{{ c.logTail || t('cameraLog.noTail') }}</pre>
        </el-collapse-item>
      </el-collapse>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { VideoPlay, VideoPause, Download, Search } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useNotifications } from '@/composables/useNotifications';
import { requestErrorText } from '@/utils/requestError';
import { mergeLogLines } from '@/utils/cameraLog';

/**
 * A CamOS camera's console log, sent on request (firmware 0.8.0+): on for a while at a level, the lines as they come
 * (over the notification stream while this card is open, with a slower check as a fallback), filter, search, pause,
 * download, and how the previous boot ended when it crashed. Secrets are removed on the camera.
 */
const props = defineProps({
  camera: { type: Object, required: true },
  // A visitor's demo camera: the lines (new ones every 15 s), never start, stop or watch
  readOnly: { type: Boolean, default: false }
});
const { t, te, locale } = useI18n();
const { onStreamEvent } = useNotifications();

const LEVELS = ['error', 'warn', 'info', 'debug'];
const LETTERS = ['', 'E', 'W', 'I', 'D', 'V'];
const MAX_LINES = 3000;

const lines = ref([]);
const state = reactive({ on: false, requested: false, until: null, level: null, lastCrash: null });
const level = ref('info');
const minutes = ref(15);
const show = ref(3);
const query = ref('');
const paused = ref(false);
const loading = ref(false);
const starting = ref(false);
const stopping = ref(false);
const box = ref(null);

const showOptions = computed(() => [
  { value: 3, label: t('cameraLog.showAll') },
  { value: 2, label: t('cameraLog.showWarn') },
  { value: 1, label: t('cameraLog.showError') }
]);
const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  const max = show.value === 3 ? 5 : show.value; // all, warnings and errors, errors
  return lines.value.filter(l => l.lvl <= max
    && (!q || l.msg.toLowerCase().includes(q) || (l.tag || '').toLowerCase().includes(q)));
});

const serial = () => props.camera?.deviceSerial;
const clockText = (d) => new Date(d).toLocaleTimeString(locale.value, { hour12: false });
const timeText = (d) => new Date(d).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit', hour12: false });
const dateText = (d) => new Date(d).toLocaleString(locale.value);
const reasonText = (r) => (te(`cameraLog.reasons.${r}`) ? t(`cameraLog.reasons.${r}`) : r || '?');

function applyState(s) {
  if (s) Object.assign(state, s);
}

function add(newLines) {
  lines.value = mergeLogLines(lines.value, newLines, MAX_LINES);
  if (!paused.value) nextTick(scrollDown);
}

function scrollDown() {
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}

// Scrolling up pauses following; back at the bottom follows again
function onScroll() {
  const el = box.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  if (!atBottom && !paused.value) paused.value = true;
}
watch(paused, (p) => { if (!p) nextTick(scrollDown); });

async function load() {
  if (!serial()) return;
  loading.value = true;
  try {
    const res = await api.getCameraLog(serial(), { limit: 1000 });
    lines.value = [];
    add(res.data.lines || []);
    applyState(res.data.state);
    if (res.data.state?.level) level.value = LEVELS.includes(res.data.state.level) ? res.data.state.level : 'info';
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  } finally {
    loading.value = false;
  }
}

// New lines: the stream while watching; a check every 15 s in case the stream is not there
async function poll() {
  const last = lines.value[lines.value.length - 1];
  try {
    const res = await api.getCameraLog(serial(), last ? { since: last.at, limit: 1000 } : { limit: 1000 });
    add(res.data.lines || []);
    applyState(res.data.state);
  } catch {
    // the next check tries again
  }
}

async function heartbeat() {
  try {
    const res = await api.watchCameraLog(serial(), true);
    applyState(res.data.state);
  } catch {
    // not fatal
  }
}

let offStream = null;
let watchTimer = null;
let pollTimer = null;
function follow() {
  stopFollowing();
  offStream = onStreamEvent('camera_log', (data) => {
    if (data?.deviceSerial !== serial()) return;
    if (data.lines?.length) add(data.lines);
    if (data.end) state.on = false;
    if (data.crash) state.lastCrash = { at: data.crash.at, reason: data.crash.reason, fw: data.crash.fw };
  });
  if (!props.readOnly) {
    heartbeat();
    watchTimer = setInterval(() => !document.hidden && heartbeat(), 60000);
  }
  pollTimer = setInterval(() => !document.hidden && (state.on || state.requested) && poll(), 15000);
}
function stopFollowing() {
  offStream?.();
  offStream = null;
  clearInterval(watchTimer);
  clearInterval(pollTimer);
}

async function start() {
  starting.value = true;
  try {
    const res = await api.startCameraLog(serial(), level.value, minutes.value);
    state.requested = true;
    state.until = res.data.until;
    state.level = res.data.level;
    ElMessage.success(res.data.sent ? t('cameraLog.started') : t('cameraLog.startedAtWake'));
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  } finally {
    starting.value = false;
  }
}

async function stop() {
  stopping.value = true;
  try {
    await api.stopCameraLog(serial());
    Object.assign(state, { on: false, requested: false, until: null });
    ElMessage.success(t('cameraLog.stopped'));
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  } finally {
    stopping.value = false;
  }
}

async function download() {
  try {
    const res = await api.downloadCameraLog(serial());
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${serial()}-log.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  }
}

const crashVisible = ref(false);
const crashes = ref([]);
async function openCrashes() {
  crashVisible.value = true;
  try {
    crashes.value = (await api.getCameraCrashes(serial())).data.crashes || [];
  } catch (err) {
    ElMessage.error(requestErrorText(t, err));
  }
}

watch(() => serial(), () => {
  load();
  follow();
}, { immediate: true });
onBeforeUnmount(() => {
  stopFollowing();
  if (serial() && !props.readOnly) api.watchCameraLog(serial(), false).catch(() => {});
});
</script>

<style scoped>
.log-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.log-meta {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.log-box {
  height: 320px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.log-pre {
  height: auto;
  max-height: 240px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.log-empty {
  color: var(--el-text-color-secondary);
  padding: 24px 0;
  text-align: center;
}
.log-line {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-regular);
}
.log-line--1 {
  color: var(--el-color-danger);
}
.log-line--2 {
  color: var(--el-color-warning);
}
.log-time,
.log-lvl {
  color: var(--el-text-color-secondary);
  margin-right: 6px;
}
.log-tag {
  font-weight: 600;
  margin-right: 6px;
}
</style>
