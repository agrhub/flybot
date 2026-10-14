<template>
  <!-- What to do next on each plot: shown only when something needs doing -->
  <el-card v-if="todo.length" shadow="never" class="plan-card">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h3 class="plan-title">{{ t('plan.title') }}</h3>
          <p class="plan-meta">{{ t('plan.desc') }}</p>
        </div>
        <el-button size="small" :icon="Notebook" @click="router.push('/logbook')">{{ t('plan.log') }}</el-button>
      </div>
    </template>
    <ul class="plan-list">
      <li v-for="item in shown" :key="`${item.farm}|${item.plot}`" class="plan-row">
        <el-tag :type="TAG[item.action]" effect="light" round size="small" class="shrink-0">{{ t(`plan.actions.${item.action}`) }}</el-tag>
        <div class="min-w-0 flex-1">
          <p class="plan-place">{{ item.plot ? `${item.farm} · ${item.plot}` : item.farm }}</p>
          <p class="plan-meta">{{ reason(item) }}</p>
          <p v-if="item.rotateFrom" class="plan-rotate">{{ t('plan.rotate', { ingredient: item.rotateFrom }) }}</p>
        </div>
        <span v-if="item.date" class="plan-date shrink-0">{{ dayLabel(item.date) }}</span>
      </li>
    </ul>
    <el-button v-if="todo.length > MAX" link type="primary" class="mt-1" @click="expanded = !expanded">
      {{ expanded ? t('plan.less') : t('plan.more', { count: todo.length - MAX }) }}
    </el-button>
    <p class="plan-note">{{ t('plan.note') }}</p>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { Notebook } from '@element-plus/icons-vue';
import api from '@/services/api';

const MAX = 4;
const TAG = { treat_now: 'danger', wait_check: 'info', bait_before_wave: 'warning', sanitation: 'primary' };
const { t } = useI18n();
const router = useRouter();

const plan = ref({ today: null, items: [] });
const expanded = ref(false);
// Plots with nothing but monitoring to do are left out
const todo = computed(() => plan.value.items.filter((i) => i.action !== 'monitor'));
const shown = computed(() => (expanded.value ? todo.value : todo.value.slice(0, MAX)));

const dayMonth = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
const dayLabel = (key) => {
  if (key === plan.value.today) return t('plan.today');
  return dayMonth(key);
};
const reason = (item) => {
  const params = {
    count: item.atThreshold,
    ftd: item.ftd7 ?? '--',
    wave: item.wave ? dayMonth(item.wave.date) : '',
    until: item.waitUntil ? dayMonth(item.waitUntil) : ''
  };
  const text = t(`plan.reasons.${item.action}`, params);
  return item.rainMoved ? `${text} ${t('plan.rainMoved')}` : text;
};

onMounted(async () => {
  try {
    plan.value = (await api.getSprayPlan()).data;
  } catch {
    // A suggestion that cannot be made is simply not shown
  }
});
</script>

<style scoped>
.plan-card :deep(.el-card__header) {
  padding: 14px 18px;
}
.plan-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.plan-meta,
.plan-note {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.plan-note {
  margin-top: 8px;
}
.plan-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.plan-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.plan-row:last-child {
  border-bottom: none;
}
.plan-place {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.plan-rotate {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--el-color-warning);
}
.plan-date {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
</style>
