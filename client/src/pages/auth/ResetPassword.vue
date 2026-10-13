<template>
  <el-card shadow="never" class="auth-card w-full">
    <div class="text-center mb-6">
      <router-link to="/" class="inline-block">
        <img src="/logo.png" alt="FlyBot Logo" class="inline-block w-16 h-16 rounded-2xl object-contain mb-3" />
      </router-link>
      <h1 class="auth-title">{{ t('auth.newPasswordTitle') }}</h1>
    </div>

    <!-- Invalid / expired link -->
    <div v-if="invalid || !resetToken" class="space-y-5">
      <el-alert type="error" :closable="false" show-icon :title="t('auth.resetInvalid')" />
      <router-link :to="{ path: '/auth/login', query: { mode: 'forgot' } }" custom v-slot="{ navigate }">
        <el-button type="primary" size="large" class="w-full" @click="navigate">
          {{ t('auth.requestNewLink') }}
        </el-button>
      </router-link>
    </div>

    <el-form v-else label-position="top" size="large" @submit.prevent="handleReset">
      <el-form-item :label="t('auth.newPassword')">
        <el-input v-model="form.password" type="password" show-password :placeholder="t('auth.passwordHint')" autocomplete="new-password" />
      </el-form-item>
      <el-form-item :label="t('auth.confirmPassword')">
        <el-input
          v-model="form.confirm"
          type="password"
          show-password
          autocomplete="new-password"
          @keyup.enter="handleReset"
        />
      </el-form-item>
      <el-button type="primary" class="w-full" :loading="loading" @click="handleReset">
        {{ t('auth.resetBtn') }}
      </el-button>
    </el-form>

    <p class="text-center mt-6">
      <router-link to="/auth/login" custom v-slot="{ navigate }">
        <el-button link type="primary" @click="navigate">{{ t('auth.backToLogin') }}</el-button>
      </router-link>
    </p>
  </el-card>
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

<style scoped>
.auth-card {
  border-radius: 16px;
}

.auth-card :deep(.el-card__body) {
  padding: 32px;
}

.auth-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
</style>
