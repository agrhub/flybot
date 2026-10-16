import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/services/api';
import i18n from '@/i18n';
import { useNotifications } from '@/composables/useNotifications';
import { forgetDeviceOnLogout } from '@/composables/usePush';
import { clearOfflineData } from '@/composables/useOffline';

// Singleton authentication state
const user = ref((() => {
  try {
    return JSON.parse(localStorage.getItem('user')) || null;
  } catch (e) {
    return null;
  }
})());

const token = ref((() => {
  try {
    return localStorage.getItem('token') || null;
  } catch (e) {
    return null;
  }
})());

export function useAuth() {
  const router = useRouter();

  const isAuthenticated = computed(() => !!user.value && !!user.value.id);
  const userName = computed(() => user.value?.name || user.value?.email?.split('@')[0] || i18n.global.t('common.defaultUserName'));
  const userEmail = computed(() => user.value?.email || '');
  const userInitial = computed(() => (userName.value.charAt(0) || 'A').toUpperCase());
  // System role: admin (operator), support (reads the admin pages), user. What a person may do
  // with cameras comes from the current workspace and its plan (user.capabilities from the server)
  const role = computed(() => user.value?.role || 'user');
  const isAdmin = computed(() => role.value === 'admin');
  const isSupport = computed(() => role.value === 'support');
  const capabilities = computed(() => user.value?.capabilities || {});
  const legacyWorker = computed(() => ['admin', 'manager'].includes(role.value));
  const canManageCameras = computed(() => capabilities.value.addCameras ?? legacyWorker.value);
  const canBuildDashboards = computed(() => capabilities.value.buildDashboards ?? legacyWorker.value);
  const appMode = computed(() => user.value?.appMode || 'hybrid');
  const currentWorkspace = computed(() => user.value?.workspace || null);
  const currentPlan = computed(() => user.value?.plan || null);

  const setAuth = (userData, userToken = null) => {
    user.value = userData;
    if (userData) {
      localStorage.setItem('user', JSON.stringify(userData));
    } else {
      localStorage.removeItem('user');
    }
    if (userToken) {
      // A new sign-in must not see what the previous account left for offline use
      clearOfflineData();
      token.value = userToken;
      localStorage.setItem('token', userToken);
    }
  };

  // Reload the profile (e.g. emailVerified after confirming the address)
  const refreshUser = async () => {
    try {
      const res = await api.getMe();
      if (res.data?.user) setAuth(res.data.user);
    } catch (e) {}
  };

  const logout = () => {
    // This device should not keep getting the previous account's alerts
    forgetDeviceOnLogout(token.value || localStorage.getItem('token'));
    api.logout().catch(() => {});
    useNotifications().reset();
    clearOfflineData();
    user.value = null;
    token.value = null;
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    if (router) {
      router.push('/auth/login');
    } else {
      window.location.href = '/auth/login';
    }
  };

  return {
    user,
    isSupport,
    capabilities,
    appMode,
    currentWorkspace,
    currentPlan,
    token,
    isAuthenticated,
    userName,
    userEmail,
    userInitial,
    role,
    isAdmin,
    canManageCameras,
    canBuildDashboards,
    setAuth,
    refreshUser,
    logout,
  };
}

export default useAuth;
