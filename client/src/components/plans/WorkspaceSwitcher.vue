<template>
  <!-- Only for someone in more than one workspace (personal + organizations) -->
  <el-dropdown v-if="count > 1" trigger="click" @command="choose" @visible-change="(open) => open && ensureLoaded()">
    <el-button class="ws-switch" data-test="workspace-switcher" :aria-label="t('workspace.switch')">
      <el-icon class="mr-1"><component :is="current?.kind === 'personal' ? User : OfficeBuilding" /></el-icon>
      <span class="ws-switch__name">{{ current?.name || t('workspace.none') }}</span>
      <el-icon class="ml-1"><ArrowDown /></el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item v-for="ws in workspaces" :key="ws.id" :command="ws.id" :disabled="ws.id === current?.id" :data-test="`workspace-${ws.id}`">
          <div class="flex items-center gap-2">
            <el-icon><component :is="ws.kind === 'personal' ? User : OfficeBuilding" /></el-icon>
            <span class="ws-item__name">{{ ws.name }}</span>
            <el-tag size="small" effect="plain" round>{{ ws.plan.toUpperCase() }}</el-tag>
            <el-tag v-if="ws.kind === 'personal'" size="small" type="info" effect="plain" round>{{ t('workspace.personal') }}</el-tag>
          </div>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDown, User, OfficeBuilding } from '@element-plus/icons-vue';
import { useAuth } from '@/composables/useAuth';
import { useWorkspace } from '@/composables/useWorkspace';

const { t } = useI18n();
const { user } = useAuth();
const { workspaces, loaded, load, switchTo } = useWorkspace();

const count = computed(() => user.value?.workspaceCount || 0);
const current = computed(() => user.value?.workspace || null);

const ensureLoaded = () => (loaded.value ? null : load());
const choose = (id) => {
  if (id && id !== current.value?.id) switchTo(id);
};
</script>

<style scoped>
.ws-switch {
  max-width: 220px;
}
.ws-switch__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}
.ws-item__name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
