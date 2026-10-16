<template>
  <div class="flex flex-col gap-4" data-test="sentinel-approvals">
    <el-alert type="info" :closable="false" show-icon :title="t('sentinel.approvals.intro')" />
    <el-alert
      v-if="!canDecide"
      type="warning"
      :closable="false"
      show-icon
      :title="t('sentinel.approvals.readOnlyBanner')"
      data-test="read-only-banner"
    />

    <el-card shadow="never">
      <el-tabs v-model="tab">
        <el-tab-pane name="pending">
          <template #label>
            <span class="inline-flex items-center gap-1.5">
              {{ t('sentinel.approvals.pending') }}
              <el-tag :type="pending.length ? 'warning' : 'info'" effect="light" size="small" round>{{ pending.length }}</el-tag>
            </span>
          </template>
        </el-tab-pane>
        <el-tab-pane name="history">
          <template #label>
            <span class="inline-flex items-center gap-1.5">
              {{ t('sentinel.approvals.history') }}
              <el-tag type="info" effect="light" size="small" round>{{ history.length }}</el-tag>
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <div v-loading="loading && !list.length" :element-loading-text="t('common.loading')" class="flex flex-col gap-4 min-h-[120px]">
        <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
        <el-empty
          v-if="!loading && !error && !list.length"
          :description="tab === 'pending' ? t('sentinel.approvals.noPending') : t('sentinel.approvals.noHistory')"
          :image-size="80"
        />
        <ApprovalCard
          v-for="a in list"
          :key="a.approval_id"
          :ref="(el) => setCardRef(a.approval_id, el)"
          :approval="a"
          :can-decide="canDecide"
          :focused="a.approval_id === focusId"
          @decided="onDecided"
          @refresh="load"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import ApprovalCard from '@/components/sentinel/ApprovalCard.vue';
import { useSentinel, sentinelGet, sentinelErrorKind, items } from '@/composables/useSentinel';
import { mergeByCreated } from '@/utils/sentinel/approvals';

const { t } = useI18n();
const route = useRoute();
const { canDecide, refreshSummary } = useSentinel();

const tab = ref('pending');
const pending = ref([]);
const history = ref([]);
const loading = ref(false);
const error = ref('');
const list = computed(() => (tab.value === 'pending' ? pending.value : history.value));

// ?id= (from the overview, a trace, a notification): that proposal, highlighted
const focusId = computed(() => (typeof route.query.id === 'string' ? route.query.id : ''));
const cardRefs = new Map();
const setCardRef = (id, el) => {
  if (el) cardRefs.set(id, el);
  else cardRefs.delete(id);
};

async function load() {
  loading.value = true;
  try {
    const [p, ...rest] = await Promise.all(['pending', 'approved', 'rejected', 'expired'].map((status) => sentinelGet('approvals', { status, limit: 50 })));
    pending.value = items(p);
    history.value = mergeByCreated(...rest.map(items));
    error.value = '';
  } catch (err) {
    error.value = t(`sentinel.errors.${sentinelErrorKind(err)}`);
  } finally {
    loading.value = false;
  }
}

async function focusRequested() {
  if (!focusId.value) return;
  if (!pending.value.some((a) => a.approval_id === focusId.value) && history.value.some((a) => a.approval_id === focusId.value)) {
    tab.value = 'history';
  }
  await nextTick();
  cardRefs.get(focusId.value)?.$el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}

async function onDecided() {
  await load();
  refreshSummary();
}

let timer = null;
onMounted(async () => {
  await load();
  focusRequested();
  timer = setInterval(load, 20000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
