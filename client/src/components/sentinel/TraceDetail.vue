<template>
  <div class="trace-detail" data-test="trace-detail">
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <!-- 1. Perception: what OpenCV saw -->
      <section class="trace-step" :aria-labelledby="`perc-${uid}`">
        <div :id="`perc-${uid}`" class="trace-step__title">
          <span class="trace-step__num">1</span>{{ t('sentinel.traces.perception') }}
        </div>
        <template v-if="facts">
          <div class="trace-counts" data-test="counts">
            <div v-for="key in ['opencv', 'npu', 'production']" :key="key" class="trace-count">
              <span class="meta-text">{{ t(`sentinel.traces.source.${key}`) }}</span>
              <span class="trace-count__value" :data-test="`count-${key}`">{{ fmt(facts.counts[key]) }}</span>
            </div>
          </div>
          <p v-if="facts.spread !== null" class="meta-text mt-1">{{ t('sentinel.traces.spread', { n: facts.spread }) }}</p>

          <div class="section-label">{{ t('sentinel.traces.quality') }}</div>
          <div class="flex flex-wrap items-center gap-1.5">
            <el-tag v-if="facts.quality.ok && !facts.quality.issues.length" type="success" effect="light" size="small" round data-test="quality-ok">{{ t('sentinel.traces.qualityOk') }}</el-tag>
            <el-tag v-for="i in facts.quality.issues" :key="i" type="danger" effect="light" size="small" round data-test="quality-issue">{{ issueLabel(i) }}</el-tag>
            <span v-if="facts.quality.score !== null" class="meta-text">{{ t('sentinel.traces.score', { n: facts.quality.score }) }}</span>
          </div>
          <p v-if="facts.quality.scores.length" class="meta-text font-mono mt-1">{{ facts.quality.scores.map(([k, v]) => `${k} ${v}`).join(' · ') }}</p>

          <el-descriptions :column="1" size="small" border class="mt-3">
            <el-descriptions-item v-if="facts.saturationPct !== null" :label="t('sentinel.traces.saturation')">
              <span data-test="saturation">{{ facts.saturationPct }} %</span>
            </el-descriptions-item>
            <el-descriptions-item v-if="facts.registration" :label="t('sentinel.traces.registration')">
              <span data-test="registration">{{ facts.registration.ok === false ? t('sentinel.traces.registrationFail') : t('sentinel.traces.registrationOk') }}</span>
              <span v-if="facts.registration.inliers !== null" class="meta-text"> ({{ t('sentinel.traces.inliers', { n: facts.registration.inliers }) }})</span>
            </el-descriptions-item>
            <el-descriptions-item v-if="facts.newCatch" :label="t('sentinel.traces.newCatch')">
              <span data-test="new-catch">{{ fmt(facts.newCatch.new) }} / {{ fmt(facts.newCatch.persisted) }} / {{ fmt(facts.newCatch.disappeared) }}</span>
            </el-descriptions-item>
            <el-descriptions-item v-if="facts.newCatch?.cardChange" :label="t('sentinel.traces.cardChange')">
              {{ facts.newCatch.reasons.join('; ') || t('sentinel.common.yes') }}
            </el-descriptions-item>
            <el-descriptions-item v-if="facts.batteryPercent !== null" :label="t('sentinel.traces.battery')">{{ facts.batteryPercent }} %</el-descriptions-item>
            <el-descriptions-item v-if="facts.analyzer" :label="t('sentinel.traces.analyzer')">
              {{ facts.analyzer }}<span v-if="facts.visionMs !== null" class="meta-text"> · {{ t('sentinel.common.ms', { n: facts.visionMs }) }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-alert v-if="facts.untrusted" type="info" :closable="false" show-icon class="mt-3" :title="t('sentinel.traces.untrusted')">
            <pre class="trace-pre">{{ json(facts.untrusted) }}</pre>
          </el-alert>
        </template>
        <p v-else class="meta-text">{{ t('sentinel.common.none') }}</p>

        <template v-if="others.length">
          <div class="section-label">{{ t('sentinel.traces.neighbours') }}</div>
          <div v-for="o in others" :key="o.key" class="flex flex-wrap items-center gap-1.5 body-text">
            <strong>{{ o.camera }}</strong>
            <span class="meta-text">{{ t('sentinel.traces.source.opencv') }} {{ fmt(o.counts.opencv) }} · {{ t('sentinel.traces.source.npu') }} {{ fmt(o.counts.npu) }}</span>
            <el-tag v-for="i in o.quality.issues" :key="i" type="danger" effect="light" size="small" round>{{ issueLabel(i) }}</el-tag>
          </div>
        </template>
      </section>

      <!-- 2. Decision: planner, rules, reasoning -->
      <section class="trace-step" :aria-labelledby="`dec-${uid}`">
        <div :id="`dec-${uid}`" class="trace-step__title">
          <span class="trace-step__num">2</span>{{ t('sentinel.traces.decision') }}
        </div>
        <div class="flex flex-wrap items-center gap-1.5" data-test="planner">
          <el-tag :type="planner.fallback ? 'warning' : 'primary'" effect="light" size="small" round>
            {{ planner.name === 'llm' ? t('sentinel.traces.plannerLlm') : t('sentinel.traces.plannerRule') }}
          </el-tag>
          <span v-if="planner.detail" class="meta-text font-mono">{{ planner.detail }}</span>
          <el-tag v-if="planner.fallback" type="warning" effect="light" size="small" round data-test="fallback-flag">{{ t('sentinel.traces.plannerFallback') }}</el-tag>
        </div>
        <p v-if="planner.fallback && planner.reason" class="meta-text mt-1">{{ t('sentinel.traces.fallbackReason', { reason: planner.reason }) }}</p>
        <el-alert v-if="trace.kill_switch" type="error" :closable="false" show-icon class="mt-2" :title="t('sentinel.traces.killSwitchOn')" data-test="kill-flag" />

        <div class="section-label">{{ t('sentinel.traces.reasoning') }}</div>
        <p class="trace-reasoning" data-test="reasoning">{{ trace.reasoning_summary || t('sentinel.common.none') }}</p>

        <div class="section-label">{{ t('sentinel.traces.rules') }}</div>
        <ul class="trace-list">
          <li v-for="(d, i) in trace.decisions || []" :key="i" data-test="decision-item">
            <div class="flex flex-wrap items-center gap-1.5">
              <el-tag type="info" effect="plain" size="small" class="font-mono">{{ d.rule }}</el-tag>
              <span class="body-text font-semibold">{{ d.action }}</span>
            </div>
            <ul v-if="d.reasons?.length" class="meta-text trace-reasons">
              <li v-for="(r, j) in d.reasons" :key="j">{{ r }}</li>
            </ul>
          </li>
          <li v-if="!(trace.decisions || []).length" class="meta-text">{{ t('sentinel.common.none') }}</li>
        </ul>

        <template v-if="events.length">
          <div class="section-label">{{ t('sentinel.traces.events') }}</div>
          <ul class="trace-list">
            <li v-for="(e, i) in events" :key="i" class="flex flex-wrap items-center gap-1.5">
              <el-tag :type="eventTag(e.kind)" effect="light" size="small" round>{{ e.kind }}</el-tag>
              <span class="meta-text">{{ timeOnly(e.at, locale) }}</span>
              <span class="meta-text font-mono">{{ e.detail?.effect || e.detail?.reason || '' }}</span>
            </li>
          </ul>
        </template>
      </section>

      <!-- 3. Action: tools, device acknowledgements, approval, outcome -->
      <section class="trace-step" :aria-labelledby="`act-${uid}`">
        <div :id="`act-${uid}`" class="trace-step__title">
          <span class="trace-step__num">3</span>{{ t('sentinel.traces.action') }}
        </div>
        <div class="section-label">{{ t('sentinel.traces.tools') }}</div>
        <el-timeline v-if="calls.length" class="trace-timeline" data-test="tool-calls">
          <el-timeline-item
            v-for="c in calls"
            :key="c.index"
            :type="TOOL_TAG[c.status] || 'info'"
            :timestamp="c.ms !== null && c.ms !== undefined ? t('sentinel.common.ms', { n: Math.round(c.ms) }) : ''"
            placement="top"
            data-test="tool-call"
          >
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="body-text font-semibold font-mono">{{ c.name }}</span>
              <el-tag :type="TOOL_TAG[c.status] || 'info'" effect="light" size="small" round>{{ toolStatus(c.status) }}</el-tag>
              <el-tag v-if="c.by === 'guardrail'" type="info" effect="plain" size="small" round>{{ t('sentinel.traces.byGuardrail') }}</el-tag>
            </div>
            <div v-if="toolSummary(c)" class="meta-text font-mono break-all">{{ toolSummary(c) }}</div>
            <div v-if="c.blocked_reason" class="meta-text is-warning">{{ t('sentinel.traces.blockedReason', { reason: c.blocked_reason }) }}</div>
            <el-collapse class="trace-raw">
              <el-collapse-item :title="t('sentinel.traces.argsResult')" :name="c.index">
                <pre class="trace-pre">{{ json({ args: c.args, result: c.result }) }}</pre>
              </el-collapse-item>
            </el-collapse>
          </el-timeline-item>
        </el-timeline>
        <p v-else class="meta-text">{{ t('sentinel.common.none') }}</p>

        <template v-if="isp.length">
          <div class="section-label">{{ t('sentinel.traces.ispChange') }}</div>
          <div v-for="(c, i) in isp" :key="i" data-test="isp-change">
            <el-table :data="diffSettings(c.before, c.after)" size="small" border class="w-full">
              <el-table-column prop="key" :label="t('sentinel.devices.setting')" min-width="110" />
              <el-table-column :label="t('sentinel.traces.before')" min-width="70">
                <template #default="{ row }">{{ fmt(row.before) }}</template>
              </el-table-column>
              <el-table-column :label="t('sentinel.traces.after')" min-width="70">
                <template #default="{ row }"><span :class="{ 'font-semibold is-primary': row.changed }">{{ fmt(row.after) }}</span></template>
              </el-table-column>
            </el-table>
            <el-tag v-if="verdict" :type="verdict === 'isp_verified' ? 'success' : 'warning'" effect="light" size="small" round class="mt-1" data-test="isp-verdict">
              {{ t(`sentinel.traces.ispVerdict.${verdict}`) }}
            </el-tag>
          </div>
        </template>

        <template v-if="acks.length">
          <div class="section-label">{{ t('sentinel.traces.acks') }}</div>
          <ul class="trace-list" data-test="acks">
            <li v-for="(a, i) in acks" :key="i" class="flex flex-wrap items-center gap-1.5">
              <el-tag :type="a.ok === false || a.error ? 'danger' : a.pending ? 'warning' : 'success'" effect="light" size="small" round>
                {{ a.error || a.ok === false ? t('sentinel.traces.ackFailed') : a.pending ? t('sentinel.traces.ackPending') : t('sentinel.traces.ackApplied') }}
              </el-tag>
              <span class="body-text font-mono">{{ a.method }}</span>
              <span class="meta-text">{{ a.serial }} · {{ t('sentinel.traces.transport', { transport: a.transport }) }}<template v-if="a.ms"> · {{ t('sentinel.common.ms', { n: Math.round(a.ms) }) }}</template></span>
            </li>
          </ul>
        </template>

        <div class="section-label">{{ t('sentinel.traces.approval') }}</div>
        <p v-if="!trace.approval" class="meta-text">{{ t('sentinel.traces.approvalNone') }}</p>
        <div v-else class="flex flex-col gap-1" data-test="approval-box">
          <div class="flex flex-wrap items-center gap-1.5">
            <el-tag :type="STATUS_TAG[trace.approval.status] || 'info'" effect="light" size="small" round>{{ approvalStatus(trace.approval.status) }}</el-tag>
            <span class="body-text">{{ kindName(trace.approval.kind) }}</span>
            <span class="meta-text">{{ (trace.approval.cameras || []).join(', ') }}</span>
          </div>
          <span v-if="trace.approval.expires_at" class="meta-text">{{ t('sentinel.approvals.expiresAt', { time: dateTime(trace.approval.expires_at, locale) }) }}</span>
          <router-link :to="{ name: 'sentinel-approvals', query: { id: trace.approval.approval_id } }" class="el-link el-link--primary is-underline w-fit">
            {{ t('sentinel.traces.openApproval') }}
          </router-link>
        </div>

        <div class="section-label">{{ t('sentinel.traces.outcome') }}</div>
        <div class="flex flex-wrap items-center gap-1.5" data-test="outcome">
          <span class="body-text font-mono">{{ trace.outcome }}</span>
          <el-tag type="info" effect="plain" size="small" round>{{ trace.state }}</el-tag>
        </div>
        <el-collapse v-if="trace.followup" class="trace-raw">
          <el-collapse-item :title="t('sentinel.traces.followup')" name="followup">
            <pre class="trace-pre">{{ json(trace.followup) }}</pre>
          </el-collapse-item>
        </el-collapse>
      </section>
    </div>

    <div class="trace-images">
      <div class="trace-step__title">{{ t('sentinel.traces.images') }}</div>
      <EvidenceGallery :images="images" :obs="obs" :overlays="trace.overlays || {}" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import EvidenceGallery from './EvidenceGallery.vue';
import {
  primaryObservation, otherObservations, perceptionFacts, plannerBadge, collectImages, toolSummary, ispChanges, ispVerdict,
} from '@/utils/sentinel/trace';
import { diffSettings } from '@/utils/sentinel/devices';
import { STATUS_TAG } from '@/utils/sentinel/approvals';
import { dateTime, timeOnly } from '@/utils/sentinel/time';

/** One trace opened: Perception → Decision → Action, then its evidence pictures. */
const props = defineProps({ trace: { type: Object, required: true } });
const { t, te, locale } = useI18n();

const TOOL_TAG = { ok: 'success', blocked: 'warning', error: 'danger', dedup: 'info' };

const uid = computed(() => String(props.trace.event_id).replace(/[^a-zA-Z0-9_-]/g, '_'));
const obs = computed(() => primaryObservation(props.trace));
const facts = computed(() => perceptionFacts(obs.value));
const others = computed(() => otherObservations(props.trace).map((o) => ({ key: o.key, ...perceptionFacts(o) })));
const planner = computed(() => plannerBadge(props.trace));
const images = computed(() => collectImages(props.trace));
const isp = computed(() => ispChanges(props.trace));
const verdict = computed(() => ispVerdict(props.trace));
const acks = computed(() => props.trace.device_ack || []);
const calls = computed(() => props.trace.tool_calls || []);
const events = computed(() => props.trace.events || []);

const fmt = (v) => (v === null || v === undefined ? '–' : v);
const json = (v) => JSON.stringify(v, null, 2);
const issueLabel = (i) => (te(`sentinel.issue.${i}`) ? t(`sentinel.issue.${i}`) : i);
const toolStatus = (s) => (te(`sentinel.traces.toolStatus.${s}`) ? t(`sentinel.traces.toolStatus.${s}`) : s);
const approvalStatus = (s) => (te(`sentinel.approvals.status.${s}`) ? t(`sentinel.approvals.status.${s}`) : s);
const kindName = (k) => (te(`sentinel.approvals.kind.${k}`) ? t(`sentinel.approvals.kind.${k}`) : k);
const eventTag = (kind) => (/block|revert|fallback|expired/.test(kind) ? 'warning' : 'info');
</script>

<style scoped>
.trace-detail {
  padding: 4px 8px 8px;
}
.trace-step {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-bg-color);
}
.trace-step__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.trace-step__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 12px;
  color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-5);
}
.section-label {
  margin: 14px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.trace-counts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.trace-count {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
  min-width: 0;
}
.trace-count__value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}
.trace-reasoning {
  margin: 0;
  padding: 8px 10px;
  font-size: 14px;
  line-height: 1.5;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
}
.trace-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.trace-reasons {
  margin: 4px 0 0;
  padding-left: 18px;
  list-style: disc;
}
.trace-timeline {
  padding-left: 2px;
}
.trace-timeline :deep(.el-timeline-item) {
  padding-bottom: 12px;
}
.trace-raw {
  --el-collapse-header-height: 32px;
  border: none;
}
.trace-raw :deep(.el-collapse-item__header) {
  font-size: 12px;
  color: var(--el-color-primary);
  border-bottom: none;
}
.trace-raw :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}
.trace-pre {
  margin: 0;
  padding: 8px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
}
.trace-images {
  margin-top: 16px;
}
.body-text {
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.meta-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.is-warning { color: var(--el-color-warning); }
.is-primary { color: var(--el-color-primary); }
</style>
