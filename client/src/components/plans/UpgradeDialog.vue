<template>
  <el-dialog v-model="state.open" :title="isOrganization ? t('upgrade.orgTitle') : t('upgrade.title')" :width="isMobile ? '94%' : '480px'" append-to-body data-test="upgrade-dialog" @closed="reset">
    <el-result v-if="sent" icon="success" :title="t('upgrade.sentTitle')" :sub-title="sent.status === 'pending_owner' ? t('upgrade.sentOwner') : t('upgrade.sentAdmin')" data-test="upgrade-sent" />

    <template v-else>
      <el-alert v-if="limitText" type="warning" :closable="false" show-icon :title="limitText" class="mb-4" data-test="upgrade-limit" />

      <el-form label-position="top" @submit.prevent="submit">
        <template v-if="isOrganization">
          <el-form-item :label="t('upgrade.orgName')">
            <el-input v-model="form.orgName" maxlength="120" data-test="org-name" />
          </el-form-item>
          <div class="grid grid-cols-2 gap-3">
            <el-form-item :label="t('upgrade.orgCameras')">
              <el-input-number v-model="form.orgCameras" :min="0" :max="100000" class="!w-full" />
            </el-form-item>
            <el-form-item :label="t('upgrade.orgMembers')">
              <el-input-number v-model="form.orgMembers" :min="0" :max="100000" class="!w-full" />
            </el-form-item>
          </div>
          <el-form-item :label="t('upgrade.phone')">
            <el-input v-model="form.phone" maxlength="40" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item :label="t('upgrade.plan')">
            <el-radio-group v-model="form.targetPlan">
              <el-radio-button v-for="code in ['pro', 'enterprise']" :key="code" :value="code">{{ code.toUpperCase() }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('upgrade.extraCameras')">
            <el-input-number v-model="form.extraCameras" :min="0" :max="10000" />
          </el-form-item>
        </template>
        <el-form-item :label="t('upgrade.message')">
          <el-input v-model="form.message" type="textarea" :rows="3" maxlength="1000" show-word-limit :placeholder="t('upgrade.messageHint')" />
        </el-form-item>
        <p class="upgrade-note">{{ t('upgrade.paymentNote') }}</p>
        <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" class="mt-3" />
      </el-form>
    </template>

    <template #footer>
      <el-button v-if="sent" type="primary" @click="closeUpgradeDialog">{{ t('common.close') }}</el-button>
      <template v-else>
        <el-button @click="closeUpgradeDialog">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="sending" :disabled="isOrganization && !form.orgName.trim()" data-test="upgrade-submit" @click="submit">{{ t('upgrade.send') }}</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';
import { useUpgrade } from '@/composables/useUpgrade';
import { useBreakpoints } from '@/composables/useBreakpoints';

/**
 * "Ask for an upgrade": a bigger plan or more cameras for the current workspace, or (hybrid)
 * a new organization. The admin approves it; payment is arranged with them.
 */
const { t } = useI18n();
const { state, closeUpgradeDialog } = useUpgrade();
const { isMobile } = useBreakpoints();

const form = reactive({ targetPlan: 'pro', extraCameras: 0, message: '', orgName: '', orgCameras: 0, orgMembers: 0, phone: '' });
const sending = ref(false);
const error = ref('');
const sent = ref(null);

const isOrganization = computed(() => state.detail?.type === 'organization');
const limitText = computed(() => {
  const d = state.detail || {};
  if (!d.limit) return '';
  const key = `upgrade.limits.${d.limit}`;
  const known = ['cameras', 'members', 'deepAnalysis', 'apiAndWebhooks', 'pdfReports', 'telegram'].includes(d.limit);
  return known ? t(key, { used: d.used ?? '-', max: d.max ?? '-' }) : (d.message || t('upgrade.limits.generic'));
});

watch(() => state.open, (open) => {
  if (!open) return;
  const d = state.detail || {};
  if (d.targetPlan) form.targetPlan = d.targetPlan;
  else if (d.plan === 'pro') form.targetPlan = 'enterprise';
});

function reset() {
  Object.assign(form, { targetPlan: 'pro', extraCameras: 0, message: '', orgName: '', orgCameras: 0, orgMembers: 0, phone: '' });
  error.value = '';
  sent.value = null;
}

async function submit() {
  if (sending.value) return;
  sending.value = true;
  error.value = '';
  try {
    const body = isOrganization.value
      ? { type: 'organization', message: form.message, organization: { name: form.orgName.trim(), cameras: form.orgCameras, members: form.orgMembers, phone: form.phone.trim() } }
      : { type: 'plan', targetPlan: form.targetPlan, extraCameras: form.extraCameras, message: form.message, reason: state.detail?.limit || '' };
    const res = await api.createUpgradeRequest(body);
    sent.value = res.data?.request || { status: 'pending' };
  } catch (err) {
    const code = err.response?.data?.code;
    error.value = code === 'ALREADY_PENDING' ? t('upgrade.errors.pending') : (err.response?.data?.message || t('upgrade.errors.generic'));
  } finally {
    sending.value = false;
  }
}
</script>

<style scoped>
.upgrade-note {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
