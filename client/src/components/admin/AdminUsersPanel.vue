<template>
  <div>
    <PageHeader :title="t('admin.users.title')" :subtitle="t('admin.users.subtitle')" />

    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <el-input
          v-model="query"
          :placeholder="t('admin.users.search')"
          :prefix-icon="Search"
          clearable
          class="!w-64"
          @input="debouncedLoad"
          @clear="load"
        />
        <el-select v-model="roleFilter" :placeholder="t('admin.users.allRoles')" clearable class="!w-44" @change="reload">
          <el-option v-for="r in ROLES" :key="r" :label="t(`roles.${r}`)" :value="r" />
        </el-select>
        <el-button :icon="Refresh" @click="load">{{ t('common.refresh') }}</el-button>
      </div>

      <el-table v-loading="loading" :data="users" row-key="id" style="width: 100%">
        <el-table-column :label="t('admin.users.account')" min-width="220">
          <template #default="{ row }">
            <div class="min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <span class="admin-strong truncate">{{ row.name }}</span>
                <el-tag v-if="row.id === authUser?.id" type="info" effect="plain" size="small">{{ t('admin.users.you') }}</el-tag>
              </div>
              <div class="admin-meta truncate">{{ row.email }}</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.users.role')" width="170">
          <template #default="{ row }">
            <el-select
              :model-value="row.role"
              size="small"
              :disabled="row.id === authUser?.id || saving === row.id"
              @change="(value) => changeRole(row, value)"
            >
              <el-option v-for="r in ROLES" :key="r" :label="t(`roles.${r}`)" :value="r" />
            </el-select>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.users.cameras')" width="100" align="center" prop="cameraCount" />

        <el-table-column :label="t('admin.users.status')" width="150">
          <template #default="{ row }">
            <div class="flex flex-wrap gap-1">
              <el-tag v-if="row.disabled" type="danger" effect="light" round size="small">{{ t('admin.users.disabled') }}</el-tag>
              <el-tag v-else type="success" effect="light" round size="small">{{ t('admin.users.active') }}</el-tag>
              <el-tag v-if="!row.emailVerified" type="warning" effect="light" round size="small">{{ t('admin.users.unverified') }}</el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column :label="t('admin.users.joined')" width="120">
          <template #default="{ row }">
            <span class="admin-meta">{{ formatDate(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column width="170" align="right">
          <template #default="{ row }">
            <el-tooltip v-if="!row.emailVerified" :content="t('admin.users.verifyEmail')" placement="top">
              <el-button link type="primary" :icon="CircleCheck" :loading="saving === row.id" @click="verifyEmail(row)" />
            </el-tooltip>
            <template v-if="row.id !== authUser?.id">
              <el-button link :type="row.disabled ? 'primary' : 'warning'" :loading="saving === row.id" @click="toggleDisabled(row)">
                {{ row.disabled ? t('admin.users.enable') : t('admin.users.disable') }}
              </el-button>
              <el-tooltip :content="t('admin.users.delete')" placement="top">
                <el-button link type="danger" :icon="Delete" @click="removeUser(row)" />
              </el-tooltip>
            </template>
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
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh, Delete, CircleCheck } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import PageHeader from '@/components/common/PageHeader.vue';
import { adminErrorText } from './adminErrors';

const ROLES = ['admin', 'manager', 'user'];

const { t, locale } = useI18n();
const { user: authUser } = useAuth();

const users = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const query = ref('');
const roleFilter = ref('');
const loading = ref(false);
const saving = ref(null);

const formatDate = (value) => (value ? new Date(value).toLocaleDateString(locale.value === 'vi' ? 'vi-VN' : 'en-US') : '--');

const load = async () => {
  loading.value = true;
  try {
    const res = await api.adminListUsers({ q: query.value || undefined, role: roleFilter.value || undefined, page: page.value, limit: pageSize });
    users.value = res.data.users || [];
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

const update = async (row, data) => {
  saving.value = row.id;
  try {
    const res = await api.adminUpdateUser(row.id, data);
    Object.assign(row, res.data.user);
    ElMessage.success(t('admin.saved'));
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    saving.value = null;
  }
};

const changeRole = async (row, role) => {
  if (role === row.role) return;
  try {
    await ElMessageBox.confirm(
      t('admin.users.roleConfirm', { email: row.email, role: t(`roles.${role}`) }),
      t('admin.users.role'),
      { type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel') }
    );
  } catch {
    return;
  }
  update(row, { role });
};

const toggleDisabled = async (row) => {
  if (!row.disabled) {
    try {
      await ElMessageBox.confirm(t('admin.users.disableConfirm', { email: row.email }), t('admin.users.disable'), {
        type: 'warning',
        confirmButtonText: t('admin.users.disable'),
        cancelButtonText: t('common.cancel'),
      });
    } catch {
      return;
    }
  }
  update(row, { disabled: !row.disabled });
};

const verifyEmail = async (row) => {
  try {
    await ElMessageBox.confirm(t('admin.users.verifyEmailConfirm', { email: row.email }), t('admin.users.verifyEmail'), {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  update(row, { emailVerified: true });
};

const removeUser = async (row) => {
  try {
    await ElMessageBox.confirm(t('admin.users.deleteConfirm', { email: row.email }), t('admin.users.delete'), {
      type: 'error',
      confirmButtonText: t('admin.users.delete'),
      cancelButtonText: t('common.cancel'),
    });
  } catch {
    return;
  }
  try {
    await api.adminDeleteUser(row.id);
    ElMessage.success(t('admin.users.deleted'));
    load();
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
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
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
