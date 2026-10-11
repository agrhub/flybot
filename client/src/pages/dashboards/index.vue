<template>
  <div class="w-full max-w-7xl mx-auto pb-12">
    <PageHeader :title="t('dashboards.title')" :subtitle="t('dashboards.subtitle')">
      <template #actions>
        <el-button :icon="Refresh" @click="load">{{ t('common.refresh') }}</el-button>
        <el-button v-if="canBuildDashboards" type="primary" :icon="Plus" @click="openCreate">
          {{ t('dashboards.create') }}
        </el-button>
      </template>
    </PageHeader>

    <div v-loading="loading">
      <el-card v-if="!dashboards.length && !loading" shadow="never">
        <el-empty :description="canBuildDashboards ? t('dashboards.empty') : t('dashboards.emptyViewer')">
          <el-button v-if="canBuildDashboards" type="primary" :icon="Plus" @click="openCreate">
            {{ t('dashboards.create') }}
          </el-button>
        </el-empty>
      </el-card>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <el-card
          v-for="d in dashboards"
          :key="d.id"
          shadow="hover"
          class="dash-card cursor-pointer"
          @click="router.push(`/reports/${d.id}`)"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="dash-card__title truncate">{{ d.name }}</div>
              <p class="dash-card__desc">{{ d.description || t('dashboards.noDescription') }}</p>
            </div>
            <el-icon :size="20" class="dash-card__icon"><Document /></el-icon>
          </div>

          <div class="flex flex-wrap items-center gap-1.5 mt-4">
            <el-tag :type="d.visibility === 'public' ? 'warning' : 'info'" effect="light" round size="small">
              <el-icon class="mr-1"><component :is="d.visibility === 'public' ? Link : Lock" /></el-icon>
              {{ t(`dashboards.visibility.${d.visibility}`) }}
            </el-tag>
            <el-tag v-if="d.access !== 'owner'" type="info" effect="plain" round size="small">
              {{ d.access === 'shared' ? t('dashboards.sharedBy', { owner: d.owner.name || d.owner.email }) : t('dashboards.ownedBy', { owner: d.owner.email }) }}
            </el-tag>
            <el-tag v-if="d.expiresAt" :type="d.expired ? 'danger' : 'info'" effect="plain" round size="small">
              {{ d.expired ? t('dashboards.expiry.expired') : t('dashboards.expiry.until', { time: formatDate(d.expiresAt) }) }}
            </el-tag>
          </div>

          <el-divider class="!my-3" />
          <div class="flex items-center justify-between dash-card__meta">
            <span>{{ t('dashboards.counts', { widgets: d.widgetCount, cameras: d.cameraCount }) }}</span>
            <span>{{ formatDate(d.updatedAt) }}</span>
          </div>
        </el-card>
      </div>
    </div>

    <!-- Create -->
    <el-dialog v-model="createVisible" :title="t('dashboards.create')" width="520px" align-center>
      <el-form label-position="top" @submit.prevent="create">
        <el-form-item :label="t('dashboards.name')" required>
          <el-input v-model="form.name" maxlength="80" show-word-limit />
        </el-form-item>
        <el-form-item :label="t('dashboards.description')">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" />
        </el-form-item>
        <el-form-item :label="t('dashboards.cameras')">
          <el-select v-model="form.cameraSerials" multiple collapse-tags collapse-tags-tooltip filterable class="w-full" :placeholder="t('dashboards.camerasPlaceholder')">
            <el-option v-for="cam in cameras" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('dashboards.defaultRange')">
          <ReportRangePicker v-model="form.range" />
        </el-form-item>
        <el-form-item :label="t('dashboards.template')">
          <el-radio-group v-model="form.template">
            <el-radio value="overview">{{ t('dashboards.templates.overview') }}</el-radio>
            <el-radio value="blank">{{ t('dashboards.templates.blank') }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="creating" :disabled="!form.name.trim()" @click="create">
          {{ t('dashboards.createAndEdit') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Plus, Refresh, Document, Link, Lock } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { useCameras } from '@/composables/useCameras';
import PageHeader from '@/components/common/PageHeader.vue';
import ReportRangePicker from '@/components/dashboards/ReportRangePicker.vue';
import { overviewWidgets, dashboardErrorText } from '@/utils/dashboards';

const router = useRouter();
const { t, locale } = useI18n();
const { canBuildDashboards } = useAuth();
const { cameras } = useCameras();

const dashboards = ref([]);
const loading = ref(false);

const formatDate = (value) => (value ? new Date(value).toLocaleDateString(locale.value === 'vi' ? 'vi-VN' : 'en-US') : '');

const load = async () => {
  loading.value = true;
  try {
    const res = await api.listDashboards();
    dashboards.value = res.data.dashboards || [];
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    loading.value = false;
  }
};

// ---------- Create ----------
const createVisible = ref(false);
const creating = ref(false);
const form = reactive({ name: '', description: '', cameraSerials: [], range: { preset: '7d' }, template: 'overview' });

const openCreate = () => {
  form.name = '';
  form.description = '';
  // Default to the cameras you manage (the ones you can also publish)
  form.cameraSerials = cameras.value.filter(c => c.canManage !== false).map(c => c.deviceSerial).slice(0, 50);
  form.range = { preset: '7d' };
  form.template = 'overview';
  createVisible.value = true;
};

const create = async () => {
  if (!form.name.trim() || creating.value) return;
  creating.value = true;
  try {
    const res = await api.createDashboard({
      name: form.name.trim(),
      description: form.description.trim(),
      cameraSerials: form.cameraSerials,
      range: form.range,
      widgets: form.template === 'overview' ? overviewWidgets() : [],
    });
    createVisible.value = false;
    router.push({ path: `/reports/${res.data.dashboard.id}`, query: { edit: '1' } });
  } catch (err) {
    ElMessage.error(dashboardErrorText(t, err));
  } finally {
    creating.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.dash-card__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.dash-card__desc {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 39px;
}
.dash-card__icon {
  color: var(--el-color-primary);
}
.dash-card__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
