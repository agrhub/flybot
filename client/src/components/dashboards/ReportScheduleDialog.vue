<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('dashboards.schedule.title', { name: dashboard?.name || '' })"
    width="min(520px, 94vw)"
    align-center
    @update:model-value="(value) => emit('update:modelValue', value)"
  >
    <p class="schedule-meta mb-4">{{ t('dashboards.schedule.desc') }}</p>
    <el-form label-position="top">
      <el-form-item :label="t('dashboards.schedule.frequency')">
        <el-radio-group v-model="form.frequency">
          <el-radio-button v-for="f in FREQUENCIES" :key="f" :value="f">{{ t(`dashboards.schedule.frequencies.${f}`) }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <template v-if="form.frequency !== 'off'">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <el-form-item v-if="form.frequency === 'weekly'" :label="t('dashboards.schedule.weekday')">
            <el-select v-model="form.weekday" class="w-full">
              <el-option v-for="d in 7" :key="d" :value="d" :label="t(`dashboards.schedule.weekdays.${d}`)" />
            </el-select>
          </el-form-item>
          <el-form-item v-else :label="t('dashboards.schedule.monthDay')">
            <el-select v-model="form.monthDay" class="w-full">
              <el-option v-for="d in 28" :key="d" :value="d" :label="t('dashboards.schedule.dayOfMonth', { day: d })" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('dashboards.schedule.hour')">
            <el-select v-model="form.hour" class="w-full">
              <el-option v-for="h in 24" :key="h - 1" :value="h - 1" :label="`${String(h - 1).padStart(2, '0')}:00`" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item :label="t('dashboards.schedule.recipients')">
          <el-radio-group v-model="form.recipients">
            <el-radio value="owner">{{ t('dashboards.schedule.recipientsOwner') }}</el-radio>
            <el-radio value="all">{{ t('dashboards.schedule.recipientsAll') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon :title="t(`dashboards.schedule.covers.${form.frequency}`)" />
        <p v-if="dashboard?.schedule?.lastSentAt" class="schedule-meta mt-3">
          {{ t('dashboards.schedule.lastSent', { time: new Date(dashboard.schedule.lastSentAt).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US') }) }}
        </p>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import api from '@/services/api';
import { dashboardErrorText } from '@/utils/dashboards';

/**
 * Email a report with its PDF on a schedule (farm time): weekly or monthly, to the owner or also
 * to the people it is shared with.
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  dashboard: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'updated']);
const { t, locale } = useI18n();

const FREQUENCIES = ['off', 'weekly', 'monthly'];
const form = reactive({ frequency: 'off', weekday: 1, monthDay: 1, hour: 7, recipients: 'owner' });
const saving = ref(false);

watch(() => props.modelValue, (open) => {
  if (!open) return;
  const sc = props.dashboard?.schedule || {};
  Object.assign(form, {
    frequency: sc.frequency || 'off',
    weekday: sc.weekday ?? 1,
    monthDay: sc.monthDay ?? 1,
    hour: sc.hour ?? 7,
    recipients: sc.recipients || 'owner',
  });
});

const save = async () => {
  saving.value = true;
  try {
    const res = await api.updateDashboard(props.dashboard.id, { schedule: { ...form } });
    emit('updated', res.data.dashboard);
    emit('update:modelValue', false);
    ElMessage.success(t('dashboards.schedule.saved'));
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    saving.value = false;
  }
};
</script>

<style scoped>
.schedule-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
