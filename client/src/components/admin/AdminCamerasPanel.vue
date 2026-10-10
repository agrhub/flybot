<template>
  <div>
    <PageHeader :title="t('admin.cameras.title')" :subtitle="t('admin.cameras.subtitle')" />

    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <el-input
          v-model="query"
          :placeholder="t('admin.cameras.search')"
          :prefix-icon="Search"
          clearable
          class="!w-72"
          @input="debouncedLoad"
          @clear="reload"
        />
        <el-button :icon="Refresh" @click="load">{{ t('common.refresh') }}</el-button>
      </div>

      <el-table v-loading="loading" :data="cameras" row-key="deviceSerial" style="width: 100%">
        <el-table-column :label="t('cameras.deviceName')" min-width="180">
          <template #default="{ row }">
            <div class="admin-strong truncate">{{ row.deviceName }}</div>
            <div class="admin-meta font-mono">{{ row.deviceSerial }}</div>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.cameras.owner')" min-width="200">
          <template #default="{ row }">
            <template v-if="row.owner">
              <div class="truncate">{{ row.owner.email }}</div>
              <div class="admin-meta">{{ t(`roles.${row.owner.role}`) }}</div>
            </template>
            <el-tag v-else type="danger" effect="light" round size="small">{{ t('admin.cameras.noOwner') }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.cameras.sharedWith')" width="120" align="center">
          <template #default="{ row }">
            <span>{{ row.sharedCount }}</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('cameras.status')" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'" effect="light" round size="small">
              {{ row.status === 1 ? t('common.online') : t('common.offline') }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column width="220" align="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Share" @click="openShare(row)">{{ t('share.button') }}</el-button>
            <el-button link :icon="Switch" @click="openTransfer(row)">{{ t('admin.cameras.transfer') }}</el-button>
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

    <CameraShareDialog v-model="shareVisible" :camera="shareCamera" @changed="load" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Search, Refresh, Share, Switch, Message } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useCameras } from '@/composables/useCameras';
import PageHeader from '@/components/common/PageHeader.vue';
import CameraShareDialog from '@/components/cameras/CameraShareDialog.vue';
import { adminErrorText } from './adminErrors';

const { t } = useI18n();
const { loadCameras } = useCameras();

const cameras = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const query = ref('');
const loading = ref(false);

const load = async () => {
  loading.value = true;
  try {
    const res = await api.adminListCameras({ q: query.value || undefined, page: page.value, limit: pageSize });
    cameras.value = res.data.cameras || [];
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
