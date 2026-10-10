import { ref, computed } from 'vue';
import api from '@/services/api';

// Singleton state: one service worker and one push subscription per browser
const registration = ref(null);
const serverEnabled = ref(false);
const publicKey = ref('');
const subscribed = ref(false);
const permission = ref(typeof Notification !== 'undefined' ? Notification.permission : 'default');
const busy = ref(false);
const installPrompt = ref(null);
const installed = ref(false);

const supported = typeof window !== 'undefined'
  && 'serviceWorker' in navigator
  && 'PushManager' in window
  && 'Notification' in window;

const isStandalone = () => typeof window !== 'undefined'
  && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);
// iPhone/iPad only allow web push for apps added to the home screen
const isIOS = () => typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Register the service worker and catch the browser's "install app" prompt. Call once at startup.
 */
export function initPwa() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    // Show our own install button instead of the browser mini-bar
    event.preventDefault();
    installPrompt.value = event;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt.value = null;
    installed.value = true;
  });
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    registration.value = reg;
  }).catch((err) => {
    console.warn('Service worker registration failed:', err.message);
  });
}

// navigator.serviceWorker.ready never settles if registration failed, so look it up instead
async function findRegistration() {
  if (registration.value) return registration.value;
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) registration.value = reg;
  return reg || null;
}

// pushManager.subscribe() needs an active worker
function waitUntilActive(reg, timeoutMs = 10000) {
  if (reg.active) return Promise.resolve(reg);
  const worker = reg.installing || reg.waiting;
  if (!worker) return Promise.resolve(reg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service worker did not activate')), timeoutMs);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') {
        clearTimeout(timer);
        resolve(reg);
      }
    });
  });
}

async function currentSubscription() {
  if (!supported) return null;
  const reg = await findRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export function usePush() {
  const needsHomeScreen = computed(() => isIOS() && !isStandalone());
  const canInstall = computed(() => !!installPrompt.value && !isStandalone());

  /**
   * Load server settings and this device's state. A device that is already subscribed is
   * re-sent to the server so it follows whoever is signed in now.
   */
  const refresh = async () => {
    if (!supported) return;
    permission.value = Notification.permission;
    try {
      const res = await api.getPushConfig();
      serverEnabled.value = !!res.data.enabled;
      publicKey.value = res.data.publicKey || '';
    } catch (e) {
      serverEnabled.value = false;
    }
    const sub = await currentSubscription().catch(() => null);
    subscribed.value = !!sub && permission.value === 'granted';
    if (sub && serverEnabled.value && subscribed.value) {
      api.subscribePush(sub.toJSON()).catch(() => {});
    }
  };

  const enable = async () => {
    if (!supported || !serverEnabled.value || busy.value) return false;
    busy.value = true;
    try {
      permission.value = await Notification.requestPermission();
      if (permission.value !== 'granted') return false;
      // Registered at startup; try once more in case that failed (e.g. offline at the time)
      const reg = await findRegistration() || await navigator.serviceWorker.register('/sw.js');
      registration.value = reg;
      await waitUntilActive(reg);
      let sub = await reg.pushManager.getSubscription();
      // A subscription made with other server keys cannot receive our pushes
      const key = sub?.options?.applicationServerKey;
      if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey.value) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey.value),
        });
      }
      await api.subscribePush(sub.toJSON());
      subscribed.value = true;
      return true;
    } finally {
      busy.value = false;
    }
  };

  const disable = async () => {
    if (busy.value) return;
    busy.value = true;
    try {
      const sub = await currentSubscription();
      if (sub) {
        await api.unsubscribePush(sub.endpoint).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      subscribed.value = false;
    } finally {
      busy.value = false;
    }
  };

  const install = async () => {
    const prompt = installPrompt.value;
    if (!prompt) return false;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    installPrompt.value = null;
    return outcome === 'accepted';
  };

  return {
    supported,
    serverEnabled,
    subscribed,
    permission,
    busy,
    needsHomeScreen,
    canInstall,
    installed,
    refresh,
    enable,
    disable,
    install,
  };
}

/**
 * On sign-out: stop pushes to this device for the account that is leaving
 * (the token is passed in because it is cleared right after).
 */
export async function forgetDeviceOnLogout(token) {
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    await api.unsubscribePush(sub.endpoint, token).catch(() => {});
    await sub.unsubscribe();
    subscribed.value = false;
  } catch (e) {}
}
