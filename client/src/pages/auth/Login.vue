<template>
  <div class="bg-[var(--el-card-bg-color)] p-8 sm:p-10 rounded-[32px] shadow-2xl w-full border border-[var(--el-border-color)] relative z-10 backdrop-blur-md">
    <!-- Brand Logo Header -->
    <div class="text-center mb-8">
      <router-link to="/" class="inline-block group cursor-pointer">
        <img
          src="/logo.png"
          alt="FlyBot Logo"
          class="inline-block w-20 h-20 rounded-3xl object-contain mb-3 shadow-xl shadow-emerald-500/25 ring-2 ring-emerald-500/20 group-hover:scale-105 transition-transform"
        />
        <h1 class="text-3xl font-black tracking-tight text-[var(--el-text-color-primary)]">
          FlyBot<span class="text-[var(--primary-green)]">.</span>
        </h1>
      </router-link>
      <p class="text-xs font-semibold text-[var(--el-text-color-secondary)] uppercase tracking-widest mt-1">
        {{ t('auth.tagline') }}
      </p>
    </div>

    <!-- Login Form -->
    <div v-if="formType === 'login'">
      <form @submit.prevent="handleLogin" class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('auth.accountEmail') }}</label>
          <el-input
            v-model="loginForm.email"
            type="email"
            placeholder="admin@smarttrap.com"
            size="large"
          />
        </div>

        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('auth.password') }}</label>
          <el-input
            v-model="loginForm.password"
            type="password"
            placeholder="••••••••"
            size="large"
            show-password
            @keyup.enter="handleLogin"
          />
        </div>

        <div class="pt-2">
          <button
            type="button"
            @click="handleLogin"
            :disabled="loading"
            class="w-full h-12 rounded-2xl bg-[var(--primary-green)] hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-black text-sm flex items-center justify-center shadow-lg shadow-emerald-500/20 transition-all cursor-pointer active:scale-[0.98]"
          >
            <span v-if="!loading">{{ t('auth.loginBtn') }}</span>
            <div v-else class="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
          </button>
        </div>
      </form>

      <p class="text-center text-xs text-[var(--el-text-color-secondary)] mt-6">
        {{ t('auth.noAccount') }}
        <button
          type="button"
          @click="toggleAuth('register')"
          class="text-[var(--primary-green)] font-bold hover:underline cursor-pointer ml-1"
        >
          {{ t('auth.registerNow') }}
        </button>
      </p>
    </div>

    <!-- Register Form -->
    <div v-if="formType === 'register'">
      <form @submit.prevent="handleRegister" class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('auth.newEmail') }}</label>
          <el-input
            v-model="registerForm.email"
            type="email"
            placeholder="creator@smarttrap.com"
            size="large"
          />
        </div>

        <div>
          <label class="block text-xs font-bold text-[var(--el-text-color-secondary)] mb-1.5">{{ t('auth.passwordHint') }}</label>
          <el-input
            v-model="registerForm.password"
            type="password"
            placeholder="••••••••"
            size="large"
            show-password
            @keyup.enter="handleRegister"
          />
        </div>

        <div class="pt-2">
          <button
            type="button"
            @click="handleRegister"
            :disabled="loading"
            class="w-full h-12 rounded-2xl bg-[var(--primary-green)] hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-black text-sm flex items-center justify-center shadow-lg shadow-emerald-500/20 transition-all cursor-pointer active:scale-[0.98]"
          >
            <span v-if="!loading">{{ t('auth.registerBtn') }}</span>
            <div v-else class="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
          </button>
        </div>
      </form>

      <p class="text-center text-xs text-[var(--el-text-color-secondary)] mt-6">
        {{ t('auth.hasAccount') }}
        <button
          type="button"
          @click="toggleAuth('login')"
          class="text-[var(--primary-green)] font-bold hover:underline cursor-pointer ml-1"
        >
          {{ t('auth.backToLogin') }}
        </button>
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import api from '@/services/api';
import { useI18n } from 'vue-i18n';
import { useAuth } from '@/composables/useAuth';
import { ElNotification } from 'element-plus';

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const { setAuth } = useAuth();

const formType = ref('login');
const loading = ref(false);

const loginForm = reactive({
  email: '',
  password: '',
});

const registerForm = reactive({
  email: '',
  password: '',
});

const toggleAuth = (type) => {
  formType.value = type;
};

const handleLogin = async () => {
  if (!loginForm.email || !loginForm.password) {
    ElNotification({ title: t('common.error'), message: t('auth.loginFailed'), type: 'warning' });
    return;
  }
  loading.value = true;
  try {
    const response = await api.login(loginForm.email, loginForm.password);
    if (response.data.success) {
      setAuth(response.data.user, response.data.token || null);
      ElNotification({ title: t('auth.loginSuccess'), message: t('auth.welcomeBack'), type: 'success' });
      const redirect = route.query.redirect || '/dashboard';
      router.push(redirect);
    } else {
      ElNotification({ title: t('common.error'), message: response.data.message || t('auth.loginFailed'), type: 'error' });
    }
  } catch (error) {
    ElNotification({ title: t('common.error'), message: error.response?.data?.message || t('auth.loginFailed'), type: 'error' });
  } finally {
    loading.value = false;
  }
};

const handleRegister = async () => {
  if (!registerForm.email || !registerForm.password) {
    ElNotification({ title: t('common.error'), message: t('auth.registerFailed'), type: 'warning' });
    return;
  }
  if (registerForm.password.length < 6) {
    ElNotification({ title: t('common.error'), message: t('auth.passwordHint'), type: 'warning' });
    return;
  }
  loading.value = true;
  try {
    const response = await api.register(registerForm.email, registerForm.password);
    if (response.data.success) {
      ElNotification({ title: t('auth.registerSuccess'), message: t('auth.registerSuccessMsg'), type: 'success' });
      formType.value = 'login';
      loginForm.email = registerForm.email;
      loginForm.password = registerForm.password;
    } else {
      ElNotification({ title: t('common.error'), message: response.data.message, type: 'error' });
    }
  } catch (error) {
    ElNotification({ title: t('common.error'), message: error.response?.data?.message || t('auth.registerFailed'), type: 'error' });
  } finally {
    loading.value = false;
  }
};
</script>
