<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { VideoPlay } from '@element-plus/icons-vue';

const { t, tm, locale } = useI18n();
const route = useRoute();
const router = useRouter();

// Screenshots in /public/manual/<vi|en> (taken from the app with sample data), per "section.step"
const IMAGES = {
  'start.account': ['dashboard', 'dashboard-cameras', 'app-tour'],
  'start.camera': ['add-camera'],
  'start.schedule': ['camera-settings'],
  'cameras.live': ['cameras', 'playback'],
  'cameras.health': ['camera-detail', 'camera-info'],
  'cameras.card': ['maintenance'],
  'ai.count': ['history', 'history-export', 'camera-history'],
  'ai.review': ['detection'],
  'ai.analytics': ['analytics', 'widget-filter', 'catch-chart'],
  'ai.insights': ['insights', 'insights-table'],
  'ai.forecast': ['diagnosis', 'weather-outlook'],
  'farms.plots': ['farms', 'farm-map'],
  'farms.map': ['map'],
  'farms.sharing': ['organizations'],
  'farms.log': ['logbook', 'logbook-ingredients'],
  'alerts.smart': ['notifications'],
  'alerts.channels': ['alert-settings'],
  'alerts.reports': ['reports', 'report-share', 'report-schedule'],
  'assistant.ask': ['assistant'],
  'assistant.cards': ['assistant-chart'],
  'assistant.photo': ['assistant-photo'],
  'assistant.confirm': ['assistant-confirm'],
  'mobile.app': ['mobile-dashboard', 'mobile-cameras'],
  'mobile.more': ['mobile-more'],
  'integrations.api': ['integrations']
};
const imageUrl = (name) => `/manual/${locale.value === 'en' ? 'en' : 'vi'}/${name}.webp`;
const isPhone = (name) => name.startsWith('mobile-');

// Sections and steps come from manual.sections in the locale files
const sections = computed(() => Object.entries(tm('manual.sections') || {}).map(([id, section]) => ({
  id,
  steps: Object.keys(section.steps || {}).map(step => ({
    key: step,
    images: IMAGES[`${id}.${step}`] || []
  }))
})));
const itemsOf = (sectionId, step) => t(`manual.sections.${sectionId}.steps.${step}.items`).split('\n').filter(Boolean);

// ?tab=integrations opens that section directly (e.g. from the footer)
const activeSection = ref(sections.value.some(s => s.id === route.query.tab) ? route.query.tab : 'start');
watch(activeSection, (tab) => router.replace({ query: { ...route.query, tab } }));

const videoLang = computed(() => (locale.value === 'en' ? 'en' : 'vi'));
</script>

<template>
  <div id="manual-page" class="min-h-screen bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] py-12 px-4 sm:px-6 max-w-6xl mx-auto">
    <div class="mb-8 text-center md:text-left">
      <span class="text-xs font-bold uppercase tracking-widest text-[var(--el-color-primary)] block mb-2">{{ t('nav.manual') }}</span>
      <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-[var(--el-text-color-primary)]">{{ t('manual.title') }}</h1>
      <p class="text-sm text-[var(--el-text-color-secondary)] mt-2 max-w-2xl leading-relaxed">{{ t('manual.subtitle') }}</p>
    </div>

    <!-- One-minute tour -->
    <el-card shadow="never" class="manual-video mb-10" body-class="!p-0">
      <div class="grid grid-cols-1 lg:grid-cols-5">
        <div class="lg:col-span-3 bg-black">
          <video
            :key="videoLang"
            class="w-full aspect-video block"
            controls
            playsinline
            preload="metadata"
            :poster="`/media/flybot-tour-${videoLang}-poster.webp`"
          >
            <source :src="`/media/flybot-tour-${videoLang}.mp4`" type="video/mp4" />
          </video>
        </div>
        <div class="lg:col-span-2 p-6 flex flex-col justify-center gap-2">
          <el-icon class="text-3xl text-[var(--el-color-primary)]"><VideoPlay /></el-icon>
          <h2 class="text-xl font-bold text-[var(--el-text-color-primary)]">{{ t('manual.videoTitle') }}</h2>
          <p class="text-sm text-[var(--el-text-color-secondary)] leading-relaxed">{{ t('manual.videoDesc') }}</p>
        </div>
      </div>
    </el-card>

    <el-tabs v-model="activeSection">
      <el-tab-pane
        v-for="sec in sections"
        :key="sec.id"
        :label="t(`manual.sections.${sec.id}.title`)"
        :name="sec.id"
      >
        <div class="space-y-6 pt-4">
          <el-card
            v-for="(step, idx) in sec.steps"
            :key="step.key"
            shadow="never"
            class="!border !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)] !rounded-2xl"
          >
            <div class="grid grid-cols-1 gap-6" :class="step.images.length ? 'lg:grid-cols-5' : ''">
              <!-- Text -->
              <div class="lg:col-span-2 space-y-3 min-w-0">
                <div class="flex items-start gap-3">
                  <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-[#3ecf8e] text-[#002112] text-xs font-bold shrink-0">
                    {{ idx + 1 }}
                  </div>
                  <div class="min-w-0">
                    <h3 class="font-bold text-base text-[var(--el-text-color-primary)]">{{ t(`manual.sections.${sec.id}.steps.${step.key}.title`) }}</h3>
                    <p class="text-sm text-[var(--el-text-color-secondary)] leading-relaxed mt-1">{{ t(`manual.sections.${sec.id}.steps.${step.key}.desc`) }}</p>
                  </div>
                </div>
                <div class="manual-howto">
                  <p class="manual-howto__label">{{ t('manual.stepsLabel') }}</p>
                  <ol class="list-decimal pl-5 space-y-1.5">
                    <li v-for="(line, i) in itemsOf(sec.id, step.key)" :key="i" class="text-sm text-[var(--el-text-color-regular)] leading-relaxed">{{ line }}</li>
                  </ol>
                </div>
              </div>

              <!-- Screenshots -->
              <div v-if="step.images.length" class="lg:col-span-3 min-w-0">
                <div class="flex flex-wrap justify-center gap-4">
                  <el-image
                    v-for="name in step.images"
                    :key="name"
                    :src="imageUrl(name)"
                    :preview-src-list="step.images.map(imageUrl)"
                    :initial-index="step.images.indexOf(name)"
                    :alt="t(`manual.sections.${sec.id}.steps.${step.key}.title`)"
                    fit="contain"
                    lazy
                    preview-teleported
                    hide-on-click-modal
                    class="manual-shot"
                    :class="isPhone(name) ? 'manual-shot--phone' : 'w-full'"
                  />
                </div>
                <p class="text-xs text-center text-[var(--el-text-color-secondary)] mt-2">{{ t('manual.zoomHint') }}</p>
              </div>
            </div>
          </el-card>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.manual-video {
  overflow: hidden;
  border-radius: 1rem;
}
.manual-howto {
  padding: 12px 14px;
  border-radius: var(--el-border-radius-base);
  background-color: var(--el-fill-color-light);
}
.manual-howto__label {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--el-text-color-secondary);
}
.manual-shot {
  border-radius: 12px;
  border: 1px solid var(--el-border-color);
  cursor: zoom-in;
  background-color: var(--el-fill-color-lighter);
}
.manual-shot--phone {
  width: 200px;
}
</style>
