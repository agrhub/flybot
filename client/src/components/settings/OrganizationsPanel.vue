<template>
  <div v-loading="loading">
    <PageHeader :title="t('orgs.title')" :subtitle="t('orgs.subtitle')">
      <template v-if="canManageCameras" #actions>
        <el-button type="primary" :icon="Plus" @click="openCreate">{{ t('orgs.create') }}</el-button>
      </template>
    </PageHeader>

    <el-empty v-if="!loading && !orgs.length" :description="t('orgs.empty')" :image-size="80" />

    <el-card v-for="org in orgs" :key="org.id" shadow="never" class="mb-4">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0 flex items-center gap-2">
            <el-icon class="is-primary"><OfficeBuilding /></el-icon>
            <span class="org-name truncate">{{ org.name }}</span>
            <el-tag v-if="org.myRole" size="small" effect="light" round>{{ t(`orgs.roles.${org.myRole}`) }}</el-tag>
          </div>
          <div class="flex items-center gap-2">
            <span class="org-meta">{{ t('orgs.summary', { members: org.members.length, cameras: org.cameras.length, farms: org.farmCount }) }}</span>
            <el-dropdown v-if="org.myRole === 'owner' || isAdmin" trigger="click" @command="(cmd) => onOrgCommand(cmd, org)">
              <el-button :icon="MoreFilled" text circle :aria-label="t('orgs.actions')" />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename" :icon="Edit">{{ t('orgs.rename') }}</el-dropdown-item>
                  <el-dropdown-item command="delete" :icon="Delete" divided>{{ t('orgs.delete') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </template>

      <!-- Members -->
      <h4 class="org-section">{{ t('orgs.members') }}</h4>
      <div v-if="org.canManage" class="flex flex-wrap gap-2 mb-3">
        <el-input v-model="invite[org.id].email" :placeholder="t('orgs.emailPlaceholder')" class="!w-64" clearable @keyup.enter="addMember(org)" />
        <el-select v-model="invite[org.id].role" class="!w-36">
          <el-option v-for="role in assignableRoles(org)" :key="role" :label="t(`orgs.roles.${role}`)" :value="role" />
        </el-select>
        <el-button :icon="Plus" :loading="busy === `add:${org.id}`" @click="addMember(org)">{{ t('orgs.addMember') }}</el-button>
      </div>
      <template v-for="(m, idx) in org.members" :key="m.email">
        <el-divider v-if="idx > 0" class="!my-0" />
        <div class="py-2 flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="org-member truncate">{{ m.email }}</p>
            <p v-if="m.status === 'pending'" class="org-meta">{{ t('orgs.pending') }}</p>
          </div>
          <div class="flex items-center gap-2">
            <el-select
              v-if="canEditMember(org, m)"
              :model-value="m.role"
              size="small"
              class="!w-32"
              @change="(role) => updateMember(org, m, role)"
            >
              <el-option v-for="role in assignableRoles(org)" :key="role" :label="t(`orgs.roles.${role}`)" :value="role" />
            </el-select>
            <el-tag v-else size="small" type="info" effect="plain" round>{{ t(`orgs.roles.${m.role}`) }}</el-tag>
            <el-button
              v-if="canEditMember(org, m) || m.userId === myId"
              :icon="m.userId === myId ? SwitchButton : Delete"
              text
              circle
              :aria-label="m.userId === myId ? t('orgs.leave') : t('orgs.remove')"
              @click="removeMember(org, m)"
            />
          </div>
        </div>
      </template>

      <!-- Cameras -->
      <h4 class="org-section mt-4">{{ t('orgs.cameras') }}</h4>
      <div class="flex flex-wrap gap-2">
        <el-tag
          v-for="cam in org.cameras"
          :key="cam.deviceSerial"
          :closable="org.canManage && manageable.has(cam.deviceSerial)"
          :type="cam.status === 1 ? 'success' : 'info'"
          effect="light"
          @close="moveCameras(org, { remove: [cam.deviceSerial] })"
        >
          {{ cam.deviceName }}
        </el-tag>
        <span v-if="!org.cameras.length" class="org-meta">{{ t('orgs.noCameras') }}</span>
      </div>
      <div v-if="org.canManage && addableFor(org).length" class="flex flex-wrap gap-2 mt-3">
        <el-select v-model="cameraPick[org.id]" multiple collapse-tags :placeholder="t('orgs.pickCameras')" class="!w-72">
          <el-option v-for="cam in addableFor(org)" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial" />
        </el-select>
        <el-button :disabled="!cameraPick[org.id]?.length" :loading="busy === `cams:${org.id}`" @click="moveCameras(org, { add: cameraPick[org.id] })">
          {{ t('orgs.addCameras') }}
        </el-button>
      </div>
      <p v-if="org.canManage" class="org-meta mt-2">{{ t('orgs.camerasHint') }}</p>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, OfficeBuilding, MoreFilled, Edit, Delete, SwitchButton } from '@element-plus/icons-vue';
import api from '@/services/api';
import PageHeader from '@/components/common/PageHeader.vue';
import { useAuth } from '@/composables/useAuth';
import { useCameras } from '@/composables/useCameras';

const { t } = useI18n();
const { user, isAdmin, canManageCameras } = useAuth();
const { cameras, loadCameras } = useCameras();

const orgs = ref([]);
const loading = ref(false);
const busy = ref(null);
const invite = reactive({});
const cameraPick = reactive({});
const myId = computed(() => user.value?.id);

// Cameras I can move between organizations
const manageable = computed(() => new Set(cameras.value.filter(c => c.canManage).map(c => c.deviceSerial)));
const addableFor = (org) => cameras.value.filter(c => c.canManage && !org.cameras.some(oc => oc.deviceSerial === c.deviceSerial));
const isOwnerOf = (org) => org.myRole === 'owner' || isAdmin.value;
const assignableRoles = (org) => (isOwnerOf(org) ? ['member', 'manager', 'owner'] : ['member']);
const canEditMember = (org, m) => m.userId !== myId.value && (isOwnerOf(org) || (org.canManage && m.role === 'member'));

const errorText = (err) => err.response?.data?.message || t('common.error');

const apply = (list) => {
  orgs.value = list;
  for (const org of list) {
    if (!invite[org.id]) invite[org.id] = { email: '', role: 'member' };
  }
};

const replace = (org) => apply(orgs.value.map(o => (o.id === org.id ? org : o)));

const load = async () => {
  loading.value = true;
  try {
    apply((await api.listOrgs()).data.organizations);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
};

const openCreate = async () => {
  try {
    const { value } = await ElMessageBox.prompt(t('orgs.namePrompt'), t('orgs.create'), {
      inputValidator: (v) => !!v?.trim() || t('orgs.nameRequired'),
      confirmButtonText: t('common.save'),
      cancelButtonText: t('common.cancel')
    });
    await api.createOrg({ name: value.trim() });
    await load();
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(errorText(err));
  }
};

const onOrgCommand = async (cmd, org) => {
  try {
    if (cmd === 'rename') {
      const { value } = await ElMessageBox.prompt(t('orgs.namePrompt'), t('orgs.rename'), {
        inputValue: org.name,
        inputValidator: (v) => !!v?.trim() || t('orgs.nameRequired'),
        confirmButtonText: t('common.save'),
        cancelButtonText: t('common.cancel')
      });
      replace((await api.updateOrg(org.id, { name: value.trim() })).data.organization);
    } else if (cmd === 'delete') {
      await ElMessageBox.confirm(t('orgs.deleteConfirm', { name: org.name }), t('orgs.delete'), {
        type: 'warning',
        confirmButtonText: t('orgs.delete'),
        cancelButtonText: t('common.cancel')
      });
      await api.deleteOrg(org.id);
      await Promise.all([load(), loadCameras()]);
    }
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(errorText(err));
  }
};

const addMember = async (org) => {
  const { email, role } = invite[org.id];
  if (!email?.trim()) return;
  busy.value = `add:${org.id}`;
  try {
    const res = await api.addOrgMember(org.id, { email: email.trim(), role });
    replace(res.data.organization);
    invite[org.id].email = '';
    ElMessage.success(res.data.invited ? t('orgs.invited') : t('orgs.added'));
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = null;
  }
};

const updateMember = async (org, m, role) => {
  try {
    replace((await api.updateOrgMember(org.id, { email: m.email, role })).data.organization);
  } catch (err) {
    ElMessage.error(errorText(err));
  }
};

const removeMember = async (org, m) => {
  const leaving = m.userId === myId.value;
  try {
    await ElMessageBox.confirm(
      leaving ? t('orgs.leaveConfirm', { name: org.name }) : t('orgs.removeConfirm', { email: m.email }),
      leaving ? t('orgs.leave') : t('orgs.remove'),
      { type: 'warning', confirmButtonText: leaving ? t('orgs.leave') : t('orgs.remove'), cancelButtonText: t('common.cancel') }
    );
    const res = await api.removeOrgMember(org.id, { email: m.email });
    if (leaving) await load();
    else replace(res.data.organization);
    await loadCameras();
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(errorText(err));
  }
};

const moveCameras = async (org, change) => {
  busy.value = `cams:${org.id}`;
  try {
    await api.setOrgCameras(org.id, change);
    cameraPick[org.id] = [];
    // A camera moved here leaves its previous organization
    await Promise.all([load(), loadCameras()]);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = null;
  }
};

onMounted(load);
</script>

<style scoped>
.org-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.org-section {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.org-member {
  margin: 0;
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.org-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.is-primary { color: var(--el-color-primary); }
</style>
