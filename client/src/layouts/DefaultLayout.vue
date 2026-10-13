<script setup>
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/utils/theme';
import { useAuth } from '@/composables/useAuth';
import LanguageSelect from '@/components/shared/LanguageSelect.vue';
import { Moon, Sunny } from '@element-plus/icons-vue';

const router = useRouter();
const { t } = useI18n();
const { isDark, toggleTheme } = useTheme();
const { isAuthenticated } = useAuth();

function handleNavClick(path) {
  router.push(path);
}

const navLinks = [
  { key: 'nav.home', href: '/' },
  { key: 'nav.manual', href: '/manual' },
  { key: 'nav.contact', href: '/contact' },
  { key: 'nav.terms', href: '/terms' },
  { key: 'nav.privacy', href: '/privacy' }
];

const footerLinks = {
  product: [
    { key: 'nav.manual', href: '/manual' },
    { key: 'nav.contact', href: '/contact' }
  ],
  legal: [
    { key: 'nav.terms', href: '/terms' },
    { key: 'nav.privacy', href: '/privacy' }
  ]
};
</script>

<template>
  <div class="min-h-screen flex flex-col bg-[var(--el-bg-color-page)] text-[var(--el-text-color-primary)] selection:bg-[#3ecf8e] selection:text-[#002112]">
    <!-- Top Sticky Header -->
    <header class="sticky top-0 z-50 w-full border-b border-[var(--el-border-color)] bg-[var(--el-bg-color-page)]/95 backdrop-blur-md transition-colors">
      <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
        <!-- Brand Logo & Left Navigation -->
        <div class="flex items-center gap-8">
          <router-link to="/" class="flex items-center gap-2.5 font-bold tracking-tight">
            <img src="/logo.png" alt="FlyBot Logo" class="h-8 w-auto object-contain" />
            <span class="text-lg font-extrabold tracking-tight text-[var(--el-color-primary)]">FlyBot</span>
          </router-link>

          <nav class="hidden md:flex items-center gap-6 text-xs font-semibold uppercase tracking-wider">
            <router-link
              v-for="link in navLinks"
              :key="link.href"
              :to="link.href"
              class="text-[var(--el-text-color-secondary)] hover:text-[var(--el-color-primary)] transition-colors"
              active-class="!text-[var(--el-color-primary)] font-bold"
            >
              {{ t(link.key) }}
            </router-link>
          </nav>
        </div>

        <!-- Right Controls -->
        <div class="flex items-center gap-3">
          <!-- Theme Toggle Switch -->
          <el-switch
            v-model="isDark"
            :aria-label="t('common.darkTheme')"
            :active-icon="Moon"
            :inactive-icon="Sunny"
            inline-prompt
            @change="toggleTheme"
          />

          <!-- Language Selector -->
          <LanguageSelect />

          <!-- Sign in / open the app -->
          <router-link :to="isAuthenticated ? '/dashboard' : '/auth/login'">
            <button class="bg-[#3ecf8e] text-[#002112] px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider hover:bg-white hover:text-black transition-all shadow-sm cursor-pointer">
              {{ isAuthenticated ? t('nav.dashboard') : t('nav.signIn') }}
            </button>
          </router-link>

          <!-- Mobile Navigation Menu -->
          <div class="md:hidden">
            <el-dropdown trigger="click" @command="handleNavClick">
              <button
                class="w-8 h-8 rounded-xl border border-[var(--el-border-color)] bg-[var(--el-card-bg-color)] flex items-center justify-center text-[var(--el-text-color-regular)] hover:text-[var(--el-color-primary)] transition-all cursor-pointer shadow-sm"
                :aria-label="t('nav.mainNavigation')"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <template #dropdown>
                <el-dropdown-menu class="!rounded-2xl !p-2 !border-[var(--el-border-color)] !bg-[var(--el-card-bg-color)]">
                  <el-dropdown-item
                    v-for="link in navLinks"
                    :key="link.href"
                    :command="link.href"
                    class="!rounded-xl !py-2.5 !px-4 text-xs font-semibold uppercase tracking-wider text-[var(--el-text-color-primary)] hover:!text-[var(--el-color-primary)]"
                  >
                    {{ t(link.key) }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>
    </header>

    <!-- Main View Content -->
    <main class="flex-1">
      <router-view />
    </main>

    <!-- Standard Footer -->
    <footer class="border-t border-[var(--el-border-color)] bg-[var(--el-bg-color)] text-[var(--el-text-color-secondary)] py-12 px-6">
      <div class="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-8">
        <div class="space-y-3 md:col-span-2">
          <div class="flex items-center gap-2">
            <img src="/logo.png" alt="FlyBot Logo" class="h-6 w-auto object-contain" />
            <span class="font-bold text-base text-[var(--el-text-color-primary)]">FlyBot</span>
          </div>
          <p class="text-xs max-w-sm leading-relaxed text-[var(--el-text-color-secondary)]">
            {{ t('footer.tagline') }}
          </p>
        </div>

        <div>
          <h4 class="text-xs font-bold uppercase tracking-wider text-[var(--el-text-color-primary)] mb-3">{{ t('footer.product') }}</h4>
          <ul class="space-y-2 text-xs">
            <li v-for="link in footerLinks.product" :key="link.key">
              <router-link :to="link.href" class="hover:text-[var(--el-color-primary)] transition-colors">
                {{ t(link.key) }}
              </router-link>
            </li>
          </ul>
        </div>

        <div>
          <h4 class="text-xs font-bold uppercase tracking-wider text-[var(--el-text-color-primary)] mb-3">{{ t('footer.legal') }}</h4>
          <ul class="space-y-2 text-xs">
            <li v-for="link in footerLinks.legal" :key="link.key">
              <router-link :to="link.href" class="hover:text-[var(--el-color-primary)] transition-colors">
                {{ t(link.key) }}
              </router-link>
            </li>
          </ul>
        </div>
      </div>

      <div class="max-w-7xl mx-auto mt-10 pt-6 border-t border-[var(--el-border-color)]/60 text-xs text-center text-[var(--el-text-color-placeholder)]">
        {{ t('footer.copyright') }}
      </div>
    </footer>
  </div>
</template>
