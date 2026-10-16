<template>
  <el-card shadow="never" class="device-card" data-test="device-card">
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="section-title truncate">{{ d.name || d.serial }}</div>
          <div class="section-subtitle font-mono">{{ d.serial }}</div>
        </div>
        <div class="flex flex-wrap gap-1">
          <el-tag :type="d.online ? 'success' : 'info'" effect="light" size="small" round data-test="online-pill">{{ d.online ? t('common.online') : t('common.offline') }}</el-tag>
          <el-tag v-if="d.trap_kind" type="info" effect="plain" size="small" round>{{ trapKindName(d.trap_kind) }}</el-tag>
          <el-tag v-if="d.source" type="info" effect="plain" size="small" round>{{ sourceName(d.source) }}</el-tag>
          <el-tag v-if="d.bench" type="primary" effect="plain" size="small" round>{{ t('sentinel.density.bench') }}</el-tag>
          <el-tag v-if="d.kill_switch" type="danger" effect="dark" size="small" round>{{ t('sentinel.status.killSwitch') }}</el-tag>
        </div>
      </div>
    </template>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <!-- Last photo and facts -->
      <div class="min-w-0">
        <div class="section-label">{{ t('sentinel.devices.lastPhoto') }}</div>
        <el-image
          v-if="lastKey"
          :src="api.sentinelEvidenceUrl(lastKey)"
          :preview-src-list="[api.sentinelEvidenceUrl(lastKey)]"
          preview-teleported
          :alt="t('sentinel.devices.thumbAlt', { name: d.name || d.serial })"
          fit="cover"
          loading="lazy"
          class="device-photo"
        >
          <template #error><div class="device-photo__missing">{{ t('sentinel.traces.imageUnavailable') }}</div></template>
        </el-image>
        <el-empty v-else :description="t('sentinel.devices.noPhoto')" :image-size="60" />
        <p v-if="d.last_photo?.at" class="meta-text mt-1">{{ dateTime(d.last_photo.at, locale) }}</p>

        <el-descriptions :column="1" size="small" border class="mt-3">
          <el-descriptions-item :label="t('sentinel.devices.lastSeen')">{{ d.last_seen_at ? relative(d.last_seen_at, locale) : '--' }}</el-descriptions-item>
          <el-descriptions-item :label="t('sentinel.devices.firmware')">{{ d.fw || '--' }}</el-descriptions-item>
          <el-descriptions-item :label="t('sentinel.devices.battery')"><span data-test="battery">{{ tel.battery !== null ? `${tel.battery} %` : '--' }}</span></el-descriptions-item>
          <el-descriptions-item :label="t('sentinel.devices.rssi')">{{ tel.rssi !== null ? `${tel.rssi} dBm` : '--' }}</el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- Shadow, telemetry, capture budget -->
      <div class="min-w-0">
        <div class="section-label">{{ t('sentinel.devices.shadow') }}</div>
        <template v-if="reported || desired">
          <p class="meta-text mb-1">
            {{ t('sentinel.devices.versions', { reported: d.reported_version ?? '--', desired: d.desired_version ?? '--' }) }}
          </p>
          <el-table :data="shadowRows" size="small" border class="w-full" data-test="shadow-table">
            <el-table-column prop="key" label="video.image" min-width="110" />
            <el-table-column :label="t('sentinel.devices.reported')" min-width="80">
              <template #default="{ row }">{{ row.before ?? '–' }}</template>
            </el-table-column>
            <el-table-column :label="t('sentinel.devices.desired')" min-width="80">
              <template #default="{ row }"><span :class="{ 'font-semibold is-primary': row.changed }">{{ row.after ?? '–' }}</span></template>
            </el-table-column>
          </el-table>
        </template>
        <p v-else class="meta-text">{{ t('sentinel.devices.noShadow') }}</p>

        <div class="section-label mt-4">{{ t('sentinel.devices.telemetry') }}</div>
        <div class="flex flex-wrap gap-6">
          <Sparkline :points="batteryPts" :label="t('sentinel.devices.battery')" unit=" %" />
          <Sparkline :points="rssiPts" :label="t('sentinel.devices.rssi')" unit=" dBm" />
        </div>
        <p v-if="localOnly" class="meta-text mt-1">{{ t('sentinel.devices.sparkLocal') }}</p>

        <div class="section-label mt-4">{{ t('sentinel.devices.budget') }}</div>
        <div v-if="budget && budget.used !== null" data-test="budget">
          <el-progress :percentage="budget.pct ?? 0" :stroke-width="10" :show-text="false" :status="(budget.pct ?? 0) >= 90 ? 'warning' : ''" :aria-label="t('sentinel.devices.budget')" />
          <p class="meta-text mt-1">{{ budget.limit ? t('sentinel.devices.budgetOf', { used: budget.used, limit: budget.limit }) : budget.used }}</p>
        </div>
        <p v-else class="meta-text">{{ t('sentinel.devices.budgetNone') }}</p>
      </div>
    </div>

    <!-- The agent's last image-setting change, with the photos before and after -->
    <template v-if="reported || isp">
      <el-divider />
      <div class="section-label">{{ t('sentinel.devices.ispTitle') }}</div>
      <div v-if="isp" data-test="isp-block">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="meta-text">{{ dateTime(isp.at, locale) }} · {{ isp.change.reason }}</span>
          <el-tag v-if="isp.verdict" :type="isp.verdict === 'isp_verified' ? 'success' : 'warning'" effect="light" size="small" round>{{ t(`sentinel.traces.ispVerdict.${isp.verdict}`) }}</el-tag>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <el-table :data="diffSettings(isp.change.before, isp.change.after)" size="small" border class="w-full">
            <el-table-column prop="key" :label="t('sentinel.devices.setting')" min-width="110" />
            <el-table-column :label="t('sentinel.traces.before')" min-width="70">
              <template #default="{ row }">{{ row.before ?? '–' }}</template>
            </el-table-column>
            <el-table-column :label="t('sentinel.traces.after')" min-width="70">
              <template #default="{ row }"><span :class="{ 'font-semibold is-primary': row.changed }">{{ row.after ?? '–' }}</span></template>
            </el-table-column>
          </el-table>
          <div v-if="isp.before && isp.after" class="grid grid-cols-2 gap-2">
            <figure v-for="(ref, i) in [isp.before, isp.after]" :key="ref" class="m-0">
              <el-image :src="api.sentinelEvidenceUrl(ref)" :preview-src-list="[api.sentinelEvidenceUrl(isp.before), api.sentinelEvidenceUrl(isp.after)]" :initial-index="i" preview-teleported fit="cover" loading="lazy" class="device-photo" :alt="i ? t('sentinel.traces.after') : t('sentinel.traces.before')" />
              <figcaption class="meta-text">{{ i ? t('sentinel.traces.after') : t('sentinel.traces.before') }}</figcaption>
            </figure>
          </div>
        </div>
        <el-button link type="primary" class="mt-2" @click="router.push({ name: 'sentinel-traces', query: { id: isp.eventId } })">{{ t('sentinel.approvals.viewTrace') }}</el-button>
      </div>
      <p v-else class="meta-text">{{ t('sentinel.devices.ispNone') }}</p>
    </template>
  </el-card>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import api from '@/services/api';
import { sentinelGet, items } from '@/composables/useSentinel';
import Sparkline from './Sparkline.vue';
import { shadowImage, diffSettings, telemetryPoints, latestTelemetry, budgetUsed } from '@/utils/sentinel/devices';
import { ispChanges, ispVerdict, primaryObservation, otherObservations } from '@/utils/sentinel/trace';
import { dateTime, relative } from '@/utils/sentinel/time';

/** A camera the agent watches: last photo, shadow (reported vs desired), telemetry, last ISP change. */
const props = defineProps({
  device: { type: Object, required: true },
  localHistory: { type: Object, default: () => ({}) }, // { battery: [{at, v}], rssi: [...] }
});
const { t, te, locale } = useI18n();
const router = useRouter();

const detail = ref(null);
const isp = ref(null);

const d = computed(() => ({ ...props.device, ...(detail.value || {}) }));
const tel = computed(() => latestTelemetry(d.value));
const serverBattery = computed(() => telemetryPoints(d.value, 'battery_percent'));
const batteryPts = computed(() => (serverBattery.value.length ? serverBattery.value : props.localHistory.battery || []));
const rssiPts = computed(() => {
  const server = telemetryPoints(d.value, 'rssi');
  return server.length ? server : props.localHistory.rssi || [];
});
const localOnly = computed(() => !serverBattery.value.length && (props.localHistory.battery || []).length > 0);
const budget = computed(() => budgetUsed(d.value));
const reported = computed(() => shadowImage(d.value.reported));
const desired = computed(() => shadowImage(d.value.desired));
const shadowRows = computed(() => diffSettings(reported.value || {}, desired.value || {}));
const lastKey = computed(() => d.value.last_photo?.key || null);

const sourceName = (s) => (te(`sentinel.devices.source.${s}`) ? t(`sentinel.devices.source.${s}`) : s);
const trapKindName = (k) => (te(`sentinel.devices.trapKind.${k}`) ? t(`sentinel.devices.trapKind.${k}`) : k);

onMounted(async () => {
  try {
    const res = await sentinelGet(`devices/${encodeURIComponent(props.device.serial)}`);
    detail.value = res?.device || null;
  } catch {
    // The list item is enough to show the card
  }
  try {
    const list = items(await sentinelGet('traces', { camera: props.device.serial, limit: 40 }));
    const hit = list.find((x) => (x.decisions || []).some((dd) => dd.action === 'set_isp' || dd.rule === 'quality.isp_fix'));
    if (!hit) return;
    const res = await sentinelGet(`traces/${encodeURIComponent(hit.event_id)}`);
    const tr = res?.trace || res;
    const change = ispChanges(tr)[0];
    if (change) {
      isp.value = {
        change,
        verdict: ispVerdict(tr),
        eventId: tr.event_id,
        at: tr.created_at,
        before: primaryObservation(tr)?.image || null,
        after: otherObservations(tr)[0]?.image || null,
      };
    }
  } catch {
    // The ISP block is optional
  }
});
</script>

<style scoped>
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
.device-photo {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color);
  background-color: var(--el-fill-color-light);
}
.device-photo__missing {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.is-primary { color: var(--el-color-primary); }
</style>
