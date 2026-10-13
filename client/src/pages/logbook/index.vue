<template>
  <div class="w-full max-w-7xl mx-auto pb-12">
    <PageHeader :title="t('logbook.title')" :subtitle="t('logbook.subtitle')">
      <template #actions>
        <el-button :icon="Download" :loading="exporting" @click="exportVietGap">{{ t('logbook.export') }}</el-button>
        <el-tooltip :content="t('logbook.sendMonthlyHint')" placement="bottom">
          <el-button :icon="Message" :loading="sendingRecord" @click="sendMonthlyRecord">{{ t('logbook.sendMonthly') }}</el-button>
        </el-tooltip>
        <el-button v-if="canManageCameras" type="primary" :icon="Plus" @click="openForm()">{{ t('logbook.add') }}</el-button>
      </template>
    </PageHeader>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <el-select v-model="filters.deviceSerial" class="w-full sm:!w-60" @change="reload">
        <template #prefix><el-icon><VideoCamera /></el-icon></template>
        <el-option :label="t('analytics.allCameras')" value="all" />
        <el-option v-for="cam in cameras" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial" />
      </el-select>
      <el-select v-model="filters.type" :placeholder="t('logbook.allTypes')" clearable class="w-full sm:!w-48" @change="reload">
        <el-option v-for="type in TYPES" :key="type" :label="t(`logbook.types.${type}`)" :value="type" />
      </el-select>
      <el-date-picker
        v-model="filters.range"
        type="daterange"
        unlink-panels
        :start-placeholder="t('audit.from')"
        :end-placeholder="t('audit.to')"
        class="!w-full sm:!w-72"
        @change="reload"
      />
    </div>

    <el-card shadow="never" v-loading="loading">
      <el-empty v-if="!items.length && !loading" :description="t('logbook.empty')">
        <el-button v-if="canManageCameras" type="primary" :icon="Plus" @click="openForm()">{{ t('logbook.add') }}</el-button>
      </el-empty>

      <!-- Phones: cards -->
      <div v-else-if="isMobile" class="flex flex-col gap-3">
        <div v-for="row in items" :key="row.id" class="log-row">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5">
                <el-tag :type="TYPE_TAG[row.type]" effect="light" size="small">{{ t(`logbook.types.${row.type}`) }}</el-tag>
                <span class="log-meta">{{ formatDateTime(row.at) }}</span>
              </div>
              <p class="log-strong mt-1">{{ row.product || '--' }}</p>
              <p v-if="row.activeIngredient || row.dose" class="log-meta">{{ [row.activeIngredient, row.dose].filter(Boolean).join(' · ') }}</p>
              <p class="log-meta">{{ cameraNames(row) }}</p>
            </div>
            <EffectTag :effect="row.effect" @click="openEffect(row)" />
          </div>
          <div class="flex items-center justify-between gap-2 mt-2">
            <PhiTag :row="row" />
            <div v-if="canManageCameras" class="flex items-center gap-1">
              <el-button size="small" circle :icon="Edit" :title="t('common.edit')" @click="openForm(row)" />
              <el-button size="small" circle type="danger" plain :icon="Delete" :title="t('logbook.delete')" @click="remove(row)" />
            </div>
          </div>
        </div>
      </div>

      <!-- Larger screens: table -->
      <el-table v-else :data="items" row-key="id" style="width: 100%">
        <el-table-column :label="t('logbook.date')" width="150">
          <template #default="{ row }"><span class="log-meta">{{ formatDateTime(row.at) }}</span></template>
        </el-table-column>
        <el-table-column :label="t('logbook.type')" width="150">
          <template #default="{ row }">
            <el-tag :type="TYPE_TAG[row.type]" effect="light" size="small">{{ t(`logbook.types.${row.type}`) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('logbook.product')" min-width="200">
          <template #default="{ row }">
            <div class="log-strong">{{ row.product || '--' }}</div>
            <div v-if="row.activeIngredient || row.dose" class="log-meta">{{ [row.activeIngredient, row.dose].filter(Boolean).join(' · ') }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('logbook.cameras')" min-width="160">
          <template #default="{ row }"><span class="log-meta">{{ cameraNames(row) }}</span></template>
        </el-table-column>
        <el-table-column :label="t('logbook.phi')" width="190">
          <template #default="{ row }"><PhiTag :row="row" /></template>
        </el-table-column>
        <el-table-column :label="t('logbook.effect')" width="150">
          <template #default="{ row }"><EffectTag :effect="row.effect" @click="openEffect(row)" /></template>
        </el-table-column>
        <el-table-column v-if="canManageCameras" width="90" align="right" fixed="right">
          <template #default="{ row }">
            <el-button link :icon="Edit" :title="t('common.edit')" @click="openForm(row)" />
            <el-button link type="danger" :icon="Delete" :title="t('logbook.delete')" @click="remove(row)" />
          </template>
        </el-table-column>
      </el-table>

      <div v-if="total > pageSize" class="flex justify-end mt-4">
        <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next" background size="small" @current-change="load" />
      </div>
    </el-card>

    <!-- Which active ingredients worked, across all their uses (same filters as the list) -->
    <el-card shadow="never" class="mt-4" v-loading="ingredientsLoading">
      <template #header>
        <h3 class="section-title">{{ t('logbook.byIngredient.title') }}</h3>
        <p class="log-meta mt-1">{{ t('logbook.byIngredient.desc') }}</p>
      </template>
      <el-empty v-if="!ingredients.length && !ingredientsLoading" :image-size="80" :description="t('logbook.byIngredient.empty')" />

      <div v-else-if="isMobile" class="flex flex-col gap-3">
        <div v-for="g in ingredients" :key="g.name" class="log-row">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="log-strong">{{ g.name }}</p>
              <p v-if="g.products.length" class="log-meta">{{ g.products.join(', ') }}</p>
              <p class="log-meta">{{ t('logbook.byIngredient.usesValue', { uses: g.uses, measured: g.measured }) }} · {{ formatDate(g.lastAt) }}</p>
            </div>
            <ChangeTag :pct="g.avgChangePct" />
          </div>
        </div>
      </div>

      <el-table v-else :data="ingredients" row-key="name" style="width: 100%">
        <el-table-column :label="t('logbook.byIngredient.name')" min-width="220">
          <template #default="{ row }">
            <div class="log-strong">{{ row.name }}</div>
            <div v-if="row.products.length" class="log-meta">{{ row.products.join(', ') }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('logbook.byIngredient.uses')" min-width="150">
          <template #default="{ row }"><span class="log-meta">{{ t('logbook.byIngredient.usesValue', { uses: row.uses, measured: row.measured }) }}</span></template>
        </el-table-column>
        <el-table-column :label="t('logbook.byIngredient.avgChange')" width="170">
          <template #default="{ row }"><ChangeTag :pct="row.avgChangePct" /></template>
        </el-table-column>
        <el-table-column :label="t('logbook.byIngredient.clearlyWorked')" width="160">
          <template #default="{ row }"><span class="log-meta">{{ row.measured ? `${row.effective}/${row.measured}` : '--' }}</span></template>
        </el-table-column>
        <el-table-column :label="t('logbook.byIngredient.last')" width="130">
          <template #default="{ row }"><span class="log-meta">{{ formatDate(row.lastAt) }}</span></template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Add / edit -->
    <el-dialog v-model="formVisible" :title="editingId ? t('logbook.edit') : t('logbook.add')" width="560px" align-center>
      <el-form label-position="top" @submit.prevent="save">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <el-form-item :label="t('logbook.type')" required>
            <el-select v-model="form.type" class="w-full">
              <el-option v-for="type in TYPES" :key="type" :label="t(`logbook.types.${type}`)" :value="type" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('logbook.date')" required>
            <el-date-picker v-model="form.at" type="datetime" class="!w-full" :disabled-date="(d) => d > new Date()" />
          </el-form-item>
        </div>
        <el-form-item :label="t('logbook.cameras')" required>
          <el-select v-model="form.cameraSerials" multiple collapse-tags collapse-tags-tooltip filterable class="w-full" :placeholder="t('logbook.camerasPlaceholder')">
            <el-option v-for="cam in manageableCameras" :key="cam.deviceSerial" :label="cam.deviceName" :value="cam.deviceSerial" />
          </el-select>
        </el-form-item>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <el-form-item :label="t('logbook.product')" :required="form.type === 'spray'">
            <el-input v-model="form.product" maxlength="120" />
          </el-form-item>
          <el-form-item :label="t('logbook.activeIngredient')">
            <el-input v-model="form.activeIngredient" maxlength="120" />
          </el-form-item>
          <el-form-item :label="t('logbook.dose')">
            <el-input v-model="form.dose" maxlength="60" :placeholder="t('logbook.dosePlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('logbook.area')">
            <el-input v-model="form.area" maxlength="60" :placeholder="t('logbook.areaPlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('logbook.operator')">
            <el-input v-model="form.operator" maxlength="80" />
          </el-form-item>
          <el-form-item :label="t('logbook.phiDays')">
            <el-input-number v-model="form.preHarvestDays" :min="0" :max="365" :step="1" step-strictly class="!w-full" :placeholder="t('logbook.phiPlaceholder')" />
          </el-form-item>
        </div>
        <el-form-item :label="t('logbook.note')">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- Effect -->
    <el-dialog v-model="effectVisible" :title="t('logbook.effectTitle')" width="600px" align-center>
      <div v-loading="effectLoading">
        <template v-if="effect">
          <el-alert :type="EFFECT_ALERT[effect.status]" :closable="false" show-icon :title="t(`logbook.effectStatus.${effect.status}`)" :description="t('logbook.effectExplain', { days: effect.windowDays })" />
          <div class="grid grid-cols-3 gap-3 my-4">
            <StatCard :label="t('logbook.before')" :value="effect.before ?? '--'" :unit="t('logbook.perDay')" />
            <StatCard :label="t('logbook.after')" :value="effect.after ?? '--'" :unit="t('logbook.perDay')" />
            <StatCard :label="t('logbook.change')" :value="effect.changePct === null ? '--' : `${effect.changePct > 0 ? '+' : ''}${effect.changePct}%`" :type="effect.changePct === null ? 'default' : (effect.changePct < 0 ? 'success' : 'danger')" />
          </div>
          <el-table :data="effect.cameras" size="small" style="width: 100%">
            <el-table-column :label="t('cameras.deviceName')" prop="deviceName" min-width="140" />
            <el-table-column :label="t('logbook.before')" width="90" align="right">
              <template #default="{ row }">{{ row.before ?? '--' }}</template>
            </el-table-column>
            <el-table-column :label="t('logbook.after')" width="90" align="right">
              <template #default="{ row }">{{ row.after ?? '--' }}</template>
            </el-table-column>
            <el-table-column :label="t('logbook.change')" width="90" align="right">
              <template #default="{ row }">{{ row.changePct === null ? '--' : `${row.changePct > 0 ? '+' : ''}${row.changePct}%` }}</template>
            </el-table-column>
          </el-table>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, h, defineComponent } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox, ElTag } from 'element-plus';
import { Plus, Download, Edit, Delete, VideoCamera, Message } from '@element-plus/icons-vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';
import { useCameras } from '@/composables/useCameras';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { loadExcelWriter } from '@/utils/lazyLibs';
import PageHeader from '@/components/common/PageHeader.vue';
import StatCard from '@/components/common/StatCard.vue';

const TYPES = ['spray', 'bait', 'lure', 'biological', 'sanitation', 'bagging', 'other'];
const TYPE_TAG = { spray: 'danger', bait: 'warning', lure: 'warning', biological: 'success', sanitation: 'info', bagging: 'info', other: 'info' };
const EFFECT_TAG = { effective: 'success', partial: 'warning', not_effective: 'danger', pending: 'info', no_data: 'info' };
const EFFECT_ALERT = { effective: 'success', partial: 'warning', not_effective: 'error', pending: 'info', no_data: 'info' };
const DAY_MS = 24 * 60 * 60 * 1000;

const { t, locale } = useI18n();
const { canManageCameras } = useAuth();
const { cameras } = useCameras();
const { isMobile } = useBreakpoints();

const manageableCameras = computed(() => cameras.value.filter(c => c.canManage !== false));
const nameOf = (serial) => cameras.value.find(c => c.deviceSerial === serial)?.deviceName || serial;
const cameraNames = (row) => row.cameraSerials.map(nameOf).join(', ');
const dateLocale = () => (locale.value === 'vi' ? 'vi-VN' : 'en-US');
const formatDateTime = (v) => new Date(v).toLocaleString(dateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const formatDate = (v) => new Date(v).toLocaleDateString(dateLocale());

// Small inline components (tags) shared by the table and the phone cards
const EffectTag = defineComponent({
  props: { effect: { type: Object, default: null } },
  emits: ['click'],
  setup(props, { emit }) {
    return () => {
      if (!props.effect) return h('span', { class: 'log-meta' }, '--');
      const pct = props.effect.changePct;
      const text = props.effect.status === 'pending' || props.effect.status === 'no_data' || pct === null
        ? t(`logbook.effectShort.${props.effect.status}`)
        : `${pct > 0 ? '+' : ''}${pct}%`;
      return h(ElTag, { type: EFFECT_TAG[props.effect.status], effect: 'light', round: true, size: 'small', class: 'cursor-pointer', onClick: () => emit('click') }, () => text);
    };
  }
});
const PhiTag = defineComponent({
  props: { row: { type: Object, required: true } },
  setup(props) {
    return () => {
      if (!props.row.harvestAllowedFrom) return h('span', { class: 'log-meta' }, '--');
      const waiting = new Date(props.row.harvestAllowedFrom) > new Date();
      return h(ElTag, { type: waiting ? 'warning' : 'success', effect: 'light', size: 'small' },
        () => (waiting ? t('logbook.harvestFrom', { date: formatDate(props.row.harvestAllowedFrom) }) : t('logbook.harvestOk')));
    };
  }
});

// Average change in catches after an ingredient: a clear drop, some drop, or none
const ChangeTag = defineComponent({
  props: { pct: { type: Number, default: null } },
  setup(props) {
    return () => {
      if (props.pct === null) return h(ElTag, { type: 'info', effect: 'light', round: true, size: 'small' }, () => t('logbook.byIngredient.notJudged'));
      const type = props.pct <= -30 ? 'success' : props.pct < 0 ? 'warning' : 'danger';
      return h(ElTag, { type, effect: 'light', round: true, size: 'small' }, () => `${props.pct > 0 ? '+' : ''}${props.pct}%`);
    };
  }
});

// ---------- List ----------
const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const filters = reactive({ deviceSerial: 'all', type: '', range: null });

const queryParams = () => {
  const p = { deviceSerial: filters.deviceSerial, type: filters.type || undefined };
  if (filters.range?.[0]) p.from = new Date(filters.range[0]).toISOString();
  if (filters.range?.[1]) {
    const end = new Date(filters.range[1]);
    end.setHours(23, 59, 59, 999);
    p.to = end.toISOString();
  }
  return p;
};

const errorText = (err) => err.response?.data?.message || t('common.error');

const load = async () => {
  loading.value = true;
  try {
    const res = await api.listTreatments({ ...queryParams(), page: page.value, limit: pageSize, effect: 1 });
    items.value = res.data.treatments || [];
    total.value = res.data.total || 0;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
};
const reload = () => {
  page.value = 1;
  load();
  loadIngredients();
};

// ---------- Effectiveness per active ingredient ----------
const ingredients = ref([]);
const ingredientsLoading = ref(false);
const loadIngredients = async () => {
  ingredientsLoading.value = true;
  try {
    ingredients.value = (await api.getTreatmentEffectiveness(queryParams())).data.ingredients || [];
  } catch (err) {
    ingredients.value = [];
    ElMessage.error(errorText(err));
  } finally {
    ingredientsLoading.value = false;
  }
};

// ---------- Add / edit ----------
const formVisible = ref(false);
const saving = ref(false);
const editingId = ref(null);
const emptyForm = () => ({
  type: 'spray', at: new Date(), cameraSerials: [], product: '', activeIngredient: '', dose: '', area: '', operator: '', preHarvestDays: null, note: ''
});
const form = reactive(emptyForm());

const openForm = (row = null) => {
  editingId.value = row?.id || null;
  Object.assign(form, emptyForm(), row ? {
    type: row.type, at: new Date(row.at), cameraSerials: [...row.cameraSerials], product: row.product, activeIngredient: row.activeIngredient,
    dose: row.dose, area: row.area, operator: row.operator, preHarvestDays: row.preHarvestDays, note: row.note
  } : {});
  formVisible.value = true;
};

const save = async () => {
  if (!form.cameraSerials.length) {
    ElMessage.warning(t('logbook.camerasRequired'));
    return;
  }
  saving.value = true;
  try {
    const body = { ...form, at: new Date(form.at).toISOString(), preHarvestDays: Number.isInteger(form.preHarvestDays) ? form.preHarvestDays : null };
    if (editingId.value) await api.updateTreatment(editingId.value, body);
    else await api.createTreatment(body);
    ElMessage.success(t('logbook.saved'));
    formVisible.value = false;
    load();
    loadIngredients();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
  }
};

const remove = async (row) => {
  try {
    await ElMessageBox.confirm(t('logbook.deleteConfirm'), t('logbook.delete'), { type: 'warning', confirmButtonText: t('logbook.delete'), cancelButtonText: t('common.cancel') });
  } catch {
    return;
  }
  try {
    await api.deleteTreatment(row.id);
    load();
    loadIngredients();
  } catch (err) {
    ElMessage.error(errorText(err));
  }
};

// ---------- Effect ----------
const effectVisible = ref(false);
const effectLoading = ref(false);
const effect = ref(null);
const openEffect = async (row) => {
  effect.value = null;
  effectVisible.value = true;
  effectLoading.value = true;
  try {
    const res = await api.getTreatmentEffect(row.id);
    effect.value = res.data.effect;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    effectLoading.value = false;
  }
};

// ---------- Last month's record as a PDF, by email (and Telegram) ----------
const sendingRecord = ref(false);
const sendMonthlyRecord = async () => {
  sendingRecord.value = true;
  try {
    const res = await api.sendVietGapRecord();
    const { sent, count, month } = res.data;
    if (sent) ElMessage.success(t('logbook.monthlySent', { month, count }));
    else ElMessage.info(t('logbook.monthlyEmpty', { month }));
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    sendingRecord.value = false;
  }
};

// ---------- VietGAP pesticide-use log (Excel) ----------
const exporting = ref(false);
const exportVietGap = async () => {
  exporting.value = true;
  try {
    const res = await api.listTreatments({ ...queryParams(), page: 1, limit: 500 });
    const rows = res.data.treatments || [];
    if (!rows.length) {
      ElMessage.info(t('logbook.nothingToExport'));
      return;
    }
    const header = [
      t('logbook.col.index'), t('logbook.col.date'), t('logbook.col.plot'), t('logbook.col.type'), t('logbook.col.product'),
      t('logbook.col.activeIngredient'), t('logbook.col.dose'), t('logbook.col.area'), t('logbook.col.operator'),
      t('logbook.col.phi'), t('logbook.col.harvestFrom'), t('logbook.col.note')
    ].map((value) => ({ value, fontWeight: 'bold', wrap: true }));
    const data = rows
      .slice()
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .map((row, i) => [
        i + 1,
        formatDateTime(row.at),
        cameraNames(row),
        t(`logbook.types.${row.type}`),
        row.product || '',
        row.activeIngredient || '',
        row.dose || '',
        row.area || '',
        row.operator || row.createdBy || '',
        Number.isInteger(row.preHarvestDays) ? row.preHarvestDays : '',
        row.harvestAllowedFrom ? formatDate(row.harvestAllowedFrom) : '',
        row.note || ''
      ]);
    const write = await loadExcelWriter();
    await write([header, ...data], {
      sheet: t('logbook.sheetName').slice(0, 31),
      columns: [5, 18, 24, 18, 24, 20, 16, 14, 18, 12, 14, 30].map((width) => ({ width })),
      stickyRowsCount: 1
    }).toFile(`FlyBot_VietGAP_${new Date().toISOString().slice(0, 10)}.xlsx`);
    ElMessage.success(t('logbook.exported', { count: rows.length }));
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    exporting.value = false;
  }
};

onMounted(() => {
  load();
  loadIngredients();
});
</script>

<style scoped>
.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.log-strong {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.log-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.log-row {
  padding: 12px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-bg-color-overlay);
}
</style>
