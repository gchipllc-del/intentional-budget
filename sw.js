/* Intentional — offline app shell.
   Strategy: stale-while-revalidate for same-origin GETs — cached response serves
   instantly, a background refetch updates the cache, so installed users are at most
   one launch behind after any deploy (no manual CACHE bump needed for updates).
   Bump CACHE only as an emergency full reset. */
const CACHE = 'intentional-v2';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // cache:'no-cache' revalidates against the server (cheap 304s) so a fresh install
      // can't be populated from a stale browser HTTP cache (GH Pages max-age=600).
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Only touch OUR caches: GitHub Pages project sites share one origin, so an
      // unqualified cleanup would wipe any other app's caches on this account.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('intentional-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Never intercept cross-origin requests (the bank-sync Worker API, Plaid's CDN):
  // they must fail loudly offline, not be answered with cached HTML.
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
      if (hit) {
        e.waitUntil(refresh.catch(() => {})); // serve stale now, refresh in background
        return hit;
      }
      // The index fallback applies to page navigations ONLY — returning HTML for a
      // failed data/script request corrupts callers expecting JSON or JS.
      return refresh.catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});
