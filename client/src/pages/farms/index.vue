<template>
  <div class="w-full max-w-7xl mx-auto pb-12">
    <PageHeader :title="t('farms.title')" :subtitle="t('farms.subtitle')">
      <template #actions>
        <el-button v-if="canManageCameras" type="primary" :icon="Plus" @click="openCreate">{{ t('farms.create') }}</el-button>
      </template>
    </PageHeader>

    <!-- Several farms (a cooperative): side by side -->
    <FarmCompareCard v-if="farms.length" />
    <SeasonReportCard v-if="farms.length" />

    <div v-loading="loading">
      <el-card v-if="!farms.length && !loading" shadow="never">
        <el-empty :description="canManageCameras ? t('farms.empty') : t('farms.emptyViewer')">
          <el-button v-if="canManageCameras" type="primary" :icon="Plus" @click="openCreate">{{ t('farms.create') }}</el-button>
        </el-empty>
      </el-card>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <el-card v-for="farm in farms" :key="farm.id" shadow="hover" class="cursor-pointer" @click="router.push(`/farms/${farm.id}`)">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="farm-title truncate">{{ farm.name }}</div>
              <p class="farm-desc">{{ farm.description || t('dashboards.noDescription') }}</p>
            </div>
            <el-icon :size="20" class="farm-icon"><Place /></el-icon>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 mt-3">
            <el-tag type="info" effect="plain" round size="small">{{ t('farms.counts', { plots: farm.plotCount, cameras: farm.cameraCount }) }}</el-tag>
            <el-tag v-if="!farm.canEdit" type="info" effect="light" round size="small">{{ t('dashboards.sharedBy', { owner: farm.owner.name || farm.owner.email }) }}</el-tag>
          </div>
        </el-card>
      </div>
    </div>

    <el-dialog v-model="createVisible" :title="t('farms.create')" width="480px" align-center>
      <el-form label-position="top" @submit.prevent="create">
        <el-form-item :label="t('farms.name')" required>
          <el-input v-model="form.name" maxlength="80" show-word-limit />
        </el-form-item>
        <el-form-item :label="t('dashboards.description')">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="creating" :disabled="!form.name.trim()" @click="create">{{ t('farms.create') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Plus, Place } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import PageHeader from '@/components/common/PageHeader.vue';
import FarmCompareCard from '@/components/farms/FarmCompareCard.vue';
import SeasonReportCard from '@/components/farms/SeasonReportCard.vue';

const router = useRouter();
const { t } = useI18n();
const { canManageCameras } = useAuth();

const farms = ref([]);
const loading = ref(false);
const load = async () => {
  loading.value = true;
  try {
    farms.value = (await api.listFarms()).data.farms || [];
  } catch (err) {
    ElMessage.error(err.response?.data?.message || t('common.error'));
  } finally {
    loading.value = false;
  }
};

const createVisible = ref(false);
const creating = ref(false);
const form = reactive({ name: '', description: '' });
const openCreate = () => {
  form.name = '';
  form.description = '';
  createVisible.value = true;
};
const create = async () => {
  creating.value = true;
  try {
    const res = await api.createFarm({ name: form.name.trim(), description: form.description.trim() });
    createVisible.value = false;
    router.push(`/farms/${res.data.farm.id}`);
  } catch (err) {
    ElMessage.error(err.response?.data?.message || t('common.error'));
  } finally {
    creating.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.farm-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.farm-desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.farm-icon {
  color: var(--el-color-primary);
}
</style>
