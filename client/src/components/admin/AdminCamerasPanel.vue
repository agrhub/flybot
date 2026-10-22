<template>
  <div>
    <PageHeader :title="t('admin.fleet.title')" :subtitle="t('admin.fleet.subtitle')">
      <template #actions>
        <el-button :icon="Guide" :disabled="!selectedCamos.length" data-test="fleet-set-channel" @click="openChannel(selectedCamos)">{{ t('admin.fleet.setChannel') }}</el-button>
        <el-button :icon="Upload" :disabled="!selectedCamos.length" @click="openRollout">
          {{ selectedCamos.length ? t('admin.fleet.updateSelected', { n: selectedCamos.length }) : t('admin.fleet.updateFirmware') }}
        </el-button>
      </template>
    </PageHeader>

    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <el-input
          v-model="filters.q"
          :placeholder="t('admin.fleet.search')"
          :prefix-icon="Search"
          clearable
          class="!w-72"
          @input="debouncedLoad"
          @clear="reload"
        />
        <el-select v-model="filters.platform" :placeholder="t('admin.fleet.platform')" clearable class="!w-36" @change="reload">
          <el-option value="camos" label="CamOS" />
          <el-option value="ezviz" label="EZVIZ" />
        </el-select>
        <el-select v-model="filters.state" :placeholder="t('admin.fleet.state')" clearable class="!w-40" @change="reload">
          <el-option v-for="s in STATES" :key="s" :value="s" :label="t(`admin.fleet.states.${s}`)" />
        </el-select>
        <el-select v-model="filters.model" :placeholder="t('admin.fleet.model')" clearable filterable class="!w-52" @change="reload">
          <el-option v-for="m in models" :key="m" :value="m" :label="m" />
        </el-select>
        <el-select v-model="filters.channel" :placeholder="t('admin.firmware.channel')" clearable class="!w-36" @change="reload">
          <el-option v-for="c in CHANNELS" :key="c" :value="c" :label="t(`firmware.channels.${c}`)" />
        </el-select>
        <el-checkbox v-model="filters.outdated" @change="reload">{{ t('admin.fleet.outdatedOnly') }}</el-checkbox>
        <el-button :icon="Refresh" @click="load">{{ t('common.refresh') }}</el-button>
      </div>

      <el-table
        v-loading="loading"
        :data="cameras"
        row-key="deviceSerial"
        style="width: 100%"
        data-test="fleet-table"
        @selection-change="(rows) => (selected = rows)"
      >
        <el-table-column type="selection" width="42" :selectable="(row) => row.platform === 'camos'" />
        <el-table-column type="expand" width="36">
          <template #default="{ row }">
            <el-descriptions :column="isMobile ? 1 : 3" size="small" border class="mx-2">
              <el-descriptions-item :label="t('admin.fleet.imei')"><span class="font-mono">{{ row.imei || '--' }}</span></el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.iccid')"><span class="font-mono">{{ row.iccid || '--' }}</span></el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.operator')">{{ row.operator || '--' }}</el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.network')">{{ networkText(row) }}</el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.battery')">{{ batteryText(row) }}</el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.mac')"><span class="font-mono">{{ row.mac || '--' }}</span></el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.registry')">
                <template v-if="row.registry">
                  <el-tag :type="row.registry.disabled ? 'danger' : 'success'" effect="light" round size="small">
                    {{ row.registry.disabled ? t('admin.registry.statuses.disabled') : t('admin.fleet.inRegistry') }}
                  </el-tag>
                  <span v-if="row.registry.batch" class="admin-meta ml-2">{{ row.registry.batch }}</span>
                </template>
                <span v-else class="admin-meta">{{ t('admin.fleet.notInRegistry') }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.lastCapture')">{{ dateText(row.lastCaptureAt) }}</el-descriptions-item>
              <el-descriptions-item :label="t('admin.fleet.added')">{{ dateText(row.addedAt) }}</el-descriptions-item>
              <el-descriptions-item v-if="row.disabled" :label="t('admin.fleet.pausedReason')" :span="3">
                {{ row.disabled.reason || '--' }} · {{ dateText(row.disabled.at) }}
              </el-descriptions-item>
            </el-descriptions>
          </template>
        </el-table-column>

        <el-table-column :label="t('cameras.deviceName')" min-width="190">
          <template #default="{ row }">
            <div class="admin-strong truncate">{{ row.deviceName }}</div>
            <div class="admin-meta font-mono">{{ row.deviceSerial }}</div>
            <div class="flex flex-wrap gap-1 mt-1">
              <el-tag effect="plain" size="small">{{ row.platform === 'camos' ? 'CamOS' : 'EZVIZ' }}</el-tag>
              <el-tag v-if="row.disabled" type="danger" effect="dark" round size="small">{{ t('admin.fleet.paused') }}</el-tag>
              <el-tag v-if="row.unclaimed" type="warning" effect="light" round size="small">{{ t('admin.fleet.states.unclaimed') }}</el-tag>
              <el-tag v-if="row.lastCrash" type="danger" effect="plain" round size="small" class="cursor-pointer" @click="openLog(row)">
                {{ t('admin.fleet.crashed', { reason: crashReason(row.lastCrash.reason) }) }}
              </el-tag>
              <el-tag v-if="row.logOn" type="success" effect="plain" round size="small">{{ t('admin.fleet.logOn') }}</el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.cameras.owner')" min-width="190">
          <template #default="{ row }">
            <template v-if="row.owner">
              <div class="truncate">{{ row.owner.email }}</div>
              <div v-if="row.sharedCount" class="admin-meta">{{ t('share.sharedCount', { count: row.sharedCount }) }}</div>
            </template>
            <el-tag v-else type="danger" effect="light" round size="small">{{ t('admin.cameras.noOwner') }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column :label="t('cameras.status')" width="130">
          <template #default="{ row }">
            <el-tag :type="STATE_TYPES[row.state]" effect="light" round size="small">{{ t(`admin.fleet.states.${row.state}`) }}</el-tag>
            <div class="admin-meta mt-1">{{ row.lastSeenAt ? relative(row.lastSeenAt) : '--' }}</div>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.fleet.location')" min-width="160">
          <template #default="{ row }">
            <div v-if="row.farm" class="truncate">{{ row.farm.name }}</div>
            <div v-if="row.location.address" class="admin-meta truncate">{{ row.location.address }}</div>
            <div v-if="row.location.lat !== null && row.location.lng !== null" class="admin-meta font-mono">
              {{ Number(row.location.lat).toFixed(4) }}, {{ Number(row.location.lng).toFixed(4) }}
            </div>
            <span v-if="!row.farm && !row.location.address && row.location.lat === null" class="admin-meta">--</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.fleet.hardware')" min-width="150">
          <template #default="{ row }">
            <div class="truncate">{{ row.model || '--' }}</div>
            <div v-if="row.hw" class="admin-meta">{{ t('admin.fleet.hwVersion', { v: row.hw }) }}</div>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.fleet.firmware')" min-width="150">
          <template #default="{ row }">
            <div class="font-mono">{{ row.fw || '--' }}</div>
            <el-tag v-if="row.channel && row.channel !== 'stable'" :type="channelTagType(row.channel)" effect="light" round size="small" class="mt-1">{{ t(`firmware.channels.${row.channel}`) }}</el-tag>
            <el-tag v-if="row.update" :type="updateTagType(row.update.state)" effect="light" round size="small" class="mt-1">
              {{ t(`firmware.states.${row.update.state}`) }} {{ row.update.toVersion }}
            </el-tag>
            <el-tag v-else-if="row.outdated" type="warning" effect="light" round size="small" class="mt-1">
              {{ t('admin.fleet.newer', { v: row.latestFw }) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.fleet.verifyCode')" width="130">
          <template #default="{ row }">
            <div v-if="row.hasVerifyCode" class="flex items-center gap-1">
              <span class="font-mono">{{ row.verifyCodeMasked }}</span>
              <el-button link :icon="View" :aria-label="t('admin.fleet.reveal')" :title="t('admin.fleet.reveal')" @click="reveal(row)" />
            </div>
            <span v-else class="admin-meta">--</span>
          </template>
        </el-table-column>

        <el-table-column width="70" align="right" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(cmd) => onCommand(cmd, row)">
              <el-button circle size="small" :icon="MoreFilled" :aria-label="t('common.moreActions')" />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="share" :icon="Share">{{ t('share.button') }}</el-dropdown-item>
                  <el-dropdown-item command="transfer" :icon="Switch">{{ t('admin.cameras.transfer') }}</el-dropdown-item>
                  <el-dropdown-item v-if="row.platform === 'camos'" command="firmware" :icon="Upload">{{ t('admin.fleet.updateFirmware') }}</el-dropdown-item>
                  <el-dropdown-item v-if="row.platform === 'camos'" command="log" :icon="Tickets">{{ t('cameraLog.title') }}</el-dropdown-item>
                  <el-dropdown-item v-if="row.platform === 'camos'" command="channel" :icon="Guide">{{ t('admin.fleet.setChannel') }}</el-dropdown-item>
                  <el-dropdown-item v-if="!row.disabled" command="pause" :icon="VideoPause" divided>{{ t('admin.fleet.pause') }}</el-dropdown-item>
                  <el-dropdown-item v-else command="resume" :icon="VideoPlay" divided>{{ t('admin.fleet.resume') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="total > pageSize" class="flex justify-end mt-4">
        <el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="total, prev, pager, next"
          background
          size="small"
          @current-change="load"
        />
      </div>
    </el-card>

    <!-- Transfer ownership -->
    <el-dialog v-model="transferVisible" :title="t('admin.cameras.transferTitle')" width="480px" align-center>
      <p class="admin-meta mb-4">
        {{ t('admin.cameras.transferDesc', { name: transferCamera?.deviceName || '', serial: transferCamera?.deviceSerial || '' }) }}
      </p>
      <el-form label-position="top" @submit.prevent="submitTransfer">
        <el-form-item :label="t('admin.cameras.newOwnerEmail')">
          <el-input v-model="transferEmail" type="email" :prefix-icon="Message" :placeholder="t('share.emailPlaceholder')" />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="keepAccess">{{ t('admin.cameras.keepAccess') }}</el-checkbox>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" show-icon :title="t('admin.cameras.transferHint')" />
      <template #footer>
        <el-button @click="transferVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="transferring" :disabled="!transferEmail.trim()" @click="submitTransfer">
          {{ t('admin.cameras.transfer') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Pause a camera -->
    <el-dialog v-model="pauseVisible" :title="t('admin.fleet.pauseTitle', { name: pauseCamera?.deviceName || '' })" width="480px" align-center>
      <el-alert type="warning" :closable="false" show-icon :title="t('admin.fleet.pauseHint')" class="mb-4" />
      <el-form label-position="top" @submit.prevent="submitPause">
        <el-form-item :label="t('admin.fleet.pauseReason')">
          <el-input v-model="pauseReason" type="textarea" :rows="3" maxlength="300" show-word-limit :placeholder="t('admin.fleet.pauseReasonHint')" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pauseVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="danger" :loading="pausing" @click="submitPause">{{ t('admin.fleet.pause') }}</el-button>
      </template>
    </el-dialog>

    <!-- Release channel of the chosen cameras -->
    <el-dialog v-model="channelVisible" :title="t('admin.fleet.setChannel')" width="min(460px, 96vw)" align-center>
      <p class="admin-meta mb-3">{{ t('admin.fleet.channelHint', { n: channelSerials.length }) }}</p>
      <el-radio-group v-model="channelValue" class="flex flex-col items-start gap-2">
        <el-radio v-for="c in CHANNELS" :key="c" :value="c">{{ t(`firmware.channels.${c}`) }} · <span class="admin-meta">{{ t(`firmware.channelHints.${c}`) }}</span></el-radio>
      </el-radio-group>
      <template #footer>
        <el-button @click="channelVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="savingChannel" data-test="fleet-channel-save" @click="saveChannel">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- A camera's console log -->
    <el-dialog v-model="logVisible" :title="logCamera ? `${logCamera.deviceName} · ${logCamera.deviceSerial}` : ''" width="min(980px, 96vw)" append-to-body destroy-on-close>
      <CameraLogCard v-if="logCamera" :camera="logCamera" />
    </el-dialog>

    <FirmwareRolloutDialog v-model="rolloutVisible" :serials="rolloutSerials" :models="rolloutModels" @done="load" />
    <CameraShareDialog v-model="shareVisible" :camera="shareCamera" @changed="load" />
  </div>
</template>

<script setup>
import { computed, reactive, ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh, Share, Switch, Message, View, MoreFilled, Upload, VideoPause, VideoPlay, Tickets, Guide } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';
import PageHeader from '@/components/common/PageHeader.vue';
import CameraShareDialog from '@/components/cameras/CameraShareDialog.vue';
import FirmwareRolloutDialog from './FirmwareRolloutDialog.vue';
import CameraLogCard from '@/components/cameras/CameraLogCard.vue';
import { adminErrorText } from './adminErrors';
import { updateTagType, CHANNELS, channelTagType } from '@/utils/firmware';

/**
 * Every camera (EZVIZ and CamOS): owner, state, place, model, firmware, label code (masked, revealed on request
 * and audited), the 4G modem; pausing a camera, moving it to another owner, starting a firmware update.
 */
const { t, te, locale } = useI18n();
const { loadCameras } = useCameras();

const STATES = ['online', 'offline', 'sleeping', 'disabled', 'unclaimed'];
const STATE_TYPES = { online: 'success', offline: 'danger', sleeping: 'info' };

const cameras = ref([]);
const models = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const selected = ref([]);
const filters = reactive({ q: '', platform: '', state: '', model: '', channel: '', outdated: false });
const isMobile = computed(() => typeof window !== 'undefined' && window.innerWidth < 768);

const load = async () => {
  loading.value = true;
  try {
    const res = await api.adminFleet({
      q: filters.q || undefined,
      platform: filters.platform || undefined,
      state: filters.state || undefined,
      model: filters.model || undefined,
      channel: filters.channel || undefined,
      outdated: filters.outdated ? '1' : undefined,
      page: page.value,
      limit: pageSize
    });
    cameras.value = res.data.cameras || [];
    models.value = res.data.models || [];
    total.value = res.data.total || 0;
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

const reload = () => {
  page.value = 1;
  load();
};

let timer = null;
const debouncedLoad = () => {
  clearTimeout(timer);
  timer = setTimeout(reload, 350);
};

const dateText = (d) => (d ? new Date(d).toLocaleString(locale.value) : '--');
const relative = (d) => {
  const seconds = Math.round((new Date(d).getTime() - Date.now()) / 1000);
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const [unit, size] = units.find(([, s]) => Math.abs(seconds) >= s) || ['minute', 60];
  return new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
};
const networkText = (row) => (row.net ? `${row.net === '4g' ? '4G' : 'Wi-Fi'}${row.rssi !== null ? ` · ${row.rssi} dBm` : ''}` : '--');
const batteryText = (row) => {
  const b = row.battery;
  if (!b && row.power !== 'powered') return '--';
  const parts = [];
  if (b?.pct !== undefined) parts.push(`${b.pct}%`);
  if (b?.mv !== undefined) parts.push(`${(b.mv / 1000).toFixed(2)} V`);
  if (b?.charging === true) parts.push(t('admin.fleet.charging'));
  else if (b?.charging === false) parts.push(t('admin.fleet.notCharging'));
  if (row.power === 'powered') parts.push(t('admin.fleet.powered'));
  return parts.join(' · ') || '--';
};

// ---------- Verify code ----------
const reveal = async (row) => {
  try {
    await ElMessageBox.confirm(t('admin.fleet.revealConfirm', { name: row.deviceName }), t('admin.fleet.reveal'), { type: 'warning' });
  } catch {
    return;
  }
  try {
    const res = await api.adminRevealCameraCode(row.deviceSerial);
    await ElMessageBox.alert(res.data.verifyCode || '--', t('admin.fleet.codeOf', { serial: row.deviceSerial }), { confirmButtonText: t('common.close') });
  } catch (err) {
    if (err?.response) ElMessage.error(adminErrorText(t, err));
  }
};

// ---------- Actions ----------
const onCommand = (cmd, row) => {
  if (cmd === 'share') openShare(row);
  else if (cmd === 'transfer') openTransfer(row);
  else if (cmd === 'firmware') openRollout([row]);
  else if (cmd === 'log') openLog(row);
  else if (cmd === 'channel') openChannel([row]);
  else if (cmd === 'pause') openPause(row);
  else if (cmd === 'resume') resume(row);
};

const pauseVisible = ref(false);
const pauseCamera = ref(null);
const pauseReason = ref('');
const pausing = ref(false);
const openPause = (row) => {
  pauseCamera.value = row;
  pauseReason.value = '';
  pauseVisible.value = true;
};
const submitPause = async () => {
  if (pausing.value) return;
  pausing.value = true;
  try {
    await api.adminSetCameraDisabled(pauseCamera.value.deviceSerial, true, pauseReason.value.trim());
    ElMessage.success(t('admin.fleet.pausedDone'));
    pauseVisible.value = false;
    load();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    pausing.value = false;
  }
};
const resume = async (row) => {
  try {
    await ElMessageBox.confirm(t('admin.fleet.resumeConfirm', { name: row.deviceName }), t('admin.fleet.resume'), { type: 'info' });
  } catch {
    return;
  }
  try {
    await api.adminSetCameraDisabled(row.deviceSerial, false);
    ElMessage.success(t('admin.fleet.resumedDone'));
    load();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  }
};

// ---------- Release channel ----------
const channelVisible = ref(false);
const channelSerials = ref([]);
const channelValue = ref('stable');
const savingChannel = ref(false);
const openChannel = (rows) => {
  channelSerials.value = rows.map(r => r.deviceSerial);
  channelValue.value = rows.length === 1 ? rows[0].channel || 'stable' : 'beta';
  channelVisible.value = true;
};
const saveChannel = async () => {
  savingChannel.value = true;
  try {
    const res = await api.adminSetCameraChannel(channelSerials.value, channelValue.value);
    ElMessage.success(t('admin.fleet.channelSaved', { n: res.data.changed }));
    channelVisible.value = false;
    load();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    savingChannel.value = false;
  }
};

// ---------- Console log ----------
const logVisible = ref(false);
const logCamera = ref(null);
const openLog = (row) => {
  logCamera.value = row;
  logVisible.value = true;
};
const crashReason = (r) => (te(`cameraLog.reasons.${r}`) ? t(`cameraLog.reasons.${r}`) : r);

// ---------- Firmware ----------
const selectedCamos = computed(() => selected.value.filter(r => r.platform === 'camos'));
const rolloutVisible = ref(false);
const rolloutSerials = ref([]);
const rolloutModels = ref([]);
const openRollout = (rows = selectedCamos.value) => {
  const list = Array.isArray(rows) ? rows : selectedCamos.value;
  rolloutSerials.value = list.map(r => r.deviceSerial);
  rolloutModels.value = [...new Set(list.map(r => r.model).filter(Boolean))];
  rolloutVisible.value = true;
};

// ---------- Sharing ----------
const shareVisible = ref(false);
const shareCamera = ref(null);
const openShare = (row) => {
  shareCamera.value = row;
  shareVisible.value = true;
};

// ---------- Transfer ----------
const transferVisible = ref(false);
const transferCamera = ref(null);
const transferEmail = ref('');
const keepAccess = ref(true);
const transferring = ref(false);

const openTransfer = (row) => {
  transferCamera.value = row;
  transferEmail.value = '';
  keepAccess.value = true;
  transferVisible.value = true;
};

const submitTransfer = async () => {
  if (!transferEmail.value.trim() || transferring.value) return;
  transferring.value = true;
  try {
    await api.adminTransferCamera(transferCamera.value.deviceSerial, transferEmail.value.trim(), keepAccess.value);
    ElMessage.success(t('admin.cameras.transferred'));
    transferVisible.value = false;
    load();
    loadCameras();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    transferring.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.admin-strong {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.admin-meta {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
