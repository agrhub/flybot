<template>
  <div class="w-full pb-10">
    <DetectionHistory ref="historyRef" :default-camera="camera?.deviceSerial || 'all'" :default-range="range" />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import DetectionHistory from '@/components/history/DetectionHistory.vue';

// Analytics tab: the detection history, starting from the page filters
defineProps({
  camera: { type: Object, default: null },
  range: { type: Object, default: () => ({ preset: '30d' }) },
});

const { t } = useI18n();
const historyRef = ref(null);

/** Every record matching the table's filters, as a PDF section (utils/analyticsPdf.js). */
const pdfSections = async () => {
  const items = await historyRef.value.loadAll();
  return [{ part: t('analytics.tabHistory'), title: t('analytics.tabHistory'), lines: historyRef.value.filterLines(), history: items }];
};

defineExpose({ pdfSections });
</script>
