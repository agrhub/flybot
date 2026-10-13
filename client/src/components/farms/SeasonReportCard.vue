<template>
  <el-card shadow="never" class="mb-4">
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
      <div class="min-w-0">
        <h3 class="section-title">{{ t('farms.season.title') }}</h3>
        <p class="section-desc">{{ t('farms.season.desc') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <el-date-picker
          v-model="range"
          type="daterange"
          unlink-panels
          size="small"
          value-format="YYYY-MM-DD"
          :disabled-date="(d) => d > new Date()"
          :start-placeholder="t('audit.from')"
          :end-placeholder="t('audit.to')"
          class="!w-full sm:!w-64"
        />
        <el-button size="small" :icon="Download" :loading="busy === 'download'" @click="download">{{ t('farms.season.download') }}</el-button>
        <el-button size="small" :icon="Message" :loading="busy === 'send'" @click="send">{{ t('farms.season.send') }}</el-button>
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Download, Message } from '@element-plus/icons-vue';
import api from '@/services/api';
import { requestErrorText } from '@/utils/requestError';

const { t } = useI18n();

// The last 6 months by default (the server's default too)
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
const range = ref([dayKey(new Date(today.getTime() - 181 * 24 * 60 * 60 * 1000)), dayKey(today)]);
const busy = ref(null);

const period = () => (range.value?.length === 2 ? { from: range.value[0], to: range.value[1] } : {});

// A failed blob request carries its JSON error as a Blob
const errorOf = async (err) => {
  const data = err.response?.data;
  if (data instanceof Blob) {
    try {
      const body = JSON.parse(await data.text());
      return body.message || t('common.error');
    } catch {
      return t('common.error');
    }
  }
  return requestErrorText(t, err, t('common.error'));
};

const download = async () => {
  busy.value = 'download';
  try {
    const p = period();
    const res = await api.downloadSeasonReport(p);
    const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `FlyBot_season_${p.from || ''}_${p.to || ''}.pdf`.replace('__', '_');
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    ElMessage.error(await errorOf(err));
  } finally {
    busy.value = null;
  }
};

const send = async () => {
  busy.value = 'send';
  try {
    await api.sendSeasonReport(period());
    ElMessage.success(t('farms.season.sent'));
  } catch (err) {
    ElMessage.error(await errorOf(err));
  } finally {
    busy.value = null;
  }
};
</script>

<style scoped>
.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-desc {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
