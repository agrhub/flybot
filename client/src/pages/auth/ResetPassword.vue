<template>
  <div class="bg-[var(--el-card-bg-color)] p-8 sm:p-10 rounded-[32px] shadow-2xl w-full border border-[var(--el-border-color)] relative z-10 backdrop-blur-md">
    <div class="text-center mb-8">
      <router-link to="/" class="inline-block group cursor-pointer">
        <img
          src="/logo.png"
          alt="FlyBot Logo"
          class="inline-block w-16 h-16 rounded-3xl object-contain mb-3 shadow-xl shadow-emerald-500/25 ring-2 ring-emerald-500/20 group-hover:scale-105 transition-transform"
        />
      </router-link>
      <h1 class="text-xl font-black tracking-tight text-[var(--el-text-color-primary)]">
        {{ t('auth.newPasswordTitle') }}
      </h1>
    </div>

    <!-- Invalid / expired link -->
    <div v-if="invalid || !resetToken" class="space-y-5">
      <div class="text-xs leading-relaxed text-red-400 bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
        {{ t('auth.resetInvalid') }}
      </div>
      <router-link
        :to="{ path: '/auth/login', query: { mode: 'forgot' } }"
        class="w-full h-12 rounded-2xl bg-[var(--primary-green)] hover:bg-emerald-400 text-slate-950 font-black text-sm flex items-center justify-center shadow-lg shadow-emerald-500/20 transition-all"
      >
        {{ t('auth.requestNewLink') }}
      </router-link>
    </div>

    <form v-else @submit.prevent="handleReset" class="space-y-4">
      <div>
        <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('auth.newPassword') }}</label>
        <el-input v-model="form.password" type="password" show-password size="large" :placeholder="t('auth.passwordHint')" autocomplete="new-password" />
      </div>
      <div>
        <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('auth.confirmPassword') }}</label>
        <el-input
          v-model="form.confirm"
          type="password"
          show-password
          size="large"
          autocomplete="new-password"
          @keyup.enter="handleReset"
        />
      </div>
      <div class="pt-2">
        <button
          type="button"
          @click="handleReset"
          :disabled="loading"
          class="w-full h-12 rounded-2xl bg-[var(--primary-green)] hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-black text-sm flex items-center justify-center shadow-lg shadow-emerald-500/20 transition-all cursor-pointer active:scale-[0.98]"
        >
          <span v-if="!loading">{{ t('auth.resetBtn') }}</span>
          <div v-else class="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
        </button>
      </div>
    </form>

    <p class="text-center text-xs text-[var(--el-text-color-secondary)] mt-6">
      <router-link to="/auth/login" class="text-[var(--primary-green)] font-bold hover:underline">
        {{ t('auth.backToLogin') }}
      </router-link>
    </p>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElNotification } from 'element-plus';
import api from '@/services/api';

const router = useRouter();
const route = useRoute();
const { t } = useI18n();

const resetToken = ref(typeof route.query.token === 'string' ? route.query.token : '');
const invalid = ref(false);
const loading = ref(false);
const form = reactive({ password: '', confirm: '' });

onMounted(() => {
  // Drop the token from the address bar so it is not kept in history or sent as a Referer
  if (route.query.token) router.replace({ path: route.path });
});

const handleReset = async () => {
  if (form.password.length < 6) {
    ElNotification({ title: t('common.error'), message: t('auth.passwordTooShort'), type: 'warning' });
    return;
  }
  if (form.password !== form.confirm) {
    ElNotification({ title: t('common.error'), message: t('auth.passwordMismatch'), type: 'warning' });
    return;
  }
  loading.value = true;
  try {
    await api.resetPassword(resetToken.value, form.password);
    // Any stored session is no longer valid
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    } catch (e) {}
    ElNotification({ title: t('common.success'), message: t('auth.resetSuccess'), type: 'success', duration: 6000 });
    router.push('/auth/login');
  } catch (error) {
    if (error.response?.data?.code === 'INVALID_TOKEN') {
      invalid.value = true;
    } else {
      ElNotification({ title: t('common.error'), message: error.response?.data?.message || t('settings.saveFailed'), type: 'error' });
    }
  } finally {
    loading.value = false;
  }
};
</script>
