<script setup>
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const sections = [
  { titleKey: 'terms.sec1Title', bodyKey: 'terms.sec1Body' },
  { titleKey: 'terms.sec2Title', bodyKey: 'terms.sec2Body' },
  { titleKey: 'terms.sec3Title', bodyKey: 'terms.sec3Body' },
  { titleKey: 'terms.sec4Title', bodyKey: 'terms.sec4Body' },
  { titleKey: 'terms.sec5Title', bodyKey: 'terms.sec5Body' }
];
</script>

<template>
  <div id="terms-page" class="min-h-screen bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] py-16 px-6 max-w-4xl mx-auto space-y-8">
    <div class="space-y-2">
      <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e]">{{ t('nav.terms') }}</span>
      <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">{{ t('terms.title') }}</h1>
      <p class="text-xs text-[var(--el-text-color-secondary)]">{{ t('terms.lastUpdated') }}</p>
    </div>

    <div class="space-y-6">
      <el-card
        v-for="sec in sections"
        :key="sec.titleKey"
        shadow="never"
        class="!border !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] !rounded-2xl p-2 transition-all hover:!border-[#3ecf8e]/40"
      >
        <h3 class="font-bold text-base text-[var(--el-text-color-primary)] mb-2.5 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-[#3ecf8e]"></span>
          {{ t(sec.titleKey) }}
        </h3>
        <p class="text-xs sm:text-sm text-[var(--el-text-color-secondary)] leading-relaxed">{{ t(sec.bodyKey) }}</p>
      </el-card>
    </div>
  </div>
</template>
