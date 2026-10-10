import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/services/api';

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
  const userName = computed(() => user.value?.name || user.value?.email?.split('@')[0] || 'Admin');
  const userEmail = computed(() => user.value?.email || 'admin@smarttrap.com');
  const userInitial = computed(() => (userName.value.charAt(0) || 'A').toUpperCase());

  const setAuth = (userData, userToken = null) => {
    user.value = userData;
    if (userData) {
      localStorage.setItem('user', JSON.stringify(userData));
    } else {
      localStorage.removeItem('user');
    }
    if (userToken) {
      token.value = userToken;
      localStorage.setItem('token', userToken);
    }
  };

  const logout = () => {
    api.logout().catch(() => {});
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
    token,
    isAuthenticated,
    userName,
    userEmail,
    userInitial,
    setAuth,
    logout,
  };
}

export default useAuth;
