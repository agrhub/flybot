<template>
  <div>
    <PageHeader :title="t('audit.title')" :subtitle="t('audit.subtitle')">
      <template #actions>
        <el-button :icon="Download" :loading="exporting" @click="exportCsv">{{ t('audit.export') }}</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <el-select v-model="category" :placeholder="t('audit.allCategories')" clearable class="!w-48" @change="reload">
          <el-option v-for="c in CATEGORIES" :key="c" :label="t(`audit.categories.${c}`)" :value="c" />
        </el-select>
        <el-input
          v-model="query"
          :placeholder="t('audit.search')"
          :prefix-icon="Search"
          clearable
          class="!w-64"
          @input="debouncedReload"
          @clear="reload"
        />
        <el-date-picker
          v-model="range"
          type="daterange"
          unlink-panels
          :start-placeholder="t('audit.from')"
          :end-placeholder="t('audit.to')"
          class="!w-72"
          @change="reload"
        />
        <el-button :icon="Refresh" @click="load">{{ t('common.refresh') }}</el-button>
      </div>

      <el-table v-loading="loading" :data="entries" row-key="id" style="width: 100%" :empty-text="t('audit.empty')">
        <el-table-column :label="t('audit.time')" width="160">
          <template #default="{ row }">
            <el-tooltip :content="formatFull(row.createdAt)" placement="top">
              <span class="audit-meta">{{ formatShort(row.createdAt) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>

        <el-table-column :label="t('audit.action')" min-width="200">
          <template #default="{ row }">
            <el-tag :type="ACTION_TAG[row.action] || 'info'" effect="light" size="small">
              {{ te(`audit.actions.${row.action}`) ? t(`audit.actions.${row.action}`) : row.action }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column :label="t('audit.actor')" min-width="190">
          <template #default="{ row }">
            <span class="truncate">{{ row.actor.email || t('audit.system') }}</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('audit.target')" min-width="180">
          <template #default="{ row }">
            <div v-if="row.target.label || row.target.id" class="min-w-0">
              <div class="truncate">{{ row.target.label || row.target.id }}</div>
              <div v-if="row.target.label && row.target.id && row.target.type === 'camera'" class="audit-meta font-mono">{{ row.target.id }}</div>
            </div>
            <span v-else class="audit-meta">--</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('audit.details')" min-width="220">
          <template #default="{ row }">
            <span class="audit-body">{{ detailText(row) }}</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('audit.ip')" width="130">
          <template #default="{ row }">
            <el-tooltip :content="row.userAgent || '--'" placement="top" :disabled="!row.userAgent">
              <span class="audit-meta font-mono">{{ row.ip || '--' }}</span>
            </el-tooltip>
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
      <p class="audit-meta mt-3">{{ t('audit.retention') }}</p>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { Search, Refresh, Download } from '@element-plus/icons-vue';
import api from '@/services/api';
import PageHeader from '@/components/common/PageHeader.vue';
import { adminErrorText } from './adminErrors';

const CATEGORIES = ['auth', 'user', 'camera', 'dashboard', 'farm', 'treatment', 'settings'];
// Color by risk: red for destructive or failed, orange for access changes
const ACTION_TAG = {
  'auth.login_failed': 'danger',
  'user.deleted': 'danger',
  'camera.deleted': 'danger',
  'dashboard.deleted': 'danger',
  'treatment.deleted': 'danger',
  'farm.deleted': 'danger',
  'farm.shared': 'warning',
  'user.disabled': 'warning',
  'user.role_changed': 'warning',
  'camera.transferred': 'warning',
  'camera.shared': 'warning',
  'dashboard.shared': 'warning',
  'dashboard.published': 'warning',
  'settings.updated': 'warning',
  'auth.login': 'success',
  'auth.register': 'success',
};

const { t, te, locale } = useI18n();

const entries = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 50;
const category = ref('');
const query = ref('');
const range = ref(null);
const loading = ref(false);
const exporting = ref(false);

const dateLocale = () => (locale.value === 'vi' ? 'vi-VN' : 'en-US');
const formatShort = (value) => new Date(value).toLocaleString(dateLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const formatFull = (value) => new Date(value).toLocaleString(dateLocale());

const params = () => {
  const p = { category: category.value || undefined, q: query.value.trim() || undefined };
  if (range.value?.[0]) p.from = new Date(range.value[0]).toISOString();
  if (range.value?.[1]) {
    const end = new Date(range.value[1]);
    end.setHours(23, 59, 59, 999);
    p.to = end.toISOString();
  }
  return p;
};

const fieldName = (field) => (te(`audit.fields.${field}`) ? t(`audit.fields.${field}`) : field);
const roleName = (role) => (te(`roles.${role}`) ? t(`roles.${role}`) : role);

// One readable line per entry; unknown shapes fall back to "key: value"
const detailText = (row) => {
  const d = row.details || {};
  switch (row.action) {
    case 'user.role_changed':
      return `${roleName(d.from)} → ${roleName(d.to)}`;
    case 'camera.transferred':
      return `${d.from || '--'} → ${d.to}${d.keptAccess ? ` (${t('audit.keptAccess')})` : ''}`;
    case 'camera.shared':
    case 'dashboard.shared':
      return d.invited ? `${d.email} (${t('audit.invited')})` : d.email;
    case 'camera.unshared':
    case 'dashboard.unshared':
      return d.email;
    case 'camera.updated':
      return (d.fields || []).map(fieldName).join(', ');
    case 'auth.login_failed':
      return te(`audit.reasons.${d.reason}`) ? t(`audit.reasons.${d.reason}`) : d.reason;
    case 'settings.updated':
      return Object.entries(d).map(([k, v]) => `${fieldName(k)}: ${v}`).join(', ');
    default: {
      const pairs = Object.entries(d).filter(([, v]) => v !== '' && v !== null);
      return pairs.length ? pairs.map(([k, v]) => `${fieldName(k)}: ${Array.isArray(v) ? v.join(', ') : v}`).join(', ') : '';
    }
  }
};

const load = async () => {
  loading.value = true;
  try {
    const res = await api.adminAuditLog({ ...params(), page: page.value, limit: pageSize });
    entries.value = res.data.entries || [];
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
const debouncedReload = () => {
  clearTimeout(timer);
  timer = setTimeout(reload, 350);
};

const exportCsv = async () => {
  exporting.value = true;
  try {
    const res = await api.exportAuditLog(params());
    const url = URL.createObjectURL(res.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = `flybot-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    ElMessage.error(adminErrorText(t, err));
  } finally {
    exporting.value = false;
  }
};

onMounted(load);
</script>

<style scoped>
.audit-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.audit-body {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>
