<template>
  <!-- Weekly report -->
  <el-card shadow="never" class="mb-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <span class="pref-label">{{ t('alertPrefs.weekly.title') }}</span>
        <p class="pref-meta mt-1">{{ t('alertPrefs.weekly.desc') }}</p>
      </div>
      <el-switch :model-value="prefs.weeklyReport !== false" :loading="saving === 'weekly'" @change="(v) => save('weekly', { weeklyReport: v })" />
    </div>
    <div class="flex flex-wrap items-center gap-2 mt-3">
      <el-button size="small" :icon="Promotion" :loading="sendingReport" @click="sendReportNow">{{ t('alertPrefs.weekly.sendNow') }}</el-button>
      <span v-if="reportSummary" class="pref-meta">{{ reportSummary }}</span>
    </div>
  </el-card>

  <!-- Morning brief -->
  <el-card shadow="never" class="mb-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <span class="pref-label">{{ t('alertPrefs.morning.title') }}</span>
        <p class="pref-meta mt-1">{{ t('alertPrefs.morning.desc') }}</p>
      </div>
      <el-switch :model-value="!!prefs.morningBrief" :loading="saving === 'morning'" @change="(v) => save('morning', { morningBrief: v })" />
    </div>
  </el-card>

  <!-- Monthly pesticide-use record (VietGAP) -->
  <el-card shadow="never" class="mb-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <span class="pref-label">{{ t('alertPrefs.vietgap.title') }}</span>
        <p class="pref-meta mt-1">{{ t('alertPrefs.vietgap.desc') }}</p>
      </div>
      <el-switch :model-value="!!prefs.vietgapMonthly" :loading="saving === 'vietgap'" @change="(v) => save('vietgap', { vietgapMonthly: v })" />
    </div>
  </el-card>

  <!-- Quiet hours -->
  <el-card shadow="never" class="mb-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <span class="pref-label">{{ t('alertPrefs.quiet.title') }}</span>
        <p class="pref-meta mt-1">{{ t('alertPrefs.quiet.desc') }}</p>
      </div>
      <el-switch :model-value="!!quiet.enabled" :loading="saving === 'quiet'" @change="(v) => saveQuiet({ enabled: v })" />
    </div>
    <div v-if="quiet.enabled" class="flex flex-wrap items-center gap-2 mt-3">
      <el-time-select :model-value="quiet.start" start="00:00" end="23:30" step="00:30" class="!w-32" :clearable="false" @change="(v) => saveQuiet({ start: v })" />
      <span class="pref-meta">→</span>
      <el-time-select :model-value="quiet.end" start="00:00" end="23:30" step="00:30" class="!w-32" :clearable="false" @change="(v) => saveQuiet({ end: v })" />
    </div>
  </el-card>

  <!-- Cameras I follow -->
  <el-card shadow="never" class="mb-4">
    <template #header>
      <div class="pref-label">{{ t('alertPrefs.follow.title') }}</div>
      <p class="pref-meta mt-1">{{ t('alertPrefs.follow.desc') }}</p>
    </template>
    <el-empty v-if="!cameras.length" :description="t('cameras.noSharedCameras')" :image-size="64" />
    <template v-for="(cam, idx) in cameras" v-else :key="cam.deviceSerial">
      <el-divider v-if="idx > 0" class="!my-0" />
      <div class="py-2.5 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="pref-name truncate">{{ cam.deviceName }}</p>
          <p class="pref-meta font-mono">{{ cam.deviceSerial }}</p>
        </div>
        <el-switch :model-value="!muted.has(cam.deviceSerial)" :loading="saving === cam.deviceSerial" @change="(v) => toggleCamera(cam.deviceSerial, v)" />
      </div>
    </template>
  </el-card>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Promotion } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { useCameras } from '@/composables/useCameras';

const { t } = useI18n();
const { user, setAuth } = useAuth();
const { cameras } = useCameras();

const prefs = computed(() => user.value?.notificationPrefs || {});
const quiet = computed(() => ({ enabled: false, start: '21:00', end: '06:00', ...(prefs.value.quietHours || {}) }));
const muted = computed(() => new Set(prefs.value.mutedCameras || []));
const saving = ref(null);

const save = async (key, notificationPrefs) => {
  saving.value = key;
  try {
    const res = await api.updateProfile({ notificationPrefs });
    if (res.data?.user) setAuth(res.data.user);
  } catch (err) {
    ElMessage.error(err.response?.data?.message || t('settings.saveFailed'));
  } finally {
    saving.value = null;
  }
};

const saveQuiet = (patch) => save('quiet', { quietHours: { ...quiet.value, ...patch } });

const toggleCamera = (serial, follow) => {
  const next = new Set(muted.value);
  if (follow) next.delete(serial);
  else next.add(serial);
  return save(serial, { mutedCameras: [...next] });
};

// ---------- Weekly report now ----------
const sendingReport = ref(false);
const reportSummary = ref('');
const sendReportNow = async () => {
  sendingReport.value = true;
  try {
    const res = await api.sendWeeklyReport();
    const report = res.data.report;
    if (!report) {
      reportSummary.value = t('alertPrefs.weekly.noCameras');
      return;
    }
    const channels = [res.data.sent?.email && 'email', res.data.sent?.telegram && 'Telegram', res.data.sent?.push && t('alertPrefs.weekly.pushChannel')].filter(Boolean);
    reportSummary.value = t('alertPrefs.weekly.summary', { count: report.totals.current, previous: report.totals.previous });
    ElMessage.success(channels.length ? t('alertPrefs.weekly.sent', { channels: channels.join(', ') }) : t('alertPrefs.weekly.noChannel'));
  } catch (err) {
    ElMessage.error(err.response?.data?.message || t('settings.saveFailed'));
  } finally {
    sendingReport.value = false;
  }
};
</script>

<style scoped>
.pref-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.pref-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.pref-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
