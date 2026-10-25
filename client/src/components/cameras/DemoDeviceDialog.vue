<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('demoDevice.title', { name: camera?.deviceName || camera?.deviceSerial || '' })"
    width="min(760px, 96vw)"
    append-to-body
    destroy-on-close
    data-test="demo-device"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert type="info" :closable="false" show-icon class="mb-3" :title="t('demoDevice.readOnly')" />
    <el-tabs v-model="section">
      <el-tab-pane name="info" :label="t('camosSettings.sections.info')">
        <CamosDeviceTab :camera="camera" :info="info" section="info" read-only />
      </el-tab-pane>
      <el-tab-pane name="firmware" :label="t('camosSettings.sections.firmware')">
        <CameraFirmwareCard :camera="camera" />
      </el-tab-pane>
      <el-tab-pane name="log" :label="t('camosSettings.sections.log')" data-test="demo-device-log">
        <CameraLogCard v-if="section === 'log'" :camera="camera" read-only />
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import CamosDeviceTab from './CamosDeviceTab.vue';
import CameraFirmwareCard from './CameraFirmwareCard.vue';
import CameraLogCard from './CameraLogCard.vue';

/**
 * The device details of a CamOS camera shared with visitors, when the administrator opened them
 * (Admin > System > Demo access): what the camera last reported, its firmware and its console log,
 * read-only. Owners and managers have the same in Camera settings.
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  camera: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();
const section = ref('info');

// The camera's report as the camera list gives it (no model, sensor or MAC for visitors)
const info = computed(() => {
  const d = props.camera?.device || {};
  return { fw: d.fw, net: d.net, rssi: d.rssi, battery: d.battery, power: d.power?.mode, powerLevel: d.power?.level, location: d.location, lastSeenAt: d.lastSeenAt };
});
</script>
