import { ref } from 'vue';
import { ElNotification } from 'element-plus';
import api from '@/services/api';
import i18n from '@/i18n';

// Singleton state shared by the topbar bell and anything else that needs it
const items = ref([]);
const unreadCount = ref(0);
const hasMore = ref(false);
const loading = ref(false);
// Callbacks for live notifications (e.g. reload cameras when one is shared with you)
const listeners = new Set();

function onNotification(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
let eventSource = null;

const PAGE_SIZE = 20;
const TOAST_TYPE = { critical: 'error', warning: 'warning', info: 'success' };

// Params that are stable keys (an image issue) become text in the current language
function localizeParams(params) {
  if (!params.issue) return params;
  return { ...params, issueText: i18n.global.t(`cameras.imageQuality.issues.${params.issue}`) };
}

function format(notification) {
  const { t } = i18n.global;
  const base = `notifications.types.${notification.type}`;
  return {
    title: t(`${base}.title`),
    // A lure-trap threshold alert is about the day's average
    desc: t(`${base}.${notification.params?.basis === 'dailyAverage' ? 'descDaily' : 'desc'}`, localizeParams(notification.params || {}))
  };
}

function relativeTime(date) {
  const { t, locale } = i18n.global;
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 45) return t('notifications.justNow');
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const [unit, size] = units.find(([, s]) => Math.abs(seconds) >= s) || ['minute', 60];
  return new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}

async function load() {
  loading.value = true;
  try {
    const res = await api.getNotifications({ limit: PAGE_SIZE });
    items.value = res.data.notifications || [];
    unreadCount.value = res.data.unreadCount || 0;
    hasMore.value = !!res.data.hasMore;
  } catch (e) {
    console.error('Failed to load notifications:', e);
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  const last = items.value[items.value.length - 1];
  if (!last || loading.value) return;
  loading.value = true;
  try {
    const res = await api.getNotifications({ limit: PAGE_SIZE, before: last.createdAt });
    items.value = [...items.value, ...(res.data.notifications || [])];
    hasMore.value = !!res.data.hasMore;
  } catch (e) {
    console.error('Failed to load more notifications:', e);
  } finally {
    loading.value = false;
  }
}

async function markRead(ids) {
  const unread = ids.filter((id) => items.value.some((n) => n.id === id && !n.read));
  if (unread.length === 0) return;
  items.value = items.value.map((n) => (unread.includes(n.id) ? { ...n, read: true } : n));
  try {
    const res = await api.markNotificationsRead(unread);
    unreadCount.value = res.data.unreadCount ?? Math.max(0, unreadCount.value - unread.length);
  } catch (e) {
    console.error('Failed to mark notifications read:', e);
  }
}

async function markAllRead() {
  items.value = items.value.map((n) => ({ ...n, read: true }));
  try {
    const res = await api.markNotificationsRead('all');
    unreadCount.value = res.data.unreadCount ?? 0;
  } catch (e) {
    console.error('Failed to mark all notifications read:', e);
  }
}

/**
 * Open the live stream (once). EventSource reconnects by itself after network drops.
 */
function connect() {
  if (eventSource || typeof EventSource === 'undefined') return;
  eventSource = new EventSource(api.notificationStreamUrl, { withCredentials: true });
  eventSource.addEventListener('notification', (event) => {
    let notification;
    try {
      notification = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (items.value.some((n) => n.id === notification.id)) return;
    items.value = [notification, ...items.value];
    unreadCount.value += 1;
    const { title, desc } = format(notification);
    ElNotification({ title, message: desc, type: TOAST_TYPE[notification.severity] || 'info', duration: 6000 });
    listeners.forEach((callback) => callback(notification));
  });
}

function disconnect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function reset() {
  disconnect();
  items.value = [];
  unreadCount.value = 0;
  hasMore.value = false;
}

export function useNotifications() {
  return {
    items,
    unreadCount,
    hasMore,
    loading,
    load,
    loadMore,
    markRead,
    markAllRead,
    connect,
    disconnect,
    reset,
    format,
    onNotification,
    relativeTime
  };
}

export default useNotifications;
