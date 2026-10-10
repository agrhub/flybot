<template>
  <div class="bg-[var(--el-card-bg-color)] p-8 sm:p-10 rounded-[32px] shadow-2xl w-full border border-[var(--el-border-color)] relative z-10 backdrop-blur-md text-center">
    <router-link to="/" class="inline-block group cursor-pointer">
      <img
        src="/logo.png"
        alt="FlyBot Logo"
        class="inline-block w-16 h-16 rounded-3xl object-contain mb-5 shadow-xl shadow-emerald-500/25 ring-2 ring-emerald-500/20 group-hover:scale-105 transition-transform"
      />
    </router-link>

    <div v-if="status === 'pending'" class="flex flex-col items-center gap-3 text-sm text-[var(--el-text-color-secondary)]">
      <div class="w-6 h-6 border-2 border-[var(--primary-green)] border-t-transparent rounded-full animate-spin"></div>
      {{ t('auth.verifyingEmail') }}
    </div>

    <div v-else-if="status === 'success'" class="text-sm leading-relaxed text-emerald-500 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4">
      {{ t('auth.emailVerified') }}
    </div>

    <div v-else class="text-sm leading-relaxed text-red-400 bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
      {{ t('auth.verifyInvalid') }}
    </div>

    <router-link
      v-if="status !== 'pending'"
      :to="signedIn ? '/dashboard' : '/auth/login'"
      class="mt-6 w-full h-12 rounded-2xl bg-[var(--primary-green)] hover:bg-emerald-400 text-slate-950 font-black text-sm flex items-center justify-center shadow-lg shadow-emerald-500/20 transition-all"
    >
      {{ signedIn ? t('auth.goToDashboard') : t('auth.backToLogin') }}
    </router-link>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const { refreshUser } = useAuth();

const status = ref('pending'); // 'pending' | 'success' | 'invalid'
let signedIn = false;
try {
  signedIn = !!localStorage.getItem('token');
} catch (e) {}

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : '';
  // Drop the token from the address bar so it is not kept in history or sent as a Referer
  if (route.query.token) router.replace({ path: route.path });
  if (!token) {
    status.value = 'invalid';
    return;
  }
  try {
    await api.verifyEmail(token);
    status.value = 'success';
    if (signedIn) refreshUser();
  } catch (e) {
    status.value = 'invalid';
  }
});
</script>
