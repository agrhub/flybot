<template>
  <el-card shadow="never" class="mt-4" v-loading="loading" data-test="demo-access">
    <template #header>
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="admin-label">{{ t('admin.demo.title') }}</div>
          <p class="admin-meta mt-1">{{ t('admin.demo.desc') }}</p>
        </div>
        <el-switch v-model="form.demoViewEnabled" :aria-label="t('admin.demo.title')" data-test="demo-enabled" />
      </div>
    </template>

    <el-form label-position="top" class="max-w-3xl" @submit.prevent="save">
      <!-- The shared cameras, each with what visitors may do with it (photos and counts: always) -->
      <el-form-item :label="t('admin.demo.cameras')">
        <el-select
          v-model="adding"
          filterable
          allow-create
          default-first-option
          :disabled="shares.length >= MAX_SHARES"
          :placeholder="t('admin.demo.camerasPlaceholder')"
          class="w-full"
          data-test="demo-cameras"
          @change="addShare"
        >
          <el-option v-for="c in addable" :key="c.deviceSerial" :label="`${c.deviceName || c.deviceSerial} (${c.deviceSerial})`" :value="c.deviceSerial" />
        </el-select>
        <p class="admin-meta w-full mt-1">{{ t('admin.demo.camerasDesc') }}</p>
        <el-table v-if="shares.length" :data="shares" size="small" class="w-full mt-2" data-test="demo-shares">
          <el-table-column :label="t('admin.demo.camera')" min-width="150">
            <template #default="{ row }">
              <div class="admin-label truncate">{{ nameOf(row.deviceSerial) }}</div>
              <div class="admin-meta font-mono truncate">{{ row.deviceSerial }}</div>
            </template>
          </el-table-column>
          <el-table-column v-for="p in PERMISSIONS" :key="p" align="center" min-width="92">
            <template #header>
              <el-tooltip :content="t(`admin.demo.perm.${p}Desc`)" placement="top">
                <span>{{ t(`admin.demo.perm.${p}`) }}</span>
              </el-tooltip>
            </template>
            <template #default="{ row }">
              <el-switch v-model="row[p]" size="small" :aria-label="`${t(`admin.demo.perm.${p}`)}: ${nameOf(row.deviceSerial)}`" :data-test="`share-${row.deviceSerial}-${p}`" />
            </template>
          </el-table-column>
          <el-table-column width="56" align="center">
            <template #default="{ row }">
              <el-button link type="danger" :icon="Delete" :aria-label="t('admin.demo.remove')" :data-test="`share-${row.deviceSerial}-remove`" @click="removeShare(row.deviceSerial)" />
            </template>
          </el-table-column>
        </el-table>
        <p v-else class="admin-meta w-full mt-2">{{ t('admin.demo.noShares') }}</p>
        <p v-if="shares.length" class="admin-meta w-full mt-1">{{ t('admin.demo.photosAlways') }}</p>
        <el-alert
          v-if="rawSerialNames.length"
          class="mt-2"
          type="warning"
          :closable="false"
          show-icon
          :title="t('admin.demo.rawSerialWarning', { names: rawSerialNames.join(', ') })"
          data-test="demo-raw-serial"
        />
      </el-form-item>

      <el-form-item>
        <div class="flex items-start justify-between gap-4 w-full">
          <div class="min-w-0">
            <div class="admin-label">{{ t('admin.demo.guest') }}</div>
            <p class="admin-meta">{{ t('admin.demo.guestDesc') }}</p>
          </div>
          <el-switch v-model="form.guestAccessEnabled" :aria-label="t('admin.demo.guest')" data-test="guest-switch" />
        </div>
      </el-form-item>

      <el-form-item :label="t('admin.demo.audience')">
        <el-radio-group v-model="audience" data-test="demo-audience">
          <el-radio value="guest">{{ t('admin.demo.audienceGuest') }}</el-radio>
          <el-radio value="all">{{ t('admin.demo.audienceAll') }}</el-radio>
          <el-radio value="since">{{ t('admin.demo.audienceSince') }}</el-radio>
        </el-radio-group>
        <div v-if="audience === 'since'" class="w-full mt-2">
          <el-date-picker v-model="since" type="date" value-format="YYYY-MM-DD" :clearable="false" :placeholder="t('admin.demo.sincePlaceholder')" data-test="demo-since" />
        </div>
        <p class="admin-meta w-full mt-1">{{ t('admin.demo.audienceDesc') }}</p>
      </el-form-item>

      <el-form-item>
        <div class="flex items-start justify-between gap-4 w-full">
          <div class="min-w-0">
            <div class="admin-label">{{ t('admin.demo.live') }}</div>
            <p class="admin-meta">{{ t('admin.demo.liveDesc') }}</p>
          </div>
          <el-switch v-model="form.demoViewLive" :aria-label="t('admin.demo.live')" />
        </div>
      </el-form-item>

      <el-divider />

      <!-- The simulated demo farm (scripts/demo_sim.js): labeled synthetic data across Vietnam -->
      <div class="admin-label mb-1">{{ t('admin.demo.simTitle') }}</div>
      <p class="admin-meta mb-3" data-test="demo-sim-status">
        {{ sim?.exists ? t('admin.demo.simStatus', { farms: sim.farms, cameras: sim.cameras, photos: sim.photos, time: sim.lastPhotoAt ? formatDateTime(sim.lastPhotoAt) : '--' }) : t('admin.demo.simMissing') }}
      </p>
      <el-form-item>
        <div class="flex items-start justify-between gap-4 w-full">
          <div class="min-w-0">
            <div class="admin-label">{{ t('admin.demo.simShow') }}</div>
            <p class="admin-meta">{{ t('admin.demo.simShowDesc') }}</p>
          </div>
          <el-switch v-model="form.demoViewSimulated" :disabled="!sim?.exists" :aria-label="t('admin.demo.simShow')" data-test="demo-sim-show" />
        </div>
      </el-form-item>
      <el-form-item>
        <div class="flex items-start justify-between gap-4 w-full">
          <div class="min-w-0">
            <div class="admin-label">{{ t('admin.demo.simDaily') }}</div>
            <p class="admin-meta">{{ t('admin.demo.simDailyDesc') }}</p>
          </div>
          <el-switch v-model="form.demoSimEnabled" :disabled="!sim?.exists" :aria-label="t('admin.demo.simDaily')" />
        </div>
        <div v-if="form.demoSimEnabled" class="flex items-center gap-2 w-full mt-2">
          <span class="admin-meta">{{ t('admin.demo.simUntil') }}</span>
          <el-date-picker v-model="simUntil" type="date" value-format="YYYY-MM-DD" :placeholder="t('admin.demo.sincePlaceholder')" />
        </div>
      </el-form-item>

      <el-alert class="mb-4" type="info" :closable="false" show-icon :title="t('admin.demo.readOnly')" />

      <el-button type="primary" :loading="saving" :icon="Check" data-test="demo-save" @click="save">{{ t('common.save') }}</el-button>
    </el-form>
  </el-card>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Check, Delete } from '@element-plus/icons-vue';
import api from '@/services/api';
import { adminErrorText } from './adminErrors';

const { t, locale } = useI18n();
const loading = ref(false);
const saving = ref(false);
const cameras = ref([]);
const form = reactive({ demoViewEnabled: false, demoViewLive: false, demoViewSimulated: false, demoSimEnabled: false, guestAccessEnabled: false });
// What visitors may do with each shared camera besides its photos and counts (server: services/demoView.js)
const PERMISSIONS = ['live', 'playback', 'location', 'device', 'realSerial'];
const MAX_SHARES = 20;
const shares = ref([]);
const adding = ref('');
const nameOf = (serial) => cameras.value.find(c => c.deviceSerial === serial)?.deviceName || serial;
const addable = computed(() => cameras.value.filter(c => !shares.value.some(s => s.deviceSerial === c.deviceSerial)));
// A new camera: live view and recordings as the default switch says; its place, device and serial stay
// hidden until the admin opens them
const addShare = (value) => {
  const serial = String(value || '').trim();
  adding.value = '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serial) || shares.value.some(s => s.deviceSerial === serial) || shares.value.length >= MAX_SHARES) return;
  shares.value.push({ deviceSerial: serial, live: form.demoViewLive, playback: form.demoViewLive, location: false, device: false, realSerial: false });
};
const removeShare = (serial) => { shares.value = shares.value.filter(s => s.deviceSerial !== serial); };
// Live view and recordings hand the viewer's player the real serial (EZVIZ and AWS need it)
const rawSerialNames = computed(() => shares.value.filter(s => !s.realSerial && (s.live || s.playback)).map(s => nameOf(s.deviceSerial)));
const sim = ref(null);
const simUntil = ref('');
const formatDateTime = (value) => new Date(value).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US');
// Who sees the demo cameras besides the guest account: nobody, every account, or accounts created
// on or after a date
const audience = ref('guest');
const since = ref('');

const apply = (settings) => {
  form.demoViewEnabled = !!settings.demoViewEnabled;
  shares.value = (settings.demoViewShares || (settings.demoViewCameras || []).map(deviceSerial => ({ deviceSerial, live: !!settings.demoViewLive, playback: !!settings.demoViewLive, location: true, device: true, realSerial: true })))
    .map(s => ({ deviceSerial: s.deviceSerial, ...Object.fromEntries(PERMISSIONS.map(p => [p, !!s[p]])) }));
  form.demoViewLive = !!settings.demoViewLive;
  form.demoViewSimulated = !!settings.demoViewSimulated;
  form.demoSimEnabled = !!settings.demoSimEnabled;
  // demoSimUntil is the end of that day in farm time (UTC+7)
  simUntil.value = settings.demoSimUntil ? new Date(new Date(settings.demoSimUntil).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10) : '';
  audience.value = settings.demoViewAudience || 'guest';
  form.guestAccessEnabled = !!settings.guestAccessEnabled;
  since.value = settings.demoViewSince ? String(settings.demoViewSince).slice(0, 10) : '';
};

const load = async () => {
  loading.value = true;
  try {
    const [settings, list, status] = await Promise.all([api.getAdminSettings(), api.adminListCameras({ limit: 100 }), api.adminDemoSim()]);
    apply(settings.data.settings);
    cameras.value = (list.data.cameras || []).filter(c => !/^SIM-/.test(c.deviceSerial));
    sim.value = status.data.demoSim;
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

const save = async () => {
  if (audience.value === 'since' && !since.value) {
    ElMessage.warning(t('admin.demo.sinceRequired'));
    return;
  }
  saving.value = true;
  try {
    const res = await api.updateAdminSettings({
      ...form,
      demoViewShares: shares.value.map(s => ({ deviceSerial: s.deviceSerial, ...Object.fromEntries(PERMISSIONS.map(p => [p, !!s[p]])) })),
      demoViewAudience: audience.value,
      demoViewSince: audience.value === 'since' ? since.value : null,
      demoSimUntil: form.demoSimEnabled && simUntil.value ? `${simUntil.value}T23:59:59+07:00` : null
    });
    apply(res.data.settings);
    ElMessage.success(t('admin.saved'));
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    saving.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.admin-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.admin-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
