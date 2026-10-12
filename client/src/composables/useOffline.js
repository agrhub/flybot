import { ref, computed } from 'vue';

// Whether the device is online, and when the data on screen was saved if it came from the
// service worker's offline copy (the response carries X-FlyBot-Saved-At)
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
const savedAt = ref(null);

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { online.value = true; });
  window.addEventListener('offline', () => { online.value = false; });
}

/** Called for every API answer: a saved copy keeps its date, a live answer clears it. */
export function noteResponse(response) {
  const saved = response?.headers?.['x-flybot-saved-at'];
  if (saved) {
    // Show the oldest copy on screen
    if (!savedAt.value || new Date(saved) < new Date(savedAt.value)) savedAt.value = saved;
  } else if (response?.config?.method === 'get') {
    savedAt.value = null;
    online.value = true;
  }
}

/** A request got no answer at all (no network). */
export function noteNetworkError() {
  online.value = false;
}

/** Remove what the service worker saved, e.g. when someone signs out. */
export async function clearOfflineData() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-data' });
    if (typeof caches !== 'undefined') {
      await Promise.all(['flybot-data-v1', 'flybot-photos-v1'].map(name => caches.delete(name)));
    }
  } catch (e) {}
  savedAt.value = null;
}

export function useOffline() {
  const offline = computed(() => !online.value || !!savedAt.value);
  return { online, savedAt, offline };
}
