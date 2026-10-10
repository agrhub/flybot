<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const activeSection = ref('gettingStarted');

const sections = computed(() => [
  {
    id: 'gettingStarted',
    title: t('manual.gettingStarted'),
    steps: [
      { titleKey: 'manual.stepAccountTitle', descKey: 'manual.stepAccountDesc' },
      { titleKey: 'manual.stepPairingTitle', descKey: 'manual.stepPairingDesc' },
      { titleKey: 'manual.stepSettingsTitle', descKey: 'manual.stepSettingsDesc' }
    ]
  },
  {
    id: 'surveillanceGrid',
    title: t('manual.surveillanceGrid'),
    steps: [
      { titleKey: 'manual.stepGridTitle', descKey: 'manual.stepGridDesc' },
      { titleKey: 'manual.stepLiveControlsTitle', descKey: 'manual.stepLiveControlsDesc' },
      { titleKey: 'manual.stepHeartbeatTitle', descKey: 'manual.stepHeartbeatDesc' }
    ]
  },
  {
    id: 'visionAi',
    title: t('manual.visionAi'),
    steps: [
      { titleKey: 'manual.stepAiModelTitle', descKey: 'manual.stepAiModelDesc' },
      { titleKey: 'manual.stepConfidenceTitle', descKey: 'manual.stepConfidenceDesc' },
      { titleKey: 'manual.stepHeatmapTitle', descKey: 'manual.stepHeatmapDesc' }
    ]
  },
  {
    id: 'reporting',
    title: t('manual.reporting'),
    steps: [
      { titleKey: 'manual.stepTrendTitle', descKey: 'manual.stepTrendDesc' },
      { titleKey: 'manual.stepExportTitle', descKey: 'manual.stepExportDesc' },
      { titleKey: 'manual.stepAlertTitle', descKey: 'manual.stepAlertDesc' }
    ]
  }
]);
</script>

<template>
  <div id="manual-page" class="min-h-screen bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] py-12 px-6 max-w-6xl mx-auto">
    <div class="mb-10 text-center md:text-left">
      <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e] block mb-2">{{ t('nav.manual') }}</span>
      <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">{{ t('manual.title') }}</h1>
      <p class="text-sm text-[var(--el-text-color-secondary)] mt-2 max-w-2xl leading-relaxed">{{ t('manual.subtitle') }}</p>
    </div>

    <!-- Element Plus Tabs -->
    <el-tabs v-model="activeSection" class="demo-tabs">
      <el-tab-pane
        v-for="sec in sections"
        :key="sec.id"
        :label="sec.title"
        :name="sec.id"
      >
        <div class="space-y-4 pt-4">
          <el-card
            v-for="(step, idx) in sec.steps"
            :key="step.titleKey"
            shadow="hover"
            class="!border !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] !rounded-2xl transition-all hover:!border-[#3ecf8e]/50"
          >
            <div class="flex items-start gap-4">
              <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-[#3ecf8e] text-[#002112] text-xs font-bold shrink-0 mt-0.5 shadow-sm">
                {{ idx + 1 }}
              </div>
              <div class="space-y-1">
                <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">{{ t(step.titleKey) }}</h3>
                <p class="text-xs sm:text-sm text-[var(--el-text-color-secondary)] leading-relaxed">{{ t(step.descKey) }}</p>
              </div>
            </div>
          </el-card>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
