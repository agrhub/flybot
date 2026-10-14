<template>
  <!-- Only for owners and managers of an organization with other members (a cooperative) -->
  <el-card v-if="orgs.length" shadow="never" class="mb-4" v-loading="loading">
    <template #header>
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="min-w-0">
          <h3 class="section-title">{{ t('orgOverview.title') }}</h3>
          <p class="section-desc">{{ t('orgOverview.desc') }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <el-select v-if="orgs.length > 1" v-model="orgId" size="small" class="!w-48" :aria-label="t('orgOverview.organization')" @change="load">
            <el-option v-for="o in orgs" :key="o.id" :label="o.name" :value="o.id" />
          </el-select>
          <el-radio-group v-model="period" size="small" @change="load">
            <el-radio-button v-for="p in PERIODS" :key="p" :value="p">{{ t('farms.compare.days', { days: p }) }}</el-radio-button>
          </el-radio-group>
          <el-button v-if="toVisit.length" size="small" :icon="Bell" :loading="reminding === 'all'" @click="remind(toVisit, 'all')">{{ t('orgOverview.remindAll', { count: toVisit.length }) }}</el-button>
          <el-button size="small" :icon="Download" :disabled="!members.length" :loading="exporting" @click="exportExcel">{{ t('farms.compare.export') }}</el-button>
        </div>
      </div>
    </template>

    <template v-if="overview">
      <!-- The cooperative at a glance -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <el-statistic :title="t('orgOverview.ftd')" :value="totals.ftd ?? 0" :precision="1">
          <template #suffix><ChangeTag :pct="totals.change" /></template>
        </el-statistic>
        <el-statistic :title="t('orgOverview.cameras')" :value="totals.cameras" />
        <el-statistic :title="t('orgOverview.atThreshold')" :value="totals.atThreshold" />
        <el-statistic :title="t('orgOverview.needsVisit')" :value="totals.needsVisit" />
      </div>

      <!-- Phones: one card per member -->
      <div v-if="isMobile" class="flex flex-col gap-3">
        <div v-for="m in members" :key="m.userId || m.email" class="cmp-row">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="cmp-strong truncate">{{ m.name || m.email }}</p>
              <p class="cmp-meta">{{ t('farms.compare.traps', { count: m.cameras }) }} · {{ lastTreatmentText(m) }}</p>
              <el-button v-if="m.userId && m.cameras && m.member" link type="primary" size="small" :icon="Bell" :loading="reminding === m.userId" @click="remind([m], m.userId)">{{ t('orgOverview.remind') }}</el-button>
              <div class="flex flex-wrap gap-1 mt-1">
                <el-tag v-if="!m.member" type="info" effect="plain" round size="small">{{ t('orgOverview.former') }}</el-tag>
                <el-tag v-if="m.needsVisit" type="danger" effect="light" round size="small">{{ t('orgOverview.visit') }}</el-tag>
                <el-tag v-if="m.atThreshold" type="warning" effect="light" round size="small">{{ t('orgOverview.atThresholdCount', { count: m.atThreshold }) }}</el-tag>
                <el-tag v-if="m.silent" type="info" effect="light" round size="small">{{ t('orgOverview.silentCount', { count: m.silent }) }}</el-tag>
              </div>
            </div>
            <div class="text-right">
              <p class="cmp-strong">{{ m.ftd ?? '--' }}</p>
              <ChangeTag :pct="m.change" />
            </div>
          </div>
        </div>
      </div>

      <el-table v-else :data="members" :row-key="(m) => m.userId || m.email" style="width: 100%">
        <el-table-column :label="t('orgOverview.member')" min-width="220">
          <template #default="{ row }">
            <p class="cmp-strong truncate">{{ row.name || row.email }}</p>
            <p v-if="row.name" class="cmp-meta truncate">{{ row.email }}</p>
          </template>
        </el-table-column>
        <el-table-column :label="t('farms.compare.trapsCol')" prop="cameras" width="90" />
        <el-table-column :label="t('orgOverview.ftd')" width="130">
          <template #default="{ row }"><span class="cmp-strong">{{ row.ftd ?? '--' }}</span></template>
        </el-table-column>
        <el-table-column :label="t('farms.compare.change')" width="120">
          <template #default="{ row }"><ChangeTag :pct="row.change" /></template>
        </el-table-column>
        <el-table-column :label="t('orgOverview.status')" min-width="220">
          <template #default="{ row }">
            <div class="flex flex-wrap gap-1">
              <el-tag v-if="!row.member" type="info" effect="plain" round size="small">{{ t('orgOverview.former') }}</el-tag>
              <el-tag v-if="row.needsVisit" type="danger" effect="light" round size="small">{{ t('orgOverview.visit') }}</el-tag>
              <el-tag v-if="row.atThreshold" type="warning" effect="light" round size="small">{{ t('orgOverview.atThresholdCount', { count: row.atThreshold }) }}</el-tag>
              <el-tag v-if="row.silent" type="info" effect="light" round size="small">{{ t('orgOverview.silentCount', { count: row.silent }) }}</el-tag>
              <span v-if="row.member && !row.needsVisit && !row.atThreshold && !row.silent" class="cmp-meta">{{ row.cameras ? t('orgOverview.allGood') : t('orgOverview.noCameras') }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('orgOverview.lastTreatment')" width="150">
          <template #default="{ row }"><span class="cmp-meta">{{ lastTreatmentText(row) }}</span></template>
        </el-table-column>
        <el-table-column width="110" align="right">
          <template #default="{ row }">
            <el-button v-if="row.userId && row.cameras && row.member" link type="primary" size="small" :icon="Bell" :loading="reminding === row.userId" @click="remind([row], row.userId)">{{ t('orgOverview.remind') }}</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- The cooperative's report for its board -->
      <SeasonReportCard :org-id="orgId" embedded />
    </template>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted, h, defineComponent } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElTag } from 'element-plus';
import { Download, Bell } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { requestErrorText } from '@/utils/requestError';
import { orgOverviewSheets, downloadSheets } from '@/utils/tableExport';
import SeasonReportCard from './SeasonReportCard.vue';

const PERIODS = [7, 30];
const { t, locale } = useI18n();
const { isMobile } = useBreakpoints();

const orgs = ref([]);
const orgId = ref(null);
const period = ref(7);
const overview = ref(null);
const loading = ref(false);
const members = computed(() => overview.value?.members || []);
const totals = computed(() => overview.value?.totals || {});

// Fewer flies than the period before is good news
const ChangeTag = defineComponent({
  props: { pct: { type: Number, default: null } },
  setup(props) {
    return () => {
      if (props.pct === null) return h('span', { class: 'cmp-meta' }, '--');
      const type = props.pct <= -10 ? 'success' : props.pct >= 10 ? 'danger' : 'info';
      return h(ElTag, { type, effect: 'light', round: true, size: 'small' }, () => `${props.pct > 0 ? '+' : ''}${props.pct}%`);
    };
  }
});

const lastTreatmentText = (m) => {
  if (!m.lastTreatmentAt) return t('orgOverview.neverTreated');
  return new Date(m.lastTreatmentAt).toLocaleDateString(locale.value === 'vi' ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const load = async () => {
  if (!orgId.value) return;
  loading.value = true;
  try {
    const res = await api.getOrgOverview(orgId.value, period.value);
    overview.value = res.data.overview;
  } catch (err) {
    ElMessage.error(requestErrorText(t, err, t('common.error')));
  } finally {
    loading.value = false;
  }
};

// Ask members to check their traps and log their work (once a day each)
const toVisit = computed(() => members.value.filter((m) => m.needsVisit && m.userId));
const reminding = ref(null);
const remind = async (list, key) => {
  reminding.value = key;
  try {
    const res = await api.remindOrgMembers(orgId.value, list.map((m) => m.userId));
    const sent = res.data.results.filter((r) => r.status === 'sent').length;
    const already = res.data.results.filter((r) => r.status === 'already').length;
    if (sent) ElMessage.success(t('orgOverview.reminded', { count: sent }));
    if (already) ElMessage.info(t('orgOverview.alreadyReminded', { count: already }));
  } catch (err) {
    ElMessage.error(requestErrorText(t, err, t('common.error')));
  } finally {
    reminding.value = null;
  }
};

const exporting = ref(false);
const exportExcel = async () => {
  exporting.value = true;
  try {
    const org = orgs.value.find(o => o.id === orgId.value);
    await downloadSheets(`FlyBot_cooperative_${period.value}d_${new Date().toISOString().slice(0, 10)}.xlsx`, orgOverviewSheets(org?.name || '', overview.value, t));
  } catch (err) {
    ElMessage.error(requestErrorText(t, err, t('common.error')));
  } finally {
    exporting.value = false;
  }
};

onMounted(async () => {
  try {
    const res = await api.listOrgs();
    orgs.value = (res.data.organizations || []).filter(o => o.canManage && o.members.length > 1);
    orgId.value = orgs.value[0]?.id || null;
    await load();
  } catch {
    // Without organizations there is nothing to show
    orgs.value = [];
  }
});
</script>

<style scoped>
.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-desc,
.cmp-meta {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.cmp-strong {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.cmp-row {
  padding: 12px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-bg-color-overlay);
}
</style>
