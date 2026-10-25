<template>
  <el-tooltip :content="t('tour.pageButton')" placement="bottom" :show-after="300">
    <el-button :aria-label="t('tour.pageButton')" circle :icon="Guide" data-test="page-tour" @click="replay" />
  </el-tooltip>
  <el-tour
    v-if="page !== 'dashboard' && steps.length"
    :model-value="open"
    :current="current"
    @update:current="goTo"
    :z-index="3000"
    @update:model-value="(value) => !value && finish()"
    @finish="finish"
  >
    <el-tour-step
      v-for="step in steps"
      :key="step.key"
      :target="step.target"
      :title="t(`tour.pages.${page}.${step.key}.title`)"
      :description="t(`tour.pages.${page}.${step.key}.desc`)"
      :placement="step.placement"
    />
  </el-tour>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Guide } from '@element-plus/icons-vue';
import { useAppTour } from '@/composables/useAppTour';
import { usePageTour } from '@/composables/usePageTour';
import { useBreakpoints } from '@/composables/useBreakpoints';
import { PAGE_TOURS } from '@/utils/pageTours';

/**
 * The page's tour button, and its tour: a few steps on what the page is for and its main controls (marked with
 * data-tour). Steps whose control is not on screen for this person are left out. The Dashboard's button replays
 * the app tour.
 */
const props = defineProps({
  page: { type: String, required: true }
});

const { t } = useI18n();
const { open, start, finish, startIfNew } = usePageTour(props.page);
const { isMobile } = useBreakpoints();
const current = ref(0);
const steps = ref([]);

const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

const build = () => {
  steps.value = (PAGE_TOURS[props.page] || [])
    .map((step) => {
      if (!step.target) return { ...step, target: undefined };
      const root = document.querySelector(`[data-tour="${step.target}"]`);
      // inner: the part to point at (the tab bar of el-tabs, a card's header with its controls)
      const el = step.inner ? root?.querySelector(step.inner) : root;
      if (!visible(el)) return null;
      // Phones: no room beside a control, the step goes above or below it
      const placement = isMobile.value && /^(left|right)/.test(step.placement || '') ? undefined : step.placement;
      return { ...step, target: el, placement };
    })
    .filter(Boolean);
};

const replay = () => {
  if (props.page === 'dashboard') useAppTour().start();
  else start();
};

// The next step's control is brought on screen first, so the step points at where it is (el-tour measures it
// right after its own scroll, which leaves some steps off screen in the app's scrolling main area)
const goTo = (index) => {
  steps.value[index]?.target?.scrollIntoView({ block: 'center' });
  current.value = index;
};

watch(open, async (value) => {
  // Closed: the next opening starts from the first step, without scrolling to the last one
  if (!value) {
    current.value = 0;
    return;
  }
  await nextTick();
  build();
  current.value = 0;
}, { immediate: true });

let cancelFirstVisit = () => {};
onMounted(() => {
  if (props.page !== 'dashboard') cancelFirstVisit = startIfNew();
});
onUnmounted(() => {
  cancelFirstVisit();
  // Left the page during its tour: it has been seen
  if (open.value) finish();
});
</script>
