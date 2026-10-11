<template>
  <el-tour
    v-if="steps.length"
    :model-value="open"
    v-model:current="current"
    :z-index="3000"
    @update:model-value="(value) => !value && finish()"
    @finish="finish"
  >
    <el-tour-step
      v-for="step in steps"
      :key="step.key"
      :target="step.target"
      :title="t(`tour.steps.${step.key}.title`)"
      :description="t(`tour.steps.${step.key}.desc`)"
      :placement="step.placement"
    />
  </el-tour>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppTour } from '@/composables/useAppTour';
import { useAuth } from '@/composables/useAuth';
import { useBreakpoints } from '@/composables/useBreakpoints';

/**
 * A short guided tour of the app: each step points at a part of the layout (marked with
 * data-tour). Steps whose target is not on screen (phone layout, role) are left out.
 */
const { t } = useI18n();
const { open, finish } = useAppTour();
const { canManageCameras } = useAuth();
const { isMobile } = useBreakpoints();
const current = ref(0);
const steps = ref([]);

// key: text in tour.steps.<key>; target: data-tour name (none: centered)
const STEPS = [
  { key: 'welcome' },
  { key: 'dashboard', target: 'nav-dashboard' },
  { key: 'addCamera', target: 'add-camera', manager: true },
  { key: 'cameras', target: 'nav-cameras' },
  { key: 'analytics', target: 'nav-analytics' },
  { key: 'reports', target: 'nav-reports' },
  { key: 'farms', target: 'nav-farms' },
  { key: 'logbook', target: 'nav-logbook' },
  { key: 'map', target: 'nav-map' },
  { key: 'more', target: 'nav-more' },
  { key: 'notifications', target: 'notifications' },
  { key: 'assistant', target: 'assistant' },
  { key: 'profile', target: 'profile' },
  { key: 'done' },
];

const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

const build = () => {
  steps.value = STEPS
    .filter(step => !step.manager || canManageCameras.value)
    .map((step) => {
      if (!step.target) return { ...step, target: undefined };
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (!visible(el)) return null;
      // Sidebar items: the panel beside them; phone tab bar: above it
      const placement = step.target.startsWith('nav-') ? (isMobile.value ? 'top' : 'right') : 'bottom-end';
      return { ...step, target: el, placement };
    })
    .filter(Boolean);
};

watch(open, async (value) => {
  if (!value) return;
  await nextTick();
  build();
  current.value = 0;
});
</script>
