<template>
  <div class="flex flex-col gap-4">
    <PageHeader :title="t('admin.upgrades.title')" :subtitle="t('admin.upgrades.subtitle')" />
    <el-radio-group v-model="status" size="small" @change="load">
      <el-radio-button v-for="s in ['pending', 'pending_owner', 'approved', 'rejected', '']" :key="s || 'all'" :value="s">{{ s ? t(`upgrade.status.${s}`) : t('admin.upgrades.all') }}</el-radio-button>
    </el-radio-group>
    <el-empty v-if="!loading && !rows.length" :description="t('admin.upgrades.none')" />
    <el-card v-for="r in rows" :key="r.id" shadow="never" :data-test="`upgrade-${r.id}`">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">{{ r.type === 'organization' ? t('upgrade.organization') : r.targetPlan.toUpperCase() }}</span>
            <el-tag size="small" round :type="statusType(r.status)">{{ t(`upgrade.status.${r.status}`) }}</el-tag>
            <span v-if="r.extraCameras" class="admin-meta">+{{ r.extraCameras }} {{ t('admin.upgrades.cameras') }}</span>
          </div>
          <span class="admin-meta">{{ r.requestedBy?.email }} · {{ r.workspace?.name || r.organization?.name || '' }} · {{ new Date(r.createdAt).toLocaleString() }}</span>
          <span v-if="r.organization" class="admin-meta">{{ t('admin.upgrades.orgLine', { cameras: r.organization.cameras ?? '-', members: r.organization.members ?? '-', phone: r.organization.phone || '-' }) }}</span>
          <span v-if="r.reason" class="admin-meta">{{ t('admin.upgrades.reason', { reason: r.reason }) }}</span>
          <p v-if="r.message" class="admin-message">{{ r.message }}</p>
          <p v-if="r.adminNote" class="admin-meta">{{ t('admin.upgrades.note') }}: {{ r.adminNote }}</p>
        </div>
        <div v-if="isAdmin && r.status === 'pending'" class="flex gap-2">
          <el-button type="primary" size="small" @click="openApprove(r)">{{ t('admin.upgrades.approve') }}</el-button>
          <el-button size="small" @click="openReject(r)">{{ t('admin.upgrades.reject') }}</el-button>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="approveOpen" :title="t('admin.upgrades.approveTitle')" width="440px" append-to-body>
      <el-form label-position="top">
        <el-form-item :label="t('admin.workspaces.plan')">
          <el-radio-group v-model="approve.plan">
            <el-radio-button v-for="p in ['free', 'pro', 'enterprise']" :key="p" :value="p">{{ p.toUpperCase() }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('admin.workspaces.addonCameras')"><el-input-number v-model="approve.addonCameras" :min="0" :max="100000" /></el-form-item>
        <el-form-item :label="t('admin.workspaces.expiresAt')"><el-date-picker v-model="approve.expiresAt" type="date" clearable class="!w-full" /></el-form-item>
        <el-form-item><el-checkbox v-model="approve.paid">{{ t('admin.upgrades.paid') }}</el-checkbox></el-form-item>
        <el-form-item :label="t('admin.upgrades.note')"><el-input v-model="approve.adminNote" type="textarea" :rows="2" maxlength="1000" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approveOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="busy" @click="doApprove">{{ t('admin.upgrades.approve') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="rejectOpen" :title="t('admin.upgrades.rejectTitle')" width="420px" append-to-body>
      <el-input v-model="rejectNote" type="textarea" :rows="3" maxlength="1000" :placeholder="t('admin.upgrades.rejectHint')" />
      <template #footer>
        <el-button @click="rejectOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="danger" :loading="busy" @click="doReject">{{ t('admin.upgrades.reject') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import PageHeader from '@/components/common/PageHeader.vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { requestErrorText } from '@/utils/requestError';

/** Admin > Upgrade requests: approve (plan, add-ons, expiry, paid) or reject with a note. */
const { t } = useI18n();
const { isAdmin } = useAuth();
const rows = ref([]);
const loading = ref(true);
const status = ref('pending');
const busy = ref(false);
const current = ref(null);
const approveOpen = ref(false);
const approve = reactive({ plan: 'pro', addonCameras: 0, expiresAt: null, paid: false, adminNote: '' });
const rejectOpen = ref(false);
const rejectNote = ref('');

const statusType = (s) => ({ approved: 'success', rejected: 'danger', cancelled: 'info' }[s] || 'warning');
const fail = (err) => ElNotification({ title: t('common.error'), message: requestErrorText(t, err, t('common.error')), type: 'error' });

async function load() {
  loading.value = true;
  try {
    const res = await api.adminGetUpgradeRequests(status.value);
    rows.value = res.data?.requests || [];
  } finally {
    loading.value = false;
  }
}

function openApprove(r) {
  current.value = r;
  Object.assign(approve, { plan: r.targetPlan, addonCameras: r.extraCameras || 0, expiresAt: null, paid: false, adminNote: '' });
  approveOpen.value = true;
}
function openReject(r) {
  current.value = r;
  rejectNote.value = '';
  rejectOpen.value = true;
}

async function doApprove() {
  busy.value = true;
  try {
    await api.adminApproveUpgrade(current.value.id, { ...approve, expiresAt: approve.expiresAt ? new Date(approve.expiresAt).toISOString() : null });
    approveOpen.value = false;
    load();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}
async function doReject() {
  busy.value = true;
  try {
    await api.adminRejectUpgrade(current.value.id, { adminNote: rejectNote.value });
    rejectOpen.value = false;
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
.admin-message {
  margin: 4px 0 0;
  font-size: 13px;
  white-space: pre-wrap;
}
</style>
