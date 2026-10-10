<template>
  <el-card shadow="never" class="auth-card w-full text-center">
    <router-link to="/" class="inline-block">
      <img src="/logo.png" alt="FlyBot Logo" class="inline-block w-16 h-16 rounded-2xl object-contain mb-2" />
    </router-link>

    <div
      v-if="status === 'pending'"
      v-loading="true"
      :element-loading-text="t('auth.verifyingEmail')"
      element-loading-background="transparent"
      class="pending-box"
    ></div>

    <el-result
      v-else
      :icon="status === 'success' ? 'success' : 'error'"
      :sub-title="status === 'success' ? t('auth.emailVerified') : t('auth.verifyInvalid')"
    >
      <template #extra>
        <router-link :to="signedIn ? '/dashboard' : '/auth/login'" custom v-slot="{ navigate }">
          <el-button type="primary" size="large" class="w-full" @click="navigate">
            {{ signedIn ? t('auth.goToDashboard') : t('auth.backToLogin') }}
          </el-button>
        </router-link>
      </template>
    </el-result>
  </el-card>
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

<style scoped>
.auth-card {
  border-radius: 16px;
}

.auth-card :deep(.el-card__body) {
  padding: 32px;
}

.auth-card :deep(.el-result__extra) {
  width: 100%;
}

.pending-box {
  min-height: 120px;
}
</style>
