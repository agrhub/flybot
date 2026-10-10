<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import {
  Aim,
  VideoCamera,
  FolderOpened,
  Bell,
  Check,
  DataAnalysis,
  Monitor,
  Document
} from '@element-plus/icons-vue';

const { t } = useI18n();
const { isDark } = useTheme();

function handleScroll(targetId, e) {
  e?.preventDefault();
  const el = document.querySelector(targetId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' });
    history.pushState(null, '', targetId);
  }
}

const isAuthenticated = computed(() => {
  return !!localStorage.getItem('user');
});
</script>

<template>
  <div id="home-page" class="overflow-x-hidden font-sans bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)]">
    <!-- Hero Section -->
    <header id="hero" class="relative min-h-[92vh] flex flex-col md:flex-row items-center justify-center pt-24 pb-16 px-6 overflow-hidden">
      <!-- Background Ambient Glows -->
      <div class="absolute top-1/4 -left-28 w-96 h-96 bg-[#3ecf8e]/10 blur-[130px] rounded-full pointer-events-none"></div>
      <div class="absolute bottom-1/4 -right-28 w-96 h-96 bg-[#3ecf8e]/10 blur-[130px] rounded-full pointer-events-none"></div>

      <div class="container mx-auto max-w-[1440px] grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        <!-- Hero Text Column -->
        <div class="lg:col-span-7 flex flex-col space-y-8 relative z-10">
          <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#3ecf8e]/10 border border-[#3ecf8e]/30 w-fit">
            <span class="w-2 h-2 rounded-full bg-[#3ecf8e] animate-pulse"></span>
            <span class="text-xs font-bold uppercase tracking-[0.2em] text-[#3ecf8e]">
              {{ t('home.tagline') }}
            </span>
          </div>

          <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black leading-[0.95] tracking-tighter text-[var(--el-text-color-primary)]">
            {{ t('home.heroTitlePart1') }}<br>
            {{ t('home.heroTitlePart2') }}<br>
            <span class="text-[#3ecf8e] drop-shadow-sm">{{ t('home.heroTitleWithAi') }}</span>
          </h1>

          <p class="text-base sm:text-lg text-[var(--el-text-color-regular)] max-w-xl leading-relaxed">
            {{ t('home.heroSubtitle') }}
          </p>

          <div class="flex flex-wrap items-center gap-4 pt-2">
            <RouterLink
              :to="isAuthenticated ? '/dashboard' : '/login'"
              class="inline-flex items-center justify-center bg-[#3ecf8e] text-[#002112] px-8 py-4 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-white hover:text-black transition-all w-fit shadow-[0_0_25px_rgba(62,207,142,0.35)] cursor-pointer"
            >
              {{ isAuthenticated ? t('nav.dashboard') : t('home.launchAgent') }}
            </RouterLink>

            <a
              href="#engine"
              @click="(e) => handleScroll('#engine', e)"
              class="inline-flex items-center justify-center border border-[var(--el-border-color)] text-[var(--el-text-color-primary)] px-8 py-4 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-[var(--el-fill-color-light)] transition-all w-fit cursor-pointer"
            >
              {{ t('home.howItWorks') }}
            </a>
          </div>
        </div>

        <!-- Hero Smart Trap Device / Camera Mockup -->
        <div class="lg:col-span-5 flex justify-center relative z-10">
          <div class="relative w-full max-w-[340px] aspect-[9/18] bg-[#0c0e0d] rounded-[3rem] border-[8px] border-[#1a1c1b] shadow-[0_0_80px_rgba(62,207,142,0.22)] ring-1 ring-[var(--el-border-color)] p-3 overflow-hidden group">
            <!-- Sensor Notch -->
            <div class="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-[#1a1c1b] rounded-b-2xl z-30 flex items-center justify-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-[#0a0a0b] ring-1 ring-[#3ecf8e]/40"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            </div>

            <!-- Simulated Camera Screen -->
            <div class="relative w-full h-full rounded-[2rem] overflow-hidden bg-[#121414] border border-[#282a29] flex flex-col justify-between p-4">
              <!-- Top Stream Metadata -->
              <div class="pt-6 flex justify-between items-center text-[10px] font-mono text-emerald-400 z-20">
                <div class="flex items-center gap-1.5 bg-black/60 px-2 py-1 rounded-md backdrop-blur-md">
                  <span class="w-2 h-2 rounded-full bg-[#3ecf8e] animate-ping"></span>
                  <span>CAM-01 • SD 2.0</span>
                </div>
                <div class="bg-black/60 px-2 py-1 rounded-md backdrop-blur-md text-[9px] text-white/80">
                  EZOpen HLS
                </div>
              </div>

              <!-- Center Pest Detection Sticky Trap Simulation with Bounding Boxes -->
              <div class="relative flex-1 my-3 rounded-xl overflow-hidden border border-[#282a29] bg-[#171a18] p-3 flex flex-col justify-center items-center select-none">
                <!-- Trap Texture / Grid Lines -->
                <div class="absolute inset-0 opacity-15 bg-[radial-gradient(#3ecf8e_1px,transparent_1px)] [background-size:16px_16px]"></div>

                <!-- Detection Bounding Box 1 -->
                <div class="absolute top-10 left-8 border-2 border-[#3ecf8e] bg-[#3ecf8e]/15 rounded p-1 shadow-lg transform -rotate-3 transition-transform group-hover:scale-105">
                  <span class="block text-[8px] font-bold text-white bg-[#3ecf8e] px-1 rounded-sm leading-tight text-[#002112]">
                    Bactrocera • 98.4%
                  </span>
                  <div class="w-12 h-10 flex items-center justify-center">
                    <span class="text-xl">🪰</span>
                  </div>
                </div>

                <!-- Detection Bounding Box 2 -->
                <div class="absolute bottom-16 right-6 border-2 border-amber-400 bg-amber-400/15 rounded p-1 shadow-lg transform rotate-2 transition-transform group-hover:scale-105">
                  <span class="block text-[8px] font-bold text-black bg-amber-400 px-1 rounded-sm leading-tight">
                    Spodoptera • 94.2%
                  </span>
                  <div class="w-14 h-12 flex items-center justify-center">
                    <span class="text-2xl">🐛</span>
                  </div>
                </div>

                <!-- Kinetic Center Alert Callout -->
                <div class="relative z-10 text-center px-2 py-3 bg-black/80 backdrop-blur-md rounded-xl border border-[#3ecf8e]/40 shadow-2xl">
                  <span class="text-xs font-black tracking-widest text-[#3ecf8e] uppercase block">
                    {{ t('home.kineticCaption1') }}
                  </span>
                  <span class="text-[10px] font-semibold text-white/90 uppercase block mt-0.5">
                    {{ t('home.kineticCaption2') }}
                  </span>
                </div>
              </div>

              <!-- Bottom Stream Controls HUD -->
              <div class="bg-black/70 backdrop-blur-md rounded-xl p-2.5 border border-white/10 z-20 space-y-2">
                <div class="flex items-center justify-between text-[10px] text-white/70">
                  <span class="font-bold text-[#3ecf8e]">AI DENSITY: 14/TRAP</span>
                  <span>S3 SNAPSHOT: OK</span>
                </div>
                <div class="h-1.5 w-full bg-white/20 rounded-full overflow-hidden">
                  <div class="h-full bg-[#3ecf8e] w-3/4 animate-pulse"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- Marquee Banner Section -->
    <section class="py-12 border-y border-[var(--el-border-color)] overflow-hidden whitespace-nowrap bg-[var(--el-bg-color)]/50 select-none">
      <div class="animate-marquee inline-block">
        <h2 class="text-[10vw] font-black tracking-tighter text-outline uppercase px-4 opacity-40">
          FlyBot AI • Smart Trap • Vision AI • FlyBot AI • Smart Trap • Vision AI • 
        </h2>
        <h2 class="text-[10vw] font-black tracking-tighter text-outline uppercase px-4 opacity-40">
          FlyBot AI • Smart Trap • Vision AI • FlyBot AI • Smart Trap • Vision AI • 
        </h2>
      </div>
    </section>

    <!-- Intro + Bento Grid Section -->
    <section id="engine" class="py-32 px-6 scroll-mt-20">
      <div class="container mx-auto max-w-[1440px]">
        <!-- Intro Header -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-12 mb-20">
          <div class="lg:col-span-3">
            <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e]">
              {{ t('home.theShineAgent') }}
            </span>
          </div>
          <div class="lg:col-span-9">
            <h2 class="text-4xl sm:text-5xl md:text-7xl font-extrabold tracking-tighter mb-8 text-[var(--el-text-color-primary)]" v-html="t('home.introHeading')">
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div class="space-y-3">
                <p class="text-sm leading-relaxed text-[var(--el-text-color-regular)]">
                  {{ t('home.introCol1') }}
                </p>
              </div>
              <div class="space-y-3">
                <p class="text-sm leading-relaxed text-[var(--el-text-color-regular)]">
                  {{ t('home.introCol2') }}
                </p>
              </div>
              <div class="space-y-3">
                <p class="text-sm leading-relaxed text-[var(--el-text-color-regular)]">
                  {{ t('home.introCol3') }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Bento Grid -->
        <div class="grid grid-cols-1 md:grid-cols-12 gap-6">
          <!-- Card 1: Vision AI Detection Engine (Col 8) -->
          <div class="md:col-span-8 bg-[var(--el-card-bg-color)] rounded-2xl p-8 flex flex-col justify-between min-h-[460px] group border border-[var(--el-border-color)] hover:border-[#3ecf8e]/60 transition-all duration-300 shadow-sm">
            <div class="flex justify-between items-start">
              <div class="space-y-2">
                <h3 class="text-2xl sm:text-3xl font-extrabold text-[var(--el-text-color-primary)]">{{ t('home.bento1Title') }}</h3>
                <p class="text-sm text-[var(--el-text-color-regular)] max-w-md">
                  {{ t('home.bento1Desc') }}
                </p>
              </div>
              <div class="w-12 h-12 rounded-2xl bg-[#3ecf8e]/15 flex items-center justify-center shrink-0">
                <el-icon class="text-2xl text-[#3ecf8e]"><Aim /></el-icon>
              </div>
            </div>

            <!-- Interactive UI Skeleton: Vision AI Detection Log -->
            <div class="mt-8 flex-1 bg-[var(--el-bg-color)] rounded-xl border border-[var(--el-border-color)] p-6 overflow-hidden relative shadow-inner">
              <div class="space-y-4">
                <div class="flex items-center justify-between pb-3 border-b border-[var(--el-border-color)]">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-[#3ecf8e] animate-pulse"></span>
                    <span class="text-xs font-mono font-bold text-[var(--el-text-color-primary)]">MODEL: YOLO-PEST-V8-CUSTOM</span>
                  </div>
                  <span class="text-[10px] text-[var(--el-text-color-secondary)] uppercase">Inference: 14ms</span>
                </div>

                <div class="space-y-2.5">
                  <div class="flex items-center justify-between p-2.5 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)]">
                    <span class="text-xs font-medium text-[var(--el-text-color-primary)]">Fruit Fly (Bactrocera dorsalis)</span>
                    <span class="text-xs font-bold text-[#3ecf8e]">98.4% Confidence</span>
                  </div>
                  <div class="flex items-center justify-between p-2.5 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)]">
                    <span class="text-xs font-medium text-[var(--el-text-color-primary)]">Fall Armyworm (Spodoptera)</span>
                    <span class="text-xs font-bold text-amber-500">94.2% Confidence</span>
                  </div>
                  <div class="flex items-center justify-between p-2.5 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)]">
                    <span class="text-xs font-medium text-[var(--el-text-color-primary)]">Brown Planthopper (Nilaparvata)</span>
                    <span class="text-xs font-bold text-[#3ecf8e]">91.8% Confidence</span>
                  </div>
                </div>
              </div>

              <!-- Floating generative pill -->
              <div class="absolute bottom-4 right-4 bg-[#3ecf8e] text-[#002112] px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 shadow-md">
                <span class="w-2 h-2 bg-[#002112] rounded-full animate-pulse-dot"></span>
                {{ t('home.generatingBeats') }}
              </div>
            </div>
          </div>

          <!-- Card 2: Multi-Camera Grid (Col 4) -->
          <div class="md:col-span-4 bg-[var(--el-card-bg-color)] rounded-2xl p-8 flex flex-col justify-between min-h-[460px] group border border-[var(--el-border-color)] hover:border-[#3ecf8e]/60 transition-all duration-300 shadow-sm">
            <div class="flex justify-between items-start">
              <div class="space-y-2">
                <h3 class="text-2xl font-extrabold text-[var(--el-text-color-primary)]">{{ t('home.bento2Title') }}</h3>
                <p class="text-sm text-[var(--el-text-color-regular)]">
                  {{ t('home.bento2Desc') }}
                </p>
              </div>
              <div class="w-12 h-12 rounded-2xl bg-[var(--el-fill-color-light)] flex items-center justify-center shrink-0">
                <el-icon class="text-2xl text-[var(--el-text-color-primary)] opacity-70"><VideoCamera /></el-icon>
              </div>
            </div>

            <!-- Skeleton UI: Multi-Camera Grid Quad Layout -->
            <div class="mt-8 flex-1 bg-[var(--el-bg-color)] rounded-xl p-3 border border-[var(--el-border-color)] grid grid-cols-2 gap-2 shadow-inner">
              <div class="rounded-lg bg-[var(--el-card-bg-color)] border border-[#3ecf8e]/40 p-2 flex flex-col justify-between relative overflow-hidden">
                <div class="flex items-center justify-between text-[9px] text-[#3ecf8e] font-mono">
                  <span>CAM-01</span>
                  <span class="w-1.5 h-1.5 bg-[#3ecf8e] rounded-full"></span>
                </div>
                <div class="text-center text-lg">🪰</div>
                <span class="text-[8px] text-[var(--el-text-color-secondary)] uppercase">SD Mode</span>
              </div>

              <div class="rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] p-2 flex flex-col justify-between">
                <div class="flex items-center justify-between text-[9px] text-[var(--el-text-color-secondary)] font-mono">
                  <span>CAM-02</span>
                  <span class="w-1.5 h-1.5 bg-[#3ecf8e] rounded-full"></span>
                </div>
                <div class="text-center text-lg">🌾</div>
                <span class="text-[8px] text-[var(--el-text-color-secondary)] uppercase">SD Mode</span>
              </div>

              <div class="rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] p-2 flex flex-col justify-between">
                <div class="flex items-center justify-between text-[9px] text-[var(--el-text-color-secondary)] font-mono">
                  <span>CAM-03</span>
                  <span class="w-1.5 h-1.5 bg-[#3ecf8e] rounded-full"></span>
                </div>
                <div class="text-center text-lg">🐛</div>
                <span class="text-[8px] text-[var(--el-text-color-secondary)] uppercase">SD Mode</span>
              </div>

              <div class="rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] p-2 flex flex-col justify-between">
                <div class="flex items-center justify-between text-[9px] text-[var(--el-text-color-secondary)] font-mono">
                  <span>CAM-04</span>
                  <span class="w-1.5 h-1.5 bg-[#3ecf8e] rounded-full"></span>
                </div>
                <div class="text-center text-lg">🌳</div>
                <span class="text-[8px] text-[var(--el-text-color-secondary)] uppercase">SD Mode</span>
              </div>
            </div>
          </div>

          <!-- Card 3: MinIO S3 Snapshot Storage (Col 4) -->
          <div class="md:col-span-4 bg-[var(--el-card-bg-color)] rounded-2xl p-8 flex flex-col justify-between min-h-[460px] group border border-[var(--el-border-color)] hover:border-[#3ecf8e]/60 transition-all duration-300 shadow-sm">
            <div class="flex justify-between items-start">
              <div class="space-y-2">
                <h3 class="text-2xl font-extrabold text-[var(--el-text-color-primary)]">{{ t('home.bento3Title') }}</h3>
                <p class="text-sm text-[var(--el-text-color-regular)]">
                  {{ t('home.bento3Desc') }}
                </p>
              </div>
              <div class="w-12 h-12 rounded-2xl bg-[var(--el-fill-color-light)] flex items-center justify-center shrink-0">
                <el-icon class="text-2xl text-[var(--el-text-color-primary)] opacity-70"><FolderOpened /></el-icon>
              </div>
            </div>

            <!-- Skeleton UI: S3 Cloud Storage Storage Timeline -->
            <div class="mt-8 flex-1 bg-[var(--el-bg-color)] rounded-xl p-5 border border-[var(--el-border-color)] flex flex-col justify-center space-y-4 shadow-inner">
              <div class="flex items-center justify-between text-xs font-mono">
                <span class="text-[var(--el-text-color-secondary)]">Bucket: smart-trap-snaps</span>
                <span class="text-[#3ecf8e] font-bold">AES-256</span>
              </div>
              <div class="space-y-2">
                <div class="h-2 w-full bg-[var(--el-border-color)] rounded-full overflow-hidden">
                  <div class="h-full bg-[#3ecf8e] w-2/3"></div>
                </div>
                <div class="flex justify-between text-[10px] text-[var(--el-text-color-secondary)]">
                  <span>30-Day Auto Retention</span>
                  <span>14.2 GB / 50 GB</span>
                </div>
              </div>
              <div class="pt-2 border-t border-[var(--el-border-color)] flex items-center gap-2 text-[11px] text-[var(--el-text-color-primary)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>Automated hourly sync active</span>
              </div>
            </div>
          </div>

          <!-- Card 4: One-Click Audit & Alerts (Col 8) -->
          <div class="md:col-span-8 bg-[var(--el-card-bg-color)] rounded-2xl p-8 flex flex-col justify-between min-h-[460px] group border border-[var(--el-border-color)] hover:border-[#3ecf8e]/60 transition-all duration-300 shadow-sm">
            <div class="flex justify-between items-start">
              <div class="space-y-2">
                <h3 class="text-2xl sm:text-3xl font-extrabold text-[var(--el-text-color-primary)]">{{ t('home.bento4Title') }}</h3>
                <p class="text-sm text-[var(--el-text-color-regular)] max-w-md">
                  {{ t('home.bento4Desc') }}
                </p>
              </div>
              <div class="w-12 h-12 rounded-2xl bg-[var(--el-fill-color-light)] flex items-center justify-center shrink-0">
                <el-icon class="text-2xl text-[var(--el-text-color-primary)] opacity-70"><Bell /></el-icon>
              </div>
            </div>

            <!-- Skeleton UI: Telegram Alert Mockup & Export Buttons -->
            <div class="mt-8 flex-1 bg-[var(--el-bg-color)] rounded-xl border border-[var(--el-border-color)] p-6 flex flex-col justify-between shadow-inner">
              <!-- Mockup Push Alert -->
              <div class="bg-[var(--el-card-bg-color)] rounded-xl p-4 border border-[#3ecf8e]/40 shadow-sm flex items-start gap-3">
                <div class="w-8 h-8 rounded-full bg-[#3ecf8e]/20 flex items-center justify-center shrink-0 text-base">
                  🚨
                </div>
                <div class="space-y-1">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-bold text-[var(--el-text-color-primary)]">TELEGRAM ALERT: CRITICAL PEST SURGE</span>
                    <span class="text-[9px] text-[var(--el-text-color-secondary)]">Just now</span>
                  </div>
                  <p class="text-xs text-[var(--el-text-color-secondary)]">
                    Sector A3 Cu Chi Orchard exceeded 15 Fruit Flies / trap within 2 hours. Biological intervention recommended.
                  </p>
                </div>
              </div>

              <!-- Export Buttons Mockup -->
              <div class="flex flex-wrap items-center gap-3 pt-4">
                <div class="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] text-xs font-semibold text-[var(--el-text-color-primary)]">
                  <el-icon class="text-red-400"><Document /></el-icon>
                  <span>Export Pest Audit (PDF)</span>
                </div>
                <div class="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] text-xs font-semibold text-[var(--el-text-color-primary)]">
                  <el-icon class="text-emerald-400"><DataAnalysis /></el-icon>
                  <span>Export Historical Timeseries (Excel)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Field Deployments Showcase Section -->
    <section id="gallery" class="py-32 bg-[var(--el-bg-color)] border-y border-[var(--el-border-color)] scroll-mt-20">
      <div class="container mx-auto max-w-[1440px] px-6">
        <div class="flex flex-col md:flex-row justify-between items-end mb-16">
          <div class="max-w-2xl">
            <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e] block mb-3">{{ t('home.galleryTag') }}</span>
            <h2 class="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tighter text-[var(--el-text-color-primary)]">
              {{ t('home.galleryHeading') }}
            </h2>
          </div>
          <div class="mt-6 md:mt-0">
            <RouterLink
              to="/manual"
              class="text-xs font-bold uppercase tracking-widest border-b border-[#3ecf8e] pb-1 text-[#3ecf8e] hover:text-[var(--el-text-color-primary)] transition-colors cursor-pointer"
            >
              {{ t('home.viewAllExports') }} &rarr;
            </RouterLink>
          </div>
        </div>

        <!-- 3 Showcase Deployment Cards -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <!-- Deployment 1 -->
          <div class="rounded-2xl overflow-hidden bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] p-6 space-y-4 hover:border-[#3ecf8e]/50 transition-all shadow-sm">
            <div class="h-44 rounded-xl bg-gradient-to-tr from-emerald-950/60 to-emerald-800/30 flex items-center justify-center text-4xl border border-[var(--el-border-color)]">
              🥭
            </div>
            <div class="space-y-1">
              <span class="text-[10px] font-bold uppercase tracking-widest text-[#3ecf8e]">{{ t('home.showcase1Stat') }}</span>
              <h3 class="text-lg font-bold text-[var(--el-text-color-primary)]">{{ t('home.showcase1Title') }}</h3>
              <p class="text-xs text-[var(--el-text-color-secondary)]">{{ t('home.showcase1Subtitle') }}</p>
            </div>
          </div>

          <!-- Deployment 2 -->
          <div class="rounded-2xl overflow-hidden bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] p-6 space-y-4 hover:border-[#3ecf8e]/50 transition-all shadow-sm">
            <div class="h-44 rounded-xl bg-gradient-to-tr from-pink-950/60 to-rose-800/30 flex items-center justify-center text-4xl border border-[var(--el-border-color)]">
              🐉
            </div>
            <div class="space-y-1">
              <span class="text-[10px] font-bold uppercase tracking-widest text-[#3ecf8e]">{{ t('home.showcase2Stat') }}</span>
              <h3 class="text-lg font-bold text-[var(--el-text-color-primary)]">{{ t('home.showcase2Title') }}</h3>
              <p class="text-xs text-[var(--el-text-color-secondary)]">{{ t('home.showcase2Subtitle') }}</p>
            </div>
          </div>

          <!-- Deployment 3 -->
          <div class="rounded-2xl overflow-hidden bg-[var(--el-card-bg-color)] border border-[var(--el-border-color)] p-6 space-y-4 hover:border-[#3ecf8e]/50 transition-all shadow-sm">
            <div class="h-44 rounded-xl bg-gradient-to-tr from-teal-950/60 to-cyan-800/30 flex items-center justify-center text-4xl border border-[var(--el-border-color)]">
              🏡
            </div>
            <div class="space-y-1">
              <span class="text-[10px] font-bold uppercase tracking-widest text-[#3ecf8e]">{{ t('home.showcase3Stat') }}</span>
              <h3 class="text-lg font-bold text-[var(--el-text-color-primary)]">{{ t('home.showcase3Title') }}</h3>
              <p class="text-xs text-[var(--el-text-color-secondary)]">{{ t('home.showcase3Subtitle') }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Pricing Section -->
    <section id="pricing" class="py-32 px-6 bg-[var(--el-bg-color-page)] scroll-mt-20">
      <div class="container mx-auto max-w-[1440px]">
        <div class="text-center mb-20 space-y-3">
          <span class="text-xs font-bold uppercase tracking-widest text-[#3ecf8e] block">{{ t('nav.pricing') }}</span>
          <h2 class="text-4xl sm:text-5xl md:text-7xl font-extrabold tracking-tighter text-[var(--el-text-color-primary)]" v-html="t('home.pricingHeading')">
          </h2>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <!-- Tier 1: Starter Farm -->
          <div class="p-8 sm:p-10 border border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] rounded-2xl flex flex-col hover:border-[#3ecf8e]/50 transition-colors shadow-sm">
            <h3 class="text-2xl font-bold mb-2 text-[var(--el-text-color-primary)]">{{ t('home.creatorPlan') }}</h3>
            <div class="text-4xl font-extrabold mb-8 text-[var(--el-text-color-primary)]">
              $19<span class="text-sm text-[var(--el-text-color-secondary)] font-normal">{{ t('home.perMonth') }}</span>
            </div>
            <ul class="space-y-4 mb-10 flex-grow">
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planCreatorFeat1') }}</span>
              </li>
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planCreatorFeat2') }}</span>
              </li>
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planCreatorFeat3') }}</span>
              </li>
            </ul>
            <RouterLink
              :to="isAuthenticated ? '/dashboard' : '/login'"
              class="block w-full py-3.5 border border-[var(--el-border-color)] rounded-xl text-center text-xs font-bold uppercase tracking-widest hover:bg-[#3ecf8e] hover:text-[#002112] hover:border-[#3ecf8e] transition-all text-[var(--el-text-color-primary)] cursor-pointer"
            >
              {{ t('home.getStartedBtn') }}
            </RouterLink>
          </div>

          <!-- Tier 2: Pro Agro (Recommended) -->
          <div class="p-8 sm:p-10 border-2 border-[#3ecf8e] bg-[var(--el-card-bg-color)] rounded-2xl flex flex-col relative shadow-[0_0_40px_rgba(62,207,142,0.18)]">
            <span class="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#3ecf8e] text-[#002112] px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-widest whitespace-nowrap shadow-sm">
              {{ t('home.recommended') }}
            </span>
            <h3 class="text-2xl font-bold mb-2 text-[var(--el-text-color-primary)]">{{ t('home.studioPlan') }}</h3>
            <div class="text-4xl font-extrabold mb-8 text-[var(--el-text-color-primary)]">
              $49<span class="text-sm text-[var(--el-text-color-secondary)] font-normal">{{ t('home.perMonth') }}</span>
            </div>
            <ul class="space-y-4 mb-10 flex-grow">
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planStudioFeat1') }}</span>
              </li>
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planStudioFeat2') }}</span>
              </li>
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planStudioFeat3') }}</span>
              </li>
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planStudioFeat4') }}</span>
              </li>
            </ul>
            <RouterLink
              :to="isAuthenticated ? '/dashboard' : '/login'"
              class="block w-full py-3.5 bg-[#3ecf8e] text-[#002112] rounded-xl text-center text-xs font-bold uppercase tracking-widest hover:bg-white hover:text-black transition-all shadow-md cursor-pointer"
            >
              {{ t('home.getStartedBtn') }}
            </RouterLink>
          </div>

          <!-- Tier 3: Enterprise Agro -->
          <div class="p-8 sm:p-10 border border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] rounded-2xl flex flex-col hover:border-[#3ecf8e]/50 transition-colors shadow-sm">
            <h3 class="text-2xl font-bold mb-2 text-[var(--el-text-color-primary)]">{{ t('home.enterprise') }}</h3>
            <div class="text-4xl font-extrabold mb-8 text-[var(--el-text-color-primary)]">
              {{ t('home.customPrice') }}
            </div>
            <ul class="space-y-4 mb-10 flex-grow">
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planEntFeat1') }}</span>
              </li>
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planEntFeat2') }}</span>
              </li>
              <li class="flex items-center space-x-3 text-sm text-[var(--el-text-color-regular)]">
                <el-icon class="text-[#3ecf8e]"><Check /></el-icon>
                <span>{{ t('home.planEntFeat3') }}</span>
              </li>
            </ul>
            <RouterLink
              to="/contact"
              class="block w-full py-3.5 border border-[var(--el-border-color)] rounded-xl text-center text-xs font-bold uppercase tracking-widest hover:bg-[#3ecf8e] hover:text-[#002112] hover:border-[#3ecf8e] transition-all text-[var(--el-text-color-primary)] cursor-pointer"
            >
              {{ t('home.contactSalesBtn') }}
            </RouterLink>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
