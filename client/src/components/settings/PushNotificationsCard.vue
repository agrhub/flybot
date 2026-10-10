<template>
  <el-card shadow="never" class="mb-4" v-loading="loading">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="push-label">{{ t('push.title') }}</span>
          <el-tag v-if="subscribed" type="success" effect="light" round size="small">{{ t('push.onThisDevice') }}</el-tag>
        </div>
        <p class="push-meta mt-1">{{ t('push.desc') }}</p>
      </div>
      <el-switch
        v-if="canToggle"
        :model-value="subscribed"
        :loading="busy"
        @change="toggle"
      />
    </div>

    <el-alert v-if="!supported" type="info" :title="t('push.unsupported')" :closable="false" show-icon class="mt-3" />
    <el-alert
      v-else-if="needsHomeScreen"
      type="info"
      :title="t('push.iosTitle')"
      :description="t('push.iosSteps')"
      :closable="false"
      show-icon
      class="mt-3"
    />
    <el-alert v-else-if="!serverEnabled && !loading" type="info" :title="t('push.notConfigured')" :closable="false" show-icon class="mt-3" />
    <el-alert
      v-else-if="permission === 'denied'"
      type="warning"
      :title="t('push.blocked')"
      :description="t('push.blockedHelp')"
      :closable="false"
      show-icon
      class="mt-3"
    />

    <div v-if="subscribed || canInstall" class="flex flex-wrap items-center gap-2 mt-3">
      <el-button v-if="subscribed" size="small" :icon="Promotion" :loading="testing" @click="sendTest">
        {{ t('push.test') }}
      </el-button>
      <el-button v-if="canInstall" size="small" type="primary" plain :icon="Download" @click="installApp">
        {{ t('push.install') }}
      </el-button>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Promotion, Download } from '@element-plus/icons-vue';
import api from '@/services/api';
import { usePush } from '@/composables/usePush';

const { t } = useI18n();
const {
  supported, serverEnabled, subscribed, permission, busy, needsHomeScreen, canInstall,
  refresh, enable, disable, install,
} = usePush();

const loading = ref(false);
const testing = ref(false);

const canToggle = computed(() => supported && serverEnabled.value && !needsHomeScreen.value && permission.value !== 'denied');

const toggle = async (value) => {
  try {
    if (value) {
      const ok = await enable();
      if (ok) ElMessage.success(t('push.enabled'));
      else if (permission.value === 'denied') ElMessage.warning(t('push.blocked'));
    } else {
      await disable();
      ElMessage.success(t('push.disabled'));
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || t('push.failed'));
  }
};

const sendTest = async () => {
  testing.value = true;
  try {
    const res = await api.sendTestPush();
    if (res.data.delivered > 0) ElMessage.success(t('push.testSent', { count: res.data.delivered }));
    else ElMessage.warning(t('push.testNone'));
  } catch (err) {
    ElMessage.error(err.response?.data?.message || t('push.failed'));
  } finally {
    testing.value = false;
  }
};

const installApp = async () => {
  if (await install()) ElMessage.success(t('push.installed'));
};

onMounted(async () => {
  loading.value = true;
  try {
    await refresh();
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.push-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.push-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
