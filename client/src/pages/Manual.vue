<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';

const { t, tm } = useI18n();
const route = useRoute();
const router = useRouter();

// Sections and their steps come from manual.sections in the locale files
const sections = computed(() => Object.entries(tm('manual.sections') || {}).map(([id, section]) => ({
  id,
  steps: Object.keys(section.steps || {})
})));

// ?tab=integrations opens that section directly (e.g. from the footer)
const activeSection = ref(sections.value.some(s => s.id === route.query.tab) ? route.query.tab : 'start');
watch(activeSection, (tab) => router.replace({ query: { ...route.query, tab } }));
</script>

<template>
  <div id="manual-page" class="min-h-screen bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] py-12 px-6 max-w-6xl mx-auto">
    <div class="mb-10 text-center md:text-left">
      <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e] block mb-2">{{ t('nav.manual') }}</span>
      <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">{{ t('manual.title') }}</h1>
      <p class="text-sm text-[var(--el-text-color-secondary)] mt-2 max-w-2xl leading-relaxed">{{ t('manual.subtitle') }}</p>
    </div>

    <el-tabs v-model="activeSection">
      <el-tab-pane
        v-for="sec in sections"
        :key="sec.id"
        :label="t(`manual.sections.${sec.id}.title`)"
        :name="sec.id"
      >
        <div class="space-y-4 pt-4">
          <el-card
            v-for="(step, idx) in sec.steps"
            :key="step"
            shadow="hover"
            class="!border !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] !rounded-2xl transition-all hover:!border-[#3ecf8e]/50"
          >
            <div class="flex items-start gap-4">
              <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-[#3ecf8e] text-[#002112] text-xs font-bold shrink-0 mt-0.5 shadow-sm">
                {{ idx + 1 }}
              </div>
              <div class="space-y-1">
                <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">{{ t(`manual.sections.${sec.id}.steps.${step}.title`) }}</h3>
                <p class="text-xs sm:text-sm text-[var(--el-text-color-secondary)] leading-relaxed">{{ t(`manual.sections.${sec.id}.steps.${step}.desc`) }}</p>
              </div>
            </div>
          </el-card>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
