<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="trap-title">{{ t('maintenance.title') }}</span>
          <el-tag v-if="cardState" :type="cardState.type" effect="light" round size="small">{{ cardState.label }}</el-tag>
        </div>
        <div v-if="canManage" class="flex flex-wrap items-center gap-2">
          <el-button v-if="!isLure" type="primary" size="small" :icon="RefreshRight" :loading="saving" @click="record('card_replaced')">
            {{ t('maintenance.cardReplaced') }}
          </el-button>
          <el-dropdown trigger="click" @command="openDialog">
            <el-button size="small" :icon="Plus">{{ t('maintenance.addOther') }}</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="type in TYPES" :key="type" :command="type">{{ t(`maintenance.types.${type}`) }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </template>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <!-- Lure trap: nothing accumulates, only upkeep is logged -->
      <div v-if="isLure" class="md:col-span-1">
        <el-tag effect="plain" round size="small">{{ t('trapKind.lure.name') }}</el-tag>
        <p class="trap-meta mt-2">{{ t('trapKind.lure.maintenanceHint') }}</p>
      </div>
      <!-- Current card -->
      <div v-else class="md:col-span-1">
        <el-descriptions :column="1" size="small">
          <el-descriptions-item :label="t('maintenance.cardSince')">
            <span class="trap-value">{{ card?.replacedAt ? formatDate(card.replacedAt) : t('maintenance.never') }}</span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('maintenance.cardAge')">
            <span class="trap-value">{{ cardAgeDays !== null ? t('maintenance.days', { count: cardAgeDays }) : '--' }}</span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('maintenance.reminder')">
            <el-select
              v-if="canManage"
              :model-value="card?.reminderDays ?? 7"
              size="small"
              class="!w-36"
              :loading="savingReminder"
              @change="saveReminder"
            >
              <el-option v-for="d in REMINDER_DAYS" :key="d" :value="d" :label="d === 0 ? t('maintenance.reminderOff') : t('maintenance.everyDays', { count: d })" />
            </el-select>
            <span v-else class="trap-value">{{ card?.reminderDays ? t('maintenance.everyDays', { count: card.reminderDays }) : t('maintenance.reminderOff') }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <p class="trap-meta mt-2">{{ t('maintenance.hint') }}</p>
      </div>

      <!-- History -->
      <div class="md:col-span-2 min-w-0">
        <el-empty v-if="!events.length && !loading" :description="t('maintenance.empty')" :image-size="56" />
        <el-timeline v-else class="trap-timeline">
          <el-timeline-item
            v-for="ev in events"
            :key="ev.id"
            :timestamp="formatDateTime(ev.at)"
            :type="ev.type === 'card_replaced' ? 'primary' : 'info'"
            placement="top"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="trap-value">{{ t(`maintenance.types.${ev.type}`) }}</span>
                  <el-tooltip v-if="ev.source === 'detected'" :content="t('maintenance.detectedHint')" placement="top">
                    <el-tag type="warning" effect="plain" size="small">{{ t('maintenance.detected') }}</el-tag>
                  </el-tooltip>
                </div>
                <div v-if="ev.note" class="trap-meta">{{ ev.note }}</div>
                <div v-if="ev.by" class="trap-meta">{{ ev.by }}</div>
              </div>
              <el-tooltip v-if="canManage" :content="t('maintenance.delete')" placement="top">
                <el-button link type="danger" size="small" :icon="Delete" @click="remove(ev)" />
              </el-tooltip>
            </div>
          </el-timeline-item>
        </el-timeline>
      </div>
    </div>

    <!-- Other maintenance -->
    <el-dialog v-model="dialogVisible" :title="dialogType ? t(`maintenance.types.${dialogType}`) : ''" width="440px" align-center append-to-body>
      <el-form label-position="top">
        <el-form-item :label="t('maintenance.when')">
          <el-date-picker v-model="dialogAt" type="datetime" class="!w-full" :disabled-date="(d) => d > new Date()" />
        </el-form-item>
        <el-form-item :label="t('maintenance.note')">
          <el-input v-model="dialogNote" type="textarea" :rows="2" maxlength="300" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="submitDialog">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { RefreshRight, Plus, Delete } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';

const props = defineProps({
  camera: { type: Object, default: null },
});

const ALL_TYPES = ['card_replaced', 'lure_replaced', 'lens_cleaned', 'other'];
const REMINDER_DAYS = [0, 3, 5, 7, 10, 14, 21, 30];
const DAY_MS = 24 * 60 * 60 * 1000;

const { t, locale } = useI18n();
const { loadCameras } = useCameras();

const card = ref(null);
const events = ref([]);
const loading = ref(false);
const saving = ref(false);
const savingReminder = ref(false);

const canManage = computed(() => props.camera?.canManage !== false);
// Lure traps (no glue) have no sticky card to replace or remind about
const isLure = computed(() => props.camera?.trapKind === 'lure');
const TYPES = computed(() => (isLure.value ? ALL_TYPES.filter(type => type !== 'card_replaced') : ALL_TYPES));
const dateLocale = () => (locale.value === 'vi' ? 'vi-VN' : 'en-US');
const formatDate = (v) => new Date(v).toLocaleDateString(dateLocale());
const formatDateTime = (v) => new Date(v).toLocaleString(dateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const cardAgeDays = computed(() => (card.value?.replacedAt ? Math.floor((Date.now() - new Date(card.value.replacedAt)) / DAY_MS) : null));

// Overdue / due within a day / fine
const cardState = computed(() => {
  if (isLure.value || !card.value?.dueAt) return null;
  const left = new Date(card.value.dueAt) - Date.now();
  if (left <= 0) return { type: 'danger', label: t('maintenance.overdue') };
  if (left <= DAY_MS) return { type: 'warning', label: t('maintenance.dueSoon') };
  return { type: 'success', label: t('maintenance.ok') };
});

const errorText = (err) => err.response?.data?.message || t('common.error');

const load = async () => {
  if (!props.camera?.deviceSerial) return;
  loading.value = true;
  try {
    const res = await api.getMaintenance(props.camera.deviceSerial);
    card.value = res.data.card;
    events.value = res.data.events || [];
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
};

const record = async (type, extra = {}) => {
  saving.value = true;
  try {
    await api.addMaintenance({ deviceSerial: props.camera.deviceSerial, type, ...extra });
    ElMessage.success(t('maintenance.saved'));
    await load();
    // Card due dates on camera lists
    if (type === 'card_replaced') loadCameras();
    return true;
  } catch (err) {
    ElMessage.error(errorText(err));
    return false;
  } finally {
    saving.value = false;
  }
};

const remove = async (ev) => {
  try {
    await ElMessageBox.confirm(t('maintenance.deleteConfirm'), t('maintenance.delete'), {
      type: 'warning',
      confirmButtonText: t('maintenance.delete'),
      cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  try {
    await api.deleteMaintenance(ev.id);
    await load();
    if (ev.type === 'card_replaced') loadCameras();
  } catch (err) {
    ElMessage.error(errorText(err));
  }
};

const saveReminder = async (days) => {
  savingReminder.value = true;
  try {
    await api.updateCamera(props.camera.deviceSerial, { cardReminderDays: days });
    await load();
    loadCameras();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    savingReminder.value = false;
  }
};

// ---------- Other maintenance (date + note) ----------
const dialogVisible = ref(false);
const dialogType = ref('');
const dialogAt = ref(new Date());
const dialogNote = ref('');

const openDialog = (type) => {
  dialogType.value = type;
  dialogAt.value = new Date();
  dialogNote.value = '';
  dialogVisible.value = true;
};

const submitDialog = async () => {
  const ok = await record(dialogType.value, {
    at: (dialogAt.value || new Date()).toISOString(),
    note: dialogNote.value.trim() || undefined,
  });
  if (ok) dialogVisible.value = false;
};

watch(() => props.camera?.deviceSerial, load, { immediate: true });
</script>

<style scoped>
.trap-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.trap-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.trap-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.trap-timeline {
  max-height: 260px;
  overflow-y: auto;
  padding: 4px 4px 0 2px;
}
</style>
