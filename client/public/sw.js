/* FlyBot service worker: push notifications, and the last data seen for when the farm has no signal.
 *
 * Pages and API data always come from the network first; the saved copy is used only when the
 * network fails, so a deploy or new data is never hidden behind a stale copy. Built files under
 * /assets/ have content hashes in their names and never change, so they are served from the cache.
 * The page clears the saved data when someone signs out ({ type: 'clear-data' }).
 */

const SHELL = 'flybot-shell-v1';
const DATA = 'flybot-data-v1';
const PHOTOS = 'flybot-photos-v1';
const CACHES = [SHELL, DATA, PHOTOS];
const MAX_DATA = 200;
const MAX_PHOTOS = 150;
// Answers that make no sense offline or must never be stored
const NEVER = /^\/api\/(ai\/chat|notifications\/stream|public\/|push\/|auth\/(login|logout|session|register|reset|verify|forgot))|\/export|download=1/;
// Development server files (Vite): never cached
const DEV = /^\/(@vite|@id|@fs|src\/|node_modules\/)/;

// Save the app shell and every page up front (the build lists them in offline-files.json), so a
// page never opened online still opens without signal. Absent on the development server.
async function saveAppFiles() {
  try {
    const response = await fetch('/offline-files.json', { cache: 'no-store' });
    if (!response.ok) return;
    const files = await response.json();
    const cache = await caches.open(SHELL);
    await Promise.all(files.map(async (file) => {
      try {
        const answer = await fetch(file, { cache: 'no-store' });
        if (answer.ok) await cache.put(file, answer);
      } catch (e) { /* saved the next time it is used */ }
    }));
  } catch (e) { /* offline at install: pages are saved as they are opened */ }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(saveAppFiles());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('flybot-') && !CACHES.includes(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-data') {
    event.waitUntil(Promise.all([caches.delete(DATA), caches.delete(PHOTOS)]));
  }
});

// Oldest entries go first once a cache is full
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// A stored copy carries the time it was saved, so the page can say how old it is
async function save(cacheName, key, response, max) {
  if (!response || !response.ok || response.type === 'opaque') return;
  const headers = new Headers(response.headers);
  headers.set('X-FlyBot-Saved-At', new Date().toISOString());
  const body = await response.clone().blob();
  const cache = await caches.open(cacheName);
  await cache.put(key, new Response(body, { status: response.status, statusText: response.statusText, headers }));
  if (max) await trim(cacheName, max);
}

async function networkFirst(request, cacheName, key, max) {
  try {
    const response = await fetch(request);
    if (response.ok && !(response.headers.get('Cache-Control') || '').includes('no-store')) await save(cacheName, key, response, max);
    return response;
  } catch (err) {
    const saved = await caches.match(key, { cacheName });
    if (saved) return saved;
    throw err;
  }
}

async function cacheFirst(request, cacheName, max) {
  const saved = await caches.match(request, { cacheName });
  if (saved) return saved;
  const response = await fetch(request);
  await save(cacheName, request, response, max);
  return response;
}

// The page's styling and fonts come from these hosts: without a saved copy the app would show
// unstyled when there is no signal
const OUTSIDE = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

async function outsideCopy(request) {
  try {
    const response = await fetch(request);
    // Loaded without CORS, these answers are opaque: keep them as they are
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(SHELL);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const saved = await caches.match(request, { cacheName: SHELL });
    if (saved) return saved;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (OUTSIDE.includes(url.hostname)) {
    event.respondWith(outsideCopy(request));
    return;
  }
  if (url.origin !== self.location.origin || DEV.test(url.pathname) || NEVER.test(url.pathname + url.search)) return;
  // Standalone pages outside the app (the expert review): never saved as the app's page
  if (url.pathname.startsWith('/review/')) return;
  // Range requests (video) and the server-sent event stream are left to the browser
  if (request.headers.has('range') || request.headers.get('accept') === 'text/event-stream') return;

  if (request.mode === 'navigate') {
    // Every app route is the same page: one saved copy serves them all
    event.respondWith(networkFirst(request, SHELL, '/'));
  } else if (url.pathname.startsWith('/api/s3/') || url.pathname.startsWith('/api/auth/avatar')) {
    // Photos never change once taken
    event.respondWith(cacheFirst(request, PHOTOS, MAX_PHOTOS));
  } else if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, DATA, request, MAX_DATA));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, SHELL));
  } else if (!url.pathname.startsWith('/media/') && !url.pathname.startsWith('/manual/')) {
    // Logo, icons, fonts: kept current, saved for offline
    event.respondWith(networkFirst(request, SHELL, request));
  }
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
