<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('admin.workspaces.title')" :subtitle="t('admin.workspaces.subtitle')">
      <template #actions>
        <el-button v-if="isAdmin && appMode !== 'b2c'" type="primary" :icon="Plus" @click="createOpen = true">{{ t('admin.workspaces.createOrg') }}</el-button>
      </template>
    </PageHeader>
    <div class="flex flex-wrap gap-2">
      <el-input v-model="q" :placeholder="t('admin.workspaces.search')" clearable class="!w-64" @change="load" />
      <el-select v-model="kind" clearable :placeholder="t('admin.workspaces.kind')" class="!w-44" @change="load">
        <el-option value="personal" :label="t('workspace.personal')" />
        <el-option value="organization" :label="t('workspace.organization')" />
      </el-select>
      <el-select v-model="plan" clearable :placeholder="t('admin.workspaces.plan')" class="!w-40" @change="load">
        <el-option v-for="p in ['free', 'pro', 'enterprise']" :key="p" :value="p" :label="p.toUpperCase()" />
      </el-select>
    </div>
    <el-table v-loading="loading" :data="rows" size="small" data-test="admin-workspaces">
      <el-table-column :label="t('admin.workspaces.name')" min-width="180">
        <template #default="{ row }">
          <div class="font-medium">{{ row.name }}</div>
          <div class="admin-meta">{{ row.owner || '-' }}</div>
        </template>
      </el-table-column>
      <el-table-column :label="t('admin.workspaces.kind')" width="130">
        <template #default="{ row }"><el-tag size="small" effect="plain" round>{{ row.kind === 'personal' ? t('workspace.personal') : t('workspace.organization') }}</el-tag></template>
      </el-table-column>
      <el-table-column :label="t('admin.workspaces.plan')" width="170">
        <template #default="{ row }">
          <el-tag size="small" round>{{ row.plan.code.toUpperCase() }}</el-tag>
          <span v-if="row.plan.addonCameras" class="admin-meta ml-1">+{{ row.plan.addonCameras }}</span>
          <div v-if="row.plan.expiresAt" class="admin-meta">{{ new Date(row.plan.expiresAt).toLocaleDateString() }}</div>
        </template>
      </el-table-column>
      <el-table-column :label="t('admin.workspaces.usage')" width="140">
        <template #default="{ row }">{{ t('admin.workspaces.usageText', { cameras: row.cameras, members: row.members }) }}</template>
      </el-table-column>
      <el-table-column v-if="isAdmin" width="110" align="right">
        <template #default="{ row }"><el-button link type="primary" @click="openAssign(row)">{{ t('admin.workspaces.assign') }}</el-button></template>
      </el-table-column>
    </el-table>

    <!-- Assign a plan -->
    <el-dialog v-model="assignOpen" :title="t('admin.workspaces.assignTitle', { name: assignRow?.name || '' })" width="440px" append-to-body>
      <el-form label-position="top">
        <el-form-item :label="t('admin.workspaces.plan')">
          <el-radio-group v-model="assign.plan">
            <el-radio-button v-for="p in ['free', 'pro', 'enterprise']" :key="p" :value="p">{{ p.toUpperCase() }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('admin.workspaces.addonCameras')"><el-input-number v-model="assign.addonCameras" :min="0" :max="100000" /></el-form-item>
        <el-form-item :label="t('admin.workspaces.expiresAt')"><el-date-picker v-model="assign.expiresAt" type="date" clearable class="!w-full" /></el-form-item>
        <el-form-item :label="t('admin.workspaces.note')"><el-input v-model="assign.note" maxlength="500" /></el-form-item>
        <el-form-item :label="t('admin.workspaces.billingNote')"><el-input v-model="assign.billingNote" type="textarea" :rows="2" maxlength="1000" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="busy" @click="saveAssign">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- New organization -->
    <el-dialog v-model="createOpen" :title="t('admin.workspaces.createOrg')" width="440px" append-to-body>
      <el-form label-position="top">
        <el-form-item :label="t('admin.workspaces.name')"><el-input v-model="create.name" maxlength="100" /></el-form-item>
        <el-form-item :label="t('admin.workspaces.ownerEmail')"><el-input v-model="create.ownerEmail" type="email" /></el-form-item>
        <el-form-item :label="t('admin.workspaces.plan')">
          <el-radio-group v-model="create.plan">
            <el-radio-button v-for="p in ['free', 'pro', 'enterprise']" :key="p" :value="p">{{ p.toUpperCase() }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="busy" :disabled="!create.name.trim() || !create.ownerEmail.trim()" @click="saveCreate">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import PageHeader from '@/components/common/PageHeader.vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { requestErrorText } from '@/utils/requestError';

/** Admin > Workspaces: every personal workspace and organization, its plan, add-ons and expiry. */
const { t } = useI18n();
const { isAdmin, appMode } = useAuth();
const rows = ref([]);
const loading = ref(true);
const q = ref('');
const kind = ref('');
const plan = ref('');
const busy = ref(false);

const assignOpen = ref(false);
const assignRow = ref(null);
const assign = reactive({ plan: 'free', addonCameras: 0, expiresAt: null, note: '', billingNote: '' });
const createOpen = ref(false);
const create = reactive({ name: '', ownerEmail: '', plan: 'enterprise' });

const fail = (err) => ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('common.error')), type: 'error' });

async function load() {
  loading.value = true;
  try {
    const res = await api.adminGetWorkspaces({ ...(q.value ? { q: q.value } : {}), ...(kind.value ? { kind: kind.value } : {}), ...(plan.value ? { plan: plan.value } : {}) });
    rows.value = res.data?.workspaces || [];
  } finally {
    loading.value = false;
  }
}

function openAssign(row) {
  assignRow.value = row;
  Object.assign(assign, { plan: row.plan.code, addonCameras: row.plan.addonCameras || 0, expiresAt: row.plan.expiresAt ? new Date(row.plan.expiresAt) : null, note: row.plan.note || '', billingNote: row.billingNote || '' });
  assignOpen.value = true;
}

async function saveAssign() {
  busy.value = true;
  try {
    await api.adminAssignPlan(assignRow.value.id, { ...assign, expiresAt: assign.expiresAt ? new Date(assign.expiresAt).toISOString() : null });
    assignOpen.value = false;
    load();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

async function saveCreate() {
  busy.value = true;
  try {
    await api.adminCreateOrganization({ name: create.name.trim(), ownerEmail: create.ownerEmail.trim(), plan: create.plan });
    createOpen.value = false;
    Object.assign(create, { name: '', ownerEmail: '', plan: 'enterprise' });
    load();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.admin-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
