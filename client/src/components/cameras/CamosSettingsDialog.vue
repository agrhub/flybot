<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('camosSettings.title', { name: camera?.deviceName || camera?.deviceSerial || '' })"
    width="min(760px, 96vw)"
    append-to-body
    destroy-on-close
    data-test="camos-settings"
    @update:model-value="emit('update:modelValue', $event)"
    @open="load"
  >
    <div v-if="loading" class="py-10 flex justify-center"><el-icon class="is-loading" :size="24"><Loading /></el-icon></div>
    <el-alert v-else-if="loadError" type="error" :closable="false" show-icon :title="loadError" />
    <template v-else-if="data">
      <!-- Live preview: see what a change does; on the Motion tab, draw the detection area on it -->
      <div class="camos-settings__preview" data-test="settings-preview">
        <div v-if="previewConfig" class="absolute inset-0">
          <KvsViewer :config="previewConfig" quality="auto" :network="camera?.device?.net || ''" :name="camera?.deviceSerial || 'camera'" />
        </div>
        <img v-else-if="thumbnail" :src="thumbnail" alt="" class="absolute inset-0 w-full h-full object-contain opacity-80" />
        <div v-if="!previewConfig" class="camos-settings__preview-note">{{ previewNote }}</div>
        <AreaSelector v-if="section === 'motion' && areaField" v-model="areaForm[areaField.path]" />
      </div>
      <p v-if="data.camera?.sensor" class="camos-settings__hint">{{ t('camosSettings.sensor', { sensor: data.camera.sensor, w: data.camera.maxW, h: data.camera.maxH }) }}</p>
      <p class="camos-settings__hint">{{ t('camosSettings.intro') }}</p>
      <el-alert v-if="data.errors?.length" type="warning" :closable="false" show-icon class="mb-3"
        :title="t('camosSettings.cameraErrors', { list: data.errors.map(e => `${e.path || e.key}: ${e.code || e.error}`).join(', ') })" />
      <el-tabs v-model="section">
        <el-tab-pane v-for="s in data.sections" :key="s" :name="s" :label="t(`camosSettings.sections.${s}`)">
          <el-form label-position="left" label-width="auto" size="small" @submit.prevent>
            <el-form-item v-for="f in fieldsOf(s)" :key="f.path" :label="fieldLabel(f)" :data-test="`setting-${f.path}`">
              <div class="flex flex-wrap items-center gap-2 w-full">
                <!-- int -->
                <template v-if="f.type === 'int'">
                  <el-input-number v-model="form[f.path]" :min="f.min" :max="f.max" :step="1" step-strictly controls-position="right" :placeholder="f.nullable ? t('camosSettings.automatic') : ''" class="!w-40" />
                  <span class="camos-settings__range">{{ f.min }}–{{ f.max }}</span>
                </template>
                <!-- bool -->
                <el-switch v-else-if="f.type === 'bool'" v-model="form[f.path]" />
                <!-- enum -->
                <el-select v-else-if="f.type === 'enum' || f.type === 'resolution'" v-model="form[f.path]" :clearable="f.nullable" :placeholder="f.nullable ? t('camosSettings.automatic') : ''" class="!w-56">
                  <el-option v-for="v in f.values" :key="v" :value="v" :label="valueLabel(f, v)" />
                </el-select>
                <!-- window: capture between two times, or all day -->
                <template v-else-if="f.type === 'window'">
                  <el-switch v-model="windowOn[f.path]" :active-text="t('camosSettings.window.between')" :inactive-text="t('camosSettings.window.allDay')" />
                  <template v-if="windowOn[f.path]">
                    <el-time-select v-model="windowForm[f.path].from" start="00:00" end="23:30" step="00:30" class="!w-28" />
                    <span>–</span>
                    <el-time-select v-model="windowForm[f.path].to" start="00:00" end="23:30" step="00:30" class="!w-28" />
                  </template>
                </template>
                <!-- area: x, y, w, h in percent of the picture -->
                <template v-else-if="f.type === 'area'">
                  <el-input-number v-for="(k, i) in ['x', 'y', 'w', 'h']" :key="k" v-model="areaForm[f.path][i]" :min="0" :max="100" controls-position="right" class="!w-24" :placeholder="k" />
                  <span class="camos-settings__range">% · {{ t('camosSettings.drawHint') }}</span>
                </template>
                <el-tag v-if="data.values[f.path]?.pending" type="warning" effect="light" size="small" round>{{ t('camosSettings.pending') }}</el-tag>
              </div>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
      <p class="camos-settings__hint mt-2">{{ data.reportedAt ? t('camosSettings.reportedAt', { time: new Date(data.reportedAt).toLocaleString() }) : t('camosSettings.neverReported') }}</p>
    </template>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="!data || !changedCount" data-test="camos-settings-save" @click="save">
        {{ changedCount ? t('camosSettings.saveCount', { n: changedCount }) : t('camosSettings.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import { Loading } from '@element-plus/icons-vue';
import api from '@/services/api';
import KvsViewer from './KvsViewer.vue';
import AreaSelector from './AreaSelector.vue';
import { requestErrorText } from '@/utils/requestError';
import { changedSettings, effectiveValue } from '@/utils/camosSettingsForm';

/**
 * The web console's settings of a camos-esp32-trap camera, from FlyBot (GET/PUT /api/cameras/:serial/device-settings).
 * The form is built from the server's field list; a field shows "waiting for the camera" until the camera reports
 * the value applied. Only changed fields are sent.
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  camera: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue']);
const { t, te } = useI18n();

const loading = ref(false);
const saving = ref(false);
const loadError = ref('');
const data = ref(null);
const section = ref('capture');
const form = reactive({});
const windowOn = reactive({});
const windowForm = reactive({});
const areaForm = reactive({});
let initial = {};

// Preview: the camera's live view when it is online and has it, else its last photo
const previewConfig = ref(null);
const previewNote = ref('');
const thumbnail = computed(() => {
  const url = props.camera?.thumbnailUrl || props.camera?.picUrl;
  return url ? api.getImageUrl(url) : '';
});
const areaField = computed(() => (data.value?.fields || []).find((f) => f.type === 'area') || null);
async function loadPreview() {
  previewConfig.value = null;
  const cam = props.camera;
  if (!cam || cam.status !== 1 || cam.device?.sleeping || cam.device?.liveSupported === false) {
    previewNote.value = t('camosSettings.previewOff');
    return;
  }
  previewNote.value = t('camosSettings.previewLoading');
  try {
    const res = await api.getCameraLive(cam.deviceSerial);
    if (res.data?.platform === 'kinesis' && res.data.channelARN) previewConfig.value = res.data;
    else previewNote.value = t('camosSettings.previewOff');
  } catch {
    previewNote.value = t('camosSettings.previewOff');
  }
}

const fieldsOf = (s) => (data.value?.fields || []).filter((f) => f.section === s);
const fieldLabel = (f) => (te(`camosSettings.fields.${f.path}`) ? t(`camosSettings.fields.${f.path}`) : f.path);
const valueLabel = (f, v) => (te(`camosSettings.values.${f.path}.${v}`) ? t(`camosSettings.values.${f.path}.${v}`) : v);

function fill(view) {
  data.value = view;
  initial = {};
  for (const f of view.fields) {
    const v = effectiveValue(view.values[f.path]);
    initial[f.path] = v;
    if (f.type === 'window') {
      windowOn[f.path] = !!v;
      windowForm[f.path] = { from: v?.from || '06:00', to: v?.to || '18:00' };
    } else if (f.type === 'area') {
      areaForm[f.path] = Array.isArray(v) ? [...v] : [0, 0, 100, 100];
    } else {
      form[f.path] = v ?? (f.type === 'bool' ? false : undefined);
    }
  }
}

// The form's current value per field, in the shape the server checks
const current = computed(() => {
  const out = {};
  for (const f of data.value?.fields || []) {
    if (f.type === 'window') out[f.path] = windowOn[f.path] ? { ...windowForm[f.path] } : null;
    else if (f.type === 'area') out[f.path] = [...(areaForm[f.path] || [])];
    else out[f.path] = form[f.path] === undefined ? null : form[f.path];
  }
  return out;
});
const changes = computed(() => (data.value ? changedSettings(data.value.fields, initial, current.value) : {}));
const changedCount = computed(() => Object.keys(changes.value).length);

async function load() {
  if (!props.camera?.deviceSerial) return;
  loading.value = true;
  loadError.value = '';
  try {
    const res = await api.getDeviceSettings(props.camera.deviceSerial);
    fill(res.data);
    section.value = res.data.sections?.[0] || 'capture';
    loadPreview();
  } catch (err) {
    loadError.value = requestErrorText(t, err, t('camosSettings.loadFailed'));
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const res = await api.updateDeviceSettings(props.camera.deviceSerial, changes.value);
    fill(res.data);
    ElNotification({ title: t('common.success'), message: t('camosSettings.saved'), type: 'success' });
  } catch (err) {
    const list = err.response?.data?.errors;
    const message = Array.isArray(list) && list.length
      ? t('camosSettings.invalid', { list: list.map((e) => fieldLabel({ path: e.path })).join(', ') })
      : requestErrorText(t, err, t('camosSettings.saveFailed'));
    ElNotification({ title: t('common.error'), message, type: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.camos-settings__preview {
  position: relative;
  width: 100%;
  max-width: 520px;
  aspect-ratio: 4 / 3;
  margin: 0 auto 10px;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}
.camos-settings__preview-note {
  position: absolute;
  inset: auto 0 0 0;
  padding: 6px 10px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.55);
}
.camos-settings__hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.camos-settings__range {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
