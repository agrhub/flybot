/* FlyBot service worker: push notifications only (no offline caching, so a deploy is never served stale). */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Only same-origin app paths may be opened from a notification
function safePath(url) {
  try {
    const target = new URL(url || '/dashboard', self.location.origin);
    return target.origin === self.location.origin ? target.pathname + target.search : '/dashboard';
  } catch (e) {
    return '/dashboard';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'FlyBot';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    tag: data.tag || undefined,
    // A replaced alert (same tag) should still buzz the phone
    renotify: !!data.tag,
    requireInteraction: data.type === 'pest_threshold',
    data: { url: safePath(data.url) }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      if ('navigate' in existing) await existing.navigate(path).catch(() => {});
      return;
    }
    await self.clients.openWindow(path);
  })());
});

// The browser rotated the subscription: register the new one (signed in via the httpOnly cookie)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const options = event.oldSubscription && event.oldSubscription.options;
    if (!options || !options.applicationServerKey) return;
    const subscription = event.newSubscription || await self.registration.pushManager.subscribe(options);
    await fetch('/api/push/subscriptions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
  })().catch(() => {}));
});
