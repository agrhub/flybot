import { ref, computed } from 'vue';
import api from '@/services/api';
import i18n from '@/i18n';

/**
 * Field work recorded without signal (a treatment, a card change) waits on the device and is
 * sent when the network is back. Each item carries a clientId, so if a send did reach the
 * server but its answer was lost, sending it again does not record it twice.
 * Kept per signed-in person in localStorage; an item the server refuses (e.g. a camera that is
 * no longer theirs) stays with its reason until removed.
 */
const SENDERS = {
  treatment: (body) => api.createTreatment(body, { offlineQueue: true }),
  maintenance: (body) => api.addMaintenance(body, { offlineQueue: true })
};

const userId = () => {
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    return user?.id || user?._id || null;
  } catch {
    return null;
  }
};
const storageKey = () => (userId() ? `flybot_outbox_${userId()}` : null);

function read() {
  const key = storageKey();
  if (!key) return [];
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const items = ref(read());
const sending = ref(false);

function write() {
  const key = storageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(items.value));
  } catch {
    // Storage full or blocked: the items stay in memory for this session
  }
}

export const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/** No answer at all from the server: the request may be sent again later. */
export const isNetworkError = (err) => !!err && !err.response && err.code !== 'ERR_CANCELED';

/** Keep a request to send later. `body` must already carry its clientId. */
export function enqueue(kind, body, label = '') {
  items.value = [...items.value, { id: body.clientId, kind, body, label, createdAt: new Date().toISOString(), error: null }];
  write();
}

export function removeItem(id) {
  items.value = items.value.filter((item) => item.id !== id);
  write();
}

/**
 * Send what is waiting, oldest first. Stops at the first network error (still offline);
 * a refusal is kept with its message. Returns how many were sent.
 */
export async function flush() {
  if (sending.value) return 0;
  items.value = read();
  const waiting = items.value.filter((item) => !item.error);
  if (!waiting.length) return 0;
  sending.value = true;
  let sent = 0;
  try {
    for (const item of waiting) {
      try {
        await SENDERS[item.kind](item.body);
        items.value = items.value.filter((x) => x.id !== item.id);
        sent++;
      } catch (err) {
        if (isNetworkError(err)) break;
        item.error = err.response?.data?.message || i18n.global.t('common.error');
      }
      write();
    }
  } finally {
    sending.value = false;
    write();
  }
  return sent;
}

// Back online, or the app opened: send what is waiting
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flush(); });
}

export function useOutbox() {
  return {
    items,
    sending,
    pending: computed(() => items.value.filter((item) => !item.error)),
    failed: computed(() => items.value.filter((item) => item.error)),
    reload: () => { items.value = read(); },
    flush,
    removeItem
  };
}
