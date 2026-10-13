<template>
  <div>
    <PageHeader :title="t('integrations.title')" :subtitle="t('integrations.subtitle')" />

    <!-- API keys -->
    <el-card shadow="never" class="mb-4" v-loading="loadingKeys">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="int-label">{{ t('integrations.keys.title') }}</div>
            <p class="int-meta mt-1">{{ t('integrations.keys.desc') }}</p>
          </div>
          <el-button type="primary" :icon="Plus" @click="createKey">{{ t('integrations.keys.create') }}</el-button>
        </div>
      </template>
      <el-empty v-if="!keys.length" :description="t('integrations.keys.empty')" :image-size="64" />
      <template v-for="(k, idx) in keys" v-else :key="k.id">
        <el-divider v-if="idx > 0" class="!my-0" />
        <div class="py-2.5 flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="int-name truncate">{{ k.name }}</p>
            <p class="int-meta"><span class="font-mono">{{ k.prefix }}…</span> · {{ t('integrations.keys.lastUsed', { time: k.lastUsedAt ? formatTime(k.lastUsedAt) : t('integrations.never') }) }}</p>
          </div>
          <el-button :icon="Delete" text type="danger" @click="revokeKey(k)">{{ t('integrations.keys.revoke') }}</el-button>
        </div>
      </template>
    </el-card>

    <!-- Webhooks -->
    <el-card shadow="never" class="mb-4" v-loading="loadingHooks">
      <template #header>
        <div class="int-label">{{ t('integrations.hooks.title') }}</div>
        <p class="int-meta mt-1">{{ t('integrations.hooks.desc') }}</p>
      </template>

      <div class="flex flex-col gap-2 mb-4">
        <el-input v-model="newHook.url" placeholder="https://example.com/flybot-webhook" clearable />
        <div class="flex flex-wrap gap-2">
          <el-select :aria-label="t('integrations.hooks.events')" v-model="newHook.events" multiple collapse-tags collapse-tags-tooltip :placeholder="t('integrations.hooks.events')" class="flex-1 min-w-[220px]">
            <el-option v-for="e in events" :key="e" :label="eventLabel(e)" :value="e" />
          </el-select>
          <el-button type="primary" :icon="Plus" :loading="busy === 'create'" :disabled="!newHook.url || !newHook.events.length" @click="createHook">
            {{ t('integrations.hooks.create') }}
          </el-button>
        </div>
      </div>

      <el-empty v-if="!hooks.length" :description="t('integrations.hooks.empty')" :image-size="64" />
      <template v-for="(h, idx) in hooks" v-else :key="h.id">
        <el-divider v-if="idx > 0" class="!my-0" />
        <div class="py-3 flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="int-name font-mono truncate min-w-0 flex-1">{{ h.url }}</p>
            <div class="flex items-center gap-2">
              <el-switch :aria-label="t('integrations.hooks.activeLabel', { url: h.url })" :model-value="h.active" :loading="busy === `active:${h.id}`" @change="(v) => updateHook(h, { active: v })" />
              <el-button size="small" :icon="Promotion" :loading="busy === `test:${h.id}`" @click="testHook(h)">{{ t('integrations.hooks.test') }}</el-button>
              <el-button size="small" :icon="Delete" text type="danger" :aria-label="t('integrations.hooks.delete')" @click="deleteHook(h)" />
            </div>
          </div>
          <el-select :aria-label="t('integrations.hooks.events')"
            :model-value="h.events"
            multiple
            collapse-tags
            collapse-tags-tooltip
            size="small"
            class="max-w-md"
            @change="(v) => v.length && updateHook(h, { events: v })"
          >
            <el-option v-for="e in events" :key="e" :label="eventLabel(e)" :value="e" />
          </el-select>
          <p class="int-meta">
            <el-tag v-if="!h.active" size="small" type="info" effect="plain" round class="mr-1">{{ t('integrations.hooks.off') }}</el-tag>
            <template v-if="h.lastDeliveryAt">
              {{ t('integrations.hooks.lastDelivery', { time: formatTime(h.lastDeliveryAt) }) }}
              <el-tag size="small" :type="h.lastError ? 'danger' : 'success'" effect="light" round class="ml-1">{{ h.lastError || h.lastStatus }}</el-tag>
            </template>
            <template v-else>{{ t('integrations.hooks.noDelivery') }}</template>
          </p>
        </div>
      </template>
      <p class="int-meta mt-2">{{ t('integrations.hooks.docs') }}</p>
    </el-card>

    <!-- A new key or secret, shown once -->
    <el-dialog v-model="secretDialog.visible" :title="secretDialog.title" width="520px" append-to-body>
      <el-alert type="warning" :title="t('integrations.showOnce')" :closable="false" show-icon class="mb-3" />
      <el-input :model-value="secretDialog.value" readonly class="font-mono">
        <template #append>
          <el-button :icon="CopyDocument" @click="copySecret">{{ t('integrations.copy') }}</el-button>
        </template>
      </el-input>
      <p v-if="secretDialog.example" class="int-meta mt-3">{{ t('integrations.keys.example') }}</p>
      <el-input v-if="secretDialog.example" :model-value="secretDialog.example" type="textarea" :rows="2" readonly class="font-mono mt-1" />
      <template #footer>
        <el-button type="primary" @click="secretDialog.visible = false">{{ t('integrations.done') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Delete, Promotion, CopyDocument } from '@element-plus/icons-vue';
import api from '@/services/api';
import PageHeader from '@/components/common/PageHeader.vue';

const { t, locale } = useI18n();

const keys = ref([]);
const hooks = ref([]);
const events = ref([]);
const loadingKeys = ref(false);
const loadingHooks = ref(false);
const busy = ref(null);
const newHook = reactive({ url: '', events: ['pest_threshold', 'pest_surge'] });
const secretDialog = reactive({ visible: false, title: '', value: '', example: '' });

const formatTime = (value) => new Date(value).toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US');
const eventLabel = (e) => t(`notifications.types.${e}.title`);
const errorText = (err) => err.response?.data?.message || t('common.error');
const isCancel = (err) => err === 'cancel' || err === 'close';

const loadKeys = async () => {
  loadingKeys.value = true;
  try {
    keys.value = (await api.listApiKeys()).data.keys;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loadingKeys.value = false;
  }
};

const loadHooks = async () => {
  loadingHooks.value = true;
  try {
    const res = await api.listWebhooks();
    hooks.value = res.data.webhooks;
    events.value = res.data.events;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loadingHooks.value = false;
  }
};

const showSecret = (title, value, example = '') => Object.assign(secretDialog, { visible: true, title, value, example });

const copySecret = async () => {
  try {
    await navigator.clipboard.writeText(secretDialog.value);
    ElMessage.success(t('integrations.copied'));
  } catch {
    ElMessage.error(t('common.error'));
  }
};

const createKey = async () => {
  try {
    const { value } = await ElMessageBox.prompt(t('integrations.keys.namePrompt'), t('integrations.keys.create'), {
      inputValidator: (v) => !!v?.trim() || t('integrations.keys.nameRequired'),
      confirmButtonText: t('integrations.keys.create'),
      cancelButtonText: t('common.cancel')
    });
    const res = await api.createApiKey({ name: value.trim() });
    showSecret(t('integrations.keys.created'), res.data.key, `curl -H "Authorization: Bearer ${res.data.key}" ${window.location.origin}/api/v1/cameras`);
    await loadKeys();
  } catch (err) {
    if (!isCancel(err)) ElMessage.error(errorText(err));
  }
};

const revokeKey = async (k) => {
  try {
    await ElMessageBox.confirm(t('integrations.keys.revokeConfirm', { name: k.name }), t('integrations.keys.revoke'), {
      type: 'warning',
      confirmButtonText: t('integrations.keys.revoke'),
      cancelButtonText: t('common.cancel')
    });
    await api.revokeApiKey(k.id);
    await loadKeys();
  } catch (err) {
    if (!isCancel(err)) ElMessage.error(errorText(err));
  }
};

const createHook = async () => {
  busy.value = 'create';
  try {
    const res = await api.createWebhook({ url: newHook.url.trim(), events: newHook.events });
    showSecret(t('integrations.hooks.created'), res.data.secret);
    newHook.url = '';
    await loadHooks();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = null;
  }
};

const updateHook = async (h, patch) => {
  busy.value = patch.active !== undefined ? `active:${h.id}` : `events:${h.id}`;
  try {
    const updated = (await api.updateWebhook(h.id, patch)).data.webhook;
    hooks.value = hooks.value.map(x => (x.id === h.id ? updated : x));
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = null;
  }
};

const testHook = async (h) => {
  busy.value = `test:${h.id}`;
  try {
    const { result } = (await api.testWebhook(h.id)).data;
    if (result.ok) ElMessage.success(t('integrations.hooks.testOk', { status: result.status }));
    else ElMessage.error(t('integrations.hooks.testFailed', { error: result.error }));
    await loadHooks();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = null;
  }
};

const deleteHook = async (h) => {
  try {
    await ElMessageBox.confirm(t('integrations.hooks.deleteConfirm', { url: h.url }), t('integrations.hooks.delete'), {
      type: 'warning',
      confirmButtonText: t('integrations.hooks.delete'),
      cancelButtonText: t('common.cancel')
    });
    await api.deleteWebhook(h.id);
    await loadHooks();
  } catch (err) {
    if (!isCancel(err)) ElMessage.error(errorText(err));
  }
};

onMounted(() => {
  loadKeys();
  loadHooks();
});
</script>

<style scoped>
.int-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.int-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.int-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
