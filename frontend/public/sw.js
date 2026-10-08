// StalkerWeb Service Worker
// Caches the app shell (JS/CSS/HTML) for instant loads after first visit.
// API calls (/api/*, /proxy/*) are always fetched from network — never cached.

const CACHE   = 'stalkerweb-v2';
const OFFLINE = '/';

// App-shell assets to pre-cache on install
const PRECACHE = ['/'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // Remove old caches
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept API, proxy or Stremio-addon requests — always go to network.
  // (Opened in a tab, /stremio/manifest.json would otherwise be cached as the
  // app shell.)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/proxy/') ||
      url.pathname.startsWith('/stremio/')) return;

  // Navigation requests (the HTML shell): network-first. The shell references
  // content-hashed JS/CSS, so a stale cached shell points at chunks that no
  // longer exist after a deploy ("Failed to fetch dynamically imported module").
  // Always fetch the latest shell; fall back to cache only when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(OFFLINE, clone));
          return response;
        })
        .catch(() => caches.match(OFFLINE))
    );
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Cache successful GET responses for static assets
        if (e.request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
