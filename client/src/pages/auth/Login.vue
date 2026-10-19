<template>
  <el-card shadow="never" class="auth-card w-full">
    <!-- Brand Logo Header -->
    <div class="text-center mb-6">
      <router-link to="/" class="inline-block">
        <img src="/logo.png" alt="FlyBot Logo" class="inline-block w-16 h-16 rounded-2xl object-contain mb-3" />
        <h1 class="auth-brand">{{ t('common.brandName') }}</h1>
      </router-link>
      <p class="auth-tagline mt-1">{{ t('auth.tagline') }}</p>
    </div>

    <!-- Login Form -->
    <div v-if="formType === 'login'">
      <el-form label-position="top" size="large" @submit.prevent="handleLogin">
        <el-form-item :label="t('auth.accountEmail')">
          <el-input
            v-model="loginForm.email"
            type="email"
            :placeholder="t('auth.emailPlaceholder')"
          />
        </el-form-item>

        <el-form-item :label="t('auth.password')" class="password-item">
          <el-input
            v-model="loginForm.password"
            type="password"
            placeholder="••••••••"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <div class="text-right mb-4">
          <el-button link type="primary" size="small" @click="toggleAuth('forgot')">
            {{ t('auth.forgotPassword') }}
          </el-button>
        </div>

        <el-button type="primary" class="w-full" :loading="loading" @click="handleLogin">
          {{ t('auth.loginBtn') }}
        </el-button>
        <!-- Guest access: one shared, read-only demo account (Admin > System > Demo access) -->
        <template v-if="guestAccess">
          <el-divider>{{ t('auth.or') }}</el-divider>
          <el-button class="w-full" :icon="View" :loading="guestLoading" data-test="guest-access" @click="handleGuest">
            {{ t('auth.guestAccess') }}
          </el-button>
          <p class="auth-desc text-center mt-2">{{ t('auth.guestHint') }}</p>
        </template>
      </el-form>

      <p v-if="allowRegistration" class="auth-footer text-center mt-6">
        {{ t('auth.noAccount') }}
        <el-button link type="primary" class="ml-1" @click="toggleAuth('register')">
          {{ t('auth.registerNow') }}
        </el-button>
      </p>
    </div>

    <!-- Forgot Password Form -->
    <div v-if="formType === 'forgot'">
      <h2 class="auth-title mb-2">{{ t('auth.forgotTitle') }}</h2>

      <el-alert
        v-if="resetLinkSent"
        type="success"
        :closable="false"
        show-icon
        :title="t('auth.resetLinkSent')"
        class="mt-3"
      />

      <el-form v-else label-position="top" size="large" @submit.prevent="handleForgot">
        <p class="auth-desc mb-4">{{ t('auth.forgotDesc') }}</p>
        <el-form-item :label="t('auth.accountEmail')">
          <el-input
            v-model="forgotForm.email"
            type="email"
            :placeholder="t('auth.emailPlaceholder')"
            @keyup.enter="handleForgot"
          />
        </el-form-item>
        <el-button type="primary" class="w-full" :loading="loading" @click="handleForgot">
          {{ t('auth.sendResetLink') }}
        </el-button>
      </el-form>

      <p class="auth-footer text-center mt-6">
        <el-button link type="primary" @click="toggleAuth('login')">
          {{ t('auth.backToLogin') }}
        </el-button>
      </p>
    </div>

    <!-- Register Form -->
    <div v-if="formType === 'register'">
      <el-alert
        v-if="!allowRegistration"
        type="warning"
        :closable="false"
        show-icon
        :title="t('auth.registrationClosed')"
        class="mb-4"
      />
      <!-- The admin opened read-only demo cameras to new accounts (Admin > System > Demo access) -->
      <el-alert
        v-else-if="demoView"
        type="success"
        :closable="false"
        show-icon
        :title="t('auth.demoViewHint')"
        class="mb-4"
        data-test="demo-hint"
      />
      <el-form label-position="top" size="large" @submit.prevent="handleRegister">
        <el-form-item :label="t('auth.newEmail')">
          <el-input
            v-model="registerForm.email"
            type="email"
            :placeholder="t('auth.emailPlaceholder')"
          />
        </el-form-item>

        <el-form-item :label="t('auth.passwordHint')">
          <el-input
            v-model="registerForm.password"
            type="password"
            placeholder="••••••••"
            show-password
            @keyup.enter="handleRegister"
          />
        </el-form-item>

        <el-button type="primary" class="w-full" :loading="loading" :disabled="!allowRegistration" @click="handleRegister">
          {{ t('auth.registerBtn') }}
        </el-button>
      </el-form>

      <p class="auth-footer text-center mt-6">
        {{ t('auth.hasAccount') }}
        <el-button link type="primary" class="ml-1" @click="toggleAuth('login')">
          {{ t('auth.backToLogin') }}
        </el-button>
      </p>
    </div>
  </el-card>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import api from '@/services/api';
import { useI18n } from 'vue-i18n';
import { savedLocale, SUPPORTED_LOCALES } from '@/i18n';
import { useAuth } from '@/composables/useAuth';
import { ElNotification } from 'element-plus';
import { View } from '@element-plus/icons-vue';

const router = useRouter();
const route = useRoute();
const { t, locale } = useI18n();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { setAuth } = useAuth();

// 'login' | 'register' | 'forgot' (?mode=forgot | ?mode=register opens that form;
// invitation emails link to ?mode=register&email=...)
const formType = ref(['forgot', 'register'].includes(route.query.mode) ? route.query.mode : 'login');
const invitedEmail = typeof route.query.email === 'string' ? route.query.email.slice(0, 254) : '';
// Admins can close sign-up; the server enforces it, this only hides the link
const allowRegistration = ref(true);
const demoView = ref(false);
const guestAccess = ref(false);
onMounted(async () => {
  try {
    const res = await api.getAuthConfig();
    allowRegistration.value = res.data.allowRegistration !== false;
    demoView.value = res.data.demoView === true;
    guestAccess.value = res.data.guestAccess === true;
  } catch {}
});
const resetLinkSent = ref(false);
const loading = ref(false);

const loginForm = reactive({
  email: invitedEmail,
  password: '',
});

const registerForm = reactive({
  email: invitedEmail,
  password: '',
});

const forgotForm = reactive({
  email: '',
});

const toggleAuth = (type) => {
  if (type === 'forgot') {
    forgotForm.email = forgotForm.email || loginForm.email;
    resetLinkSent.value = false;
  }
  formType.value = type;
};

const handleForgot = async () => {
  const email = forgotForm.email.trim();
  if (!EMAIL_REGEX.test(email)) {
    ElNotification({ title: t('common.error'), message: t('auth.invalidEmail'), type: 'warning' });
    return;
  }
  loading.value = true;
  try {
    await api.forgotPassword(email, locale.value);
    // Same message whether or not the account exists
    resetLinkSent.value = true;
  } catch (error) {
    ElNotification({ title: t('common.error'), message: error.response?.data?.message || t('settings.saveFailed'), type: 'error' });
  } finally {
    loading.value = false;
  }
};

const handleLogin = async () => {
  if (!loginForm.email || !loginForm.password) {
    ElNotification({ title: t('common.error'), message: t('auth.loginFailed'), type: 'warning' });
    return;
  }
  loading.value = true;
  try {
    // Only a language picked on this browser updates the account; otherwise the account's own language wins
    const picked = savedLocale();
    const response = await api.login(loginForm.email, loginForm.password, picked || undefined);
    if (response.data.success) {
      const accountLanguage = response.data.user?.language;
      if (!picked && SUPPORTED_LOCALES.some((l) => l.code === accountLanguage)) {
        locale.value = accountLanguage;
        try { localStorage.setItem('flybot_language', accountLanguage); } catch (e) {}
      }
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

// Guest access: the shared demo account keeps this browser's language
const guestLoading = ref(false);
const handleGuest = async () => {
  guestLoading.value = true;
  try {
    const response = await api.guestLogin();
    setAuth(response.data.user, response.data.token || null);
    router.push('/dashboard');
  } catch (error) {
    ElNotification({ title: t('common.error'), message: error.response?.data?.message || t('auth.loginFailed'), type: 'error' });
  } finally {
    guestLoading.value = false;
  }
};

const handleRegister = async () => {
  if (!registerForm.email || !registerForm.password) {
    ElNotification({ title: t('common.error'), message: t('auth.registerFailed'), type: 'warning' });
    return;
  }
  if (registerForm.password.length < 6) {
    ElNotification({ title: t('common.error'), message: t('auth.passwordTooShort'), type: 'warning' });
    return;
  }
  loading.value = true;
  try {
    const response = await api.register(registerForm.email, registerForm.password, locale.value);
    if (response.data.success) {
      ElNotification({ title: t('auth.registerSuccess'), message: t('auth.registerSuccessVerify'), type: 'success' });
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

<style scoped>
.auth-card {
  border-radius: 16px;
}

.auth-card :deep(.el-card__body) {
  padding: 32px;
}

.password-item {
  margin-bottom: 8px;
}

.auth-brand {
  font-size: 24px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.auth-tagline,
.auth-desc,
.auth-footer {
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.auth-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
</style>
