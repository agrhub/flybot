<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import { useAuth } from '@/composables/useAuth';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';
import { Moon, Sunny } from '@element-plus/icons-vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { isDark, toggleTheme } = useTheme();
const { isAuthenticated } = useAuth();

const headerNavLinks = [
  { key: 'nav.engine', href: '/#engine' },
  { key: 'nav.gallery', href: '/#gallery' },
  { key: 'nav.pricing', href: '/#pricing' },
  { key: 'nav.manual', href: '/manual' },
  { key: 'nav.contact', href: '/contact' }
];

function handleNavClick(href, e) {
  if (href.startsWith('/#')) {
    e?.preventDefault();
    const hash = href.replace('/', '');
    if (route.path === '/') {
      const el = document.querySelector(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
        history.pushState(null, '', href);
        return;
      }
    }
    router.push(href);
  } else {
    router.push(href);
  }
}
</script>

<template>
  <div class="min-h-screen flex flex-col font-sans bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] selection:bg-[#3ecf8e] selection:text-[#002112]">
    <!-- Top Navigation Header -->
    <header id="public-header" class="fixed top-0 left-0 w-full z-50 px-6 py-4 flex justify-between items-center bg-[var(--el-bg-color-page)]/80 backdrop-blur-md border-b border-[var(--el-border-color)]/60 transition-colors">
      <div class="flex items-center space-x-8">
        <router-link to="/" class="flex items-center gap-2.5 text-xl font-bold tracking-tight text-[var(--el-text-color-primary)]">
          <img src="/logo.png" alt="FlyBot Logo" class="h-8 w-auto object-contain" />
          <span class="tracking-tight font-extrabold text-[#3ecf8e]">FlyBot</span>
        </router-link>
        <nav class="hidden md:flex space-x-6 text-[11px] font-semibold uppercase tracking-widest text-[var(--el-text-color-secondary)]">
          <a
            v-for="link in headerNavLinks"
            :key="link.href"
            :href="link.href"
            class="nav-link-shine relative py-1 hover:text-[var(--el-text-color-primary)] transition-colors cursor-pointer"
            @click="(e) => handleNavClick(link.href, e)"
          >
            {{ t(link.key) }}
          </a>
        </nav>
      </div>

      <!-- Right Controls -->
      <div class="flex items-center space-x-3.5">
        <!-- Live Engine Pulse Indicator -->
        <div class="hidden sm:flex items-center space-x-2 text-[10px] font-bold uppercase tracking-widest text-[var(--el-text-color-secondary)] mr-1">
          <span class="w-2 h-2 bg-[#3ecf8e] rounded-full animate-pulse-dot"></span>
          <span>{{ t('home.liveEngine') }}</span>
        </div>

        <!-- Dark/Light Theme Switch -->
        <el-switch
          v-model="isDark"
          :active-icon="Moon"
          :inactive-icon="Sunny"
          inline-prompt
          @change="toggleTheme"
        />

        <!-- Language Select -->
        <LanguageSelect />

        <!-- Launch / Dashboard Action -->
        <router-link :to="isAuthenticated ? '/dashboard' : '/auth/login'">
          <button class="bg-[#3ecf8e] text-[#002112] px-5 py-2 rounded-full text-[11px] font-bold uppercase tracking-widest hover:bg-white hover:text-black transition-all shadow-sm cursor-pointer">
            {{ isAuthenticated ? t('nav.dashboard') : t('home.startBtn') }}
          </button>
        </router-link>

        <!-- Mobile Navigation Menu -->
        <div class="md:hidden">
          <el-dropdown trigger="click" @command="handleNavClick">
            <button
              class="w-8 h-8 rounded-xl border border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] flex items-center justify-center text-[var(--el-text-color-regular)] hover:text-[#3ecf8e] transition-all cursor-pointer shadow-sm"
              aria-label="Navigation menu"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <template #dropdown>
              <el-dropdown-menu class="!rounded-2xl !p-2 !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)]">
                <el-dropdown-item
                  v-for="link in headerNavLinks"
                  :key="link.href"
                  :command="link.href"
                  class="!rounded-xl !py-2.5 !px-4 text-xs font-semibold uppercase tracking-wider text-[var(--el-text-color-primary)] hover:!text-[#3ecf8e]"
                >
                  {{ t(link.key) }}
                </el-dropdown-item>
                <el-dropdown-item
                  divided
                  command="/privacy"
                  class="!rounded-xl !py-2.5 !px-4 text-xs font-semibold uppercase tracking-wider text-[var(--el-text-color-secondary)] hover:!text-[#3ecf8e]"
                >
                  {{ t('nav.privacy') }}
                </el-dropdown-item>
                <el-dropdown-item
                  command="/terms"
                  class="!rounded-xl !py-2.5 !px-4 text-xs font-semibold uppercase tracking-wider text-[var(--el-text-color-secondary)] hover:!text-[#3ecf8e]"
                >
                  {{ t('nav.terms') }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </header>

    <!-- Main View Content -->
    <main class="flex-1 w-full pt-16">
      <router-view />
    </main>

    <!-- Footer -->
    <footer class="bg-[var(--el-bg-color)] border-t border-[var(--el-border-color)] pt-20 pb-12 px-6">
      <div class="container mx-auto max-w-[1440px]">
        <div class="grid grid-cols-1 md:grid-cols-12 gap-12 mb-16">
          <!-- Brand Column -->
          <div class="md:col-span-4 space-y-4">
            <div class="flex items-center gap-2.5">
              <img src="/logo.png" alt="FlyBot Logo" class="h-7 w-auto object-contain" />
              <span class="text-2xl font-bold tracking-tight text-[#3ecf8e]">FlyBot</span>
            </div>
            <p class="text-sm text-[var(--el-text-color-secondary)] max-w-xs leading-relaxed">
              {{ t('footer.tagline') }}
            </p>
          </div>

          <!-- Product Links -->
          <div class="md:col-span-2">
            <h4 class="text-[10px] font-bold uppercase tracking-widest mb-6 text-[#3ecf8e]/80">{{ t('footer.product') }}</h4>
            <ul class="space-y-3 text-sm text-[var(--el-text-color-secondary)]">
              <li><a href="/#engine" @click="(e) => handleNavClick('/#engine', e)" class="hover:text-[#3ecf8e] transition-colors cursor-pointer">{{ t('nav.capabilities') || t('nav.engine') }}</a></li>
              <li><a href="/#pricing" @click="(e) => handleNavClick('/#pricing', e)" class="hover:text-[#3ecf8e] transition-colors cursor-pointer">{{ t('nav.pricing') }}</a></li>
              <li><a href="/#gallery" @click="(e) => handleNavClick('/#gallery', e)" class="hover:text-[#3ecf8e] transition-colors cursor-pointer">{{ t('nav.showcase') || t('nav.gallery') }}</a></li>
              <li><router-link to="/manual" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.manual') }}</router-link></li>
            </ul>
          </div>

          <!-- Resources Links -->
          <div class="md:col-span-2">
            <h4 class="text-[10px] font-bold uppercase tracking-widest mb-6 text-[#3ecf8e]/80">{{ t('footer.resources') }}</h4>
            <ul class="space-y-3 text-sm text-[var(--el-text-color-secondary)]">
              <li><router-link to="/manual" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.helpCenter') }}</router-link></li>
              <li><router-link to="/contact" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.contact') }}</router-link></li>
              <li><a href="#" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.apiDocs') }}</a></li>
            </ul>
          </div>

          <!-- Company & Legal Links -->
          <div class="md:col-span-2">
            <h4 class="text-[10px] font-bold uppercase tracking-widest mb-6 text-[#3ecf8e]/80">{{ t('footer.company') }}</h4>
            <ul class="space-y-3 text-sm text-[var(--el-text-color-secondary)]">
              <li><router-link to="/manual" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.about') }}</router-link></li>
              <li><router-link to="/privacy" class="hover:text-[#3ecf8e] transition-colors">{{ t('footer.legal') }}</router-link></li>
              <li><router-link to="/terms" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.terms') }}</router-link></li>
            </ul>
          </div>

          <!-- Social Links -->
          <div class="md:col-span-2 flex flex-col justify-end md:items-end">
            <div class="flex space-x-3 text-lg text-[var(--el-text-color-secondary)]">
              <a href="#" aria-label="Twitter" class="w-8 h-8 rounded-full bg-[var(--el-border-color)]/30 flex items-center justify-center font-bold text-xs hover:bg-[#3ecf8e] hover:text-[#002112] transition-all">𝕏</a>
              <a href="#" aria-label="Github" class="w-8 h-8 rounded-full bg-[var(--el-border-color)]/30 flex items-center justify-center font-bold text-xs hover:bg-[#3ecf8e] hover:text-[#002112] transition-all">🐙</a>
              <a href="#" aria-label="LinkedIn" class="w-8 h-8 rounded-full bg-[var(--el-border-color)]/30 flex items-center justify-center font-bold text-xs hover:bg-[#3ecf8e] hover:text-[#002112] transition-all">🔗</a>
            </div>
          </div>
        </div>

        <!-- Copyright & Bottom Links -->
        <div class="pt-8 border-t border-[var(--el-border-color)] flex flex-col md:flex-row justify-between items-center text-[10px] text-[var(--el-text-color-secondary)] uppercase tracking-widest">
          <p>{{ t('home.copyrightText') }}</p>
          <div class="flex space-x-6 mt-4 md:mt-0">
            <router-link to="/privacy" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.privacy') }}</router-link>
            <router-link to="/terms" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.terms') }}</router-link>
            <router-link to="/contact" class="hover:text-[#3ecf8e] transition-colors">{{ t('nav.contact') }}</router-link>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>
