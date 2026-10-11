<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';

// Privacy policy and terms: sections come from <ns>.sections in the locale files.
// A body line per paragraph; several lines become a list.
const props = defineProps({
  ns: { type: String, required: true },
  navKey: { type: String, required: true }
});

const { t, tm } = useI18n();
const contactEmail = ref(null);

const sectionKeys = computed(() => Object.keys(tm(`${props.ns}.sections`) || {}));
const emailText = computed(() => contactEmail.value || t('legal.contactFallback'));
const linesOf = (key) => t(`${props.ns}.sections.${key}.body`, { email: emailText.value }).split('\n').filter(Boolean);

onMounted(async () => {
  try {
    contactEmail.value = (await api.getAuthConfig()).data?.contactEmail || null;
  } catch {
    contactEmail.value = null;
  }
});
</script>

<template>
  <div class="min-h-screen bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] py-16 px-6 max-w-4xl mx-auto space-y-8">
    <div class="space-y-2">
      <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e]">{{ t(navKey) }}</span>
      <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">{{ t(`${ns}.title`) }}</h1>
      <p class="text-xs text-[var(--el-text-color-secondary)]">{{ t(`${ns}.lastUpdated`) }}</p>
      <p class="text-sm text-[var(--el-text-color-regular)] leading-relaxed pt-2">{{ t(`${ns}.intro`) }}</p>
    </div>

    <div class="space-y-6">
      <el-card
        v-for="key in sectionKeys"
        :key="key"
        shadow="never"
        class="!border !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] !rounded-2xl p-2 transition-all hover:!border-[#3ecf8e]/40"
      >
        <h3 class="font-bold text-base text-[var(--el-text-color-primary)] mb-2.5 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-[#3ecf8e] shrink-0"></span>
          {{ t(`${ns}.sections.${key}.title`) }}
        </h3>
        <ul v-if="linesOf(key).length > 1" class="list-disc pl-5 space-y-1.5">
          <li v-for="(line, i) in linesOf(key)" :key="i" class="text-xs sm:text-sm text-[var(--el-text-color-secondary)] leading-relaxed">{{ line }}</li>
        </ul>
        <p v-else class="text-xs sm:text-sm text-[var(--el-text-color-secondary)] leading-relaxed">{{ linesOf(key)[0] }}</p>
      </el-card>
    </div>
  </div>
</template>
