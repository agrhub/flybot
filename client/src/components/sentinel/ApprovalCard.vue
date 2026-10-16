<template>
  <el-card shadow="never" class="approval-card" :class="{ 'is-pending': pending, 'is-focused': focused }" data-test="approval-card" :data-status="a.status">
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="section-title">{{ kindName(a.kind) }}: {{ actionLabel }}</div>
          <div class="section-subtitle">
            <span class="font-mono">{{ (a.cameras || []).join(', ') }}</span>
            · {{ t('sentinel.approvals.createdAt', { time: dateTime(a.created_at, locale) }) }}
          </div>
        </div>
        <el-tag :type="STATUS_TAG[a.status] || 'info'" effect="light" round data-test="status-pill">{{ statusName(a.status) }}</el-tag>
      </div>
    </template>

    <el-descriptions :column="isMobile ? 1 : 2" size="small" border>
      <el-descriptions-item :label="t('sentinel.approvals.why')" :span="isMobile ? 1 : 2">{{ info.reason || t('sentinel.common.none') }}</el-descriptions-item>
      <el-descriptions-item v-if="info.date" :label="t('sentinel.approvals.date')">{{ info.date }}</el-descriptions-item>
      <el-descriptions-item v-if="pending" :label="t('sentinel.approvals.expires')">
        <span data-test="expires">
          {{ dateTime(a.expires_at, locale) }}
          <span class="meta-text">({{ left !== null && left < 0 ? statusName('expired') : relative(a.expires_at, locale) }})</span>
        </span>
      </el-descriptions-item>
      <el-descriptions-item v-if="pending" :label="t('sentinel.approvals.onTimeoutLabel')">{{ a.on_timeout || 'no_op' }}</el-descriptions-item>
      <el-descriptions-item v-if="!pending && a.decided_at" :label="t('sentinel.approvals.decided')">
        <span data-test="decided">
          <template v-if="a.decided_by">{{ t('sentinel.approvals.decidedBy', { by: a.decided_by }) }} · </template>{{ dateTime(a.decided_at, locale) }}
        </span>
      </el-descriptions-item>
    </el-descriptions>

    <el-collapse v-if="a.payload && Object.keys(a.payload).length" class="approval-raw">
      <el-collapse-item :title="t('sentinel.approvals.payload')" name="payload">
        <pre class="approval-pre">{{ JSON.stringify(a.payload, null, 2) }}</pre>
      </el-collapse-item>
    </el-collapse>

    <div v-if="images.length" class="mt-3">
      <div class="section-label">{{ t('sentinel.approvals.evidence') }}</div>
      <EvidenceGallery :images="images" />
    </div>

    <div class="flex flex-wrap items-center gap-2 mt-4">
      <!-- Admins and managers decide; everyone else sees the state only -->
      <template v-if="pending && canDecide">
        <el-button type="primary" :icon="Check" :loading="busy === 'approve'" :disabled="!!busy" data-test="approve" @click="decide('approve')">
          {{ t('sentinel.approvals.approve') }}
        </el-button>
        <el-button type="danger" plain :icon="Close" :loading="busy === 'reject'" :disabled="!!busy" data-test="reject" @click="decide('reject')">
          {{ t('sentinel.approvals.reject') }}
        </el-button>
      </template>
      <el-button v-if="a.flybot_proposal_id" :icon="ChatDotRound" data-test="open-assistant" @click="showProposalInAssistant(a.flybot_proposal_id)">
        {{ t('sentinel.approvals.openInAssistant') }}
      </el-button>
      <el-button link type="primary" :icon="View" @click="router.push({ name: 'sentinel-traces', query: { id: a.event_id } })">
        {{ t('sentinel.approvals.viewTrace') }}
      </el-button>
    </div>
    <p v-if="pending && !canDecide" class="meta-text mt-2" data-test="read-only">{{ t('sentinel.approvals.readOnly') }}</p>
    <el-alert v-if="message" :type="message.type" :title="message.text" :closable="false" show-icon class="mt-3" data-test="message" />
  </el-card>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ElMessageBox, ElNotification } from 'element-plus';
import { Check, Close, ChatDotRound, View } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useTheme } from '@/utils/theme';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { sentinelGet, noteSentinelError } from '@/composables/useSentinel';
import EvidenceGallery from './EvidenceGallery.vue';
import { submitDecision, DecisionError, describeProposal, secondsLeft, STATUS_TAG } from '@/utils/sentinel/approvals';
import { collectImages } from '@/utils/sentinel/trace';
import { dateTime, relative } from '@/utils/sentinel/time';

/**
 * One Sentinel proposal (treatment or card change). Approve / Reject go through FlyBot's proxy,
 * which records who decided; the card then waits for the agent to apply it.
 */
const props = defineProps({
  approval: { type: Object, required: true },
  canDecide: { type: Boolean, default: false },
  focused: { type: Boolean, default: false },
  // Poll interval after a decision (tests use 0)
  intervalMs: { type: Number, default: 1500 },
});
const emit = defineEmits(['decided', 'refresh']);

const { t, te, locale } = useI18n();
const router = useRouter();
const { isMobile } = useBreakpoints();
const { showProposalInAssistant } = useTheme();

const a = computed(() => props.approval);
const pending = computed(() => a.value.status === 'pending');
const info = computed(() => describeProposal(a.value));
const images = computed(() => collectImages({ approval: a.value }));
const left = computed(() => secondsLeft(a.value));
const busy = ref('');
const message = ref(null);

const statusName = (s) => (te(`sentinel.approvals.status.${s}`) ? t(`sentinel.approvals.status.${s}`) : s);
const kindName = (k) => (te(`sentinel.approvals.kind.${k}`) ? t(`sentinel.approvals.kind.${k}`) : k);
const actionLabel = computed(() => {
  const k = info.value.title;
  return te(`sentinel.approvals.action.${k}`) ? t(`sentinel.approvals.action.${k}`) : k;
});

async function decide(decision) {
  try {
    await ElMessageBox.confirm(
      t(decision === 'approve' ? 'sentinel.approvals.confirmApprove' : 'sentinel.approvals.confirmReject', { what: `${kindName(a.value.kind)}: ${actionLabel.value}` }),
      t(decision === 'approve' ? 'sentinel.approvals.approve' : 'sentinel.approvals.reject'),
      {
        type: decision === 'approve' ? 'info' : 'warning',
        confirmButtonText: t(decision === 'approve' ? 'sentinel.approvals.approve' : 'sentinel.approvals.reject'),
        cancelButtonText: t('common.cancel'),
      },
    );
  } catch {
    return;
  }
  busy.value = decision;
  message.value = { type: 'info', text: t('sentinel.approvals.sending') };
  try {
    const res = await submitDecision({
      id: a.value.approval_id,
      decision,
      canDecide: props.canDecide,
      decide: async (id, d) => (await api.sentinelDecide(id, d)).data,
      fetchApproval: (id) => sentinelGet(`approvals/${encodeURIComponent(id)}`),
      intervalMs: props.intervalMs,
    });
    if (res.timedOut) {
      message.value = { type: 'info', text: t('sentinel.approvals.stillQueued') };
    } else {
      message.value = { type: 'success', text: t('sentinel.approvals.done', { status: statusName(res.status) }) };
      ElNotification({ title: t('common.success'), message: message.value.text, type: 'success', duration: 3000 });
      emit('decided', res.approval);
    }
  } catch (err) {
    if (err instanceof DecisionError) {
      message.value = { type: 'error', text: t('sentinel.errors.forbidden') };
    } else {
      const kind = noteSentinelError(err);
      message.value = { type: kind === 'conflict' ? 'warning' : 'error', text: t(`sentinel.errors.${kind}`) };
      if (kind === 'conflict') emit('refresh');
    }
  } finally {
    busy.value = '';
  }
}
</script>

<style scoped>
.approval-card.is-pending {
  border-left: 3px solid var(--el-color-warning);
}
.approval-card.is-focused {
  border-color: var(--el-color-primary);
}
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.section-label {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.approval-raw {
  margin-top: 8px;
  border: none;
}
.approval-raw :deep(.el-collapse-item__header) {
  font-size: 13px;
  color: var(--el-color-primary);
  border-bottom: none;
}
.approval-raw :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}
.approval-pre {
  margin: 0;
  padding: 8px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
</style>
