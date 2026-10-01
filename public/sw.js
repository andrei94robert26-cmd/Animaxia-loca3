/*
 * sw.js — Animaxia service worker (vanilla, zero dependencies).
 *
 * Strategy (TS2a):
 *  - install: pre-cache a minimal static shell ('/', '/offline.html', icons)
 *    then skipWaiting so a new SW activates immediately.
 *  - activate: delete every cache that is not CACHE (old versions), then
 *    clients.claim() to take control of open pages.
 *  - fetch (same-origin GET only):
 *      /api/*            → network-only (API responses are NEVER cached);
 *      /posters/*, /icons/* → cache-first (immutable assets);
 *      HTML navigations  → network-first, fallback to '/offline.html';
 *      other GET assets  → network-first with cache fallback (so the
 *                          installed app shell keeps working offline).
 */

const CACHE = 'animaxia-v1';
const OFFLINE_URL = '/offline.html';
const STATIC_ASSETS = ['/', OFFLINE_URL, '/icons/icon-192.svg', '/icons/icon-512.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* a failed pre-cache must not block installation */
      }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Cache-first: serve from cache when possible, otherwise fetch and cache. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}

/** Network-first: try the network, fall back to cache (or a fallback response). */
async function networkFirst(request, fallbackResponse) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic' && request.method === 'GET') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (fallbackResponse) {
      const fallback = await cache.match(fallbackResponse);
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; /* cross-origin: browser default */

  /* API traffic is never intercepted and never cached. */
  if (url.pathname.startsWith('/api/')) return;

  /* Immutable static assets → cache-first. */
  if (url.pathname.startsWith('/posters/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request).catch(() => fetch(request)));
    return;
  }

  /* HTML navigations → network-first with the honest offline fallback page. */
  const isNavigation =
    request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  if (isNavigation) {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        const offline = await cache.match(OFFLINE_URL);
        return offline || Response.error();
      }),
    );
    return;
  }

  /* Other same-origin GET assets (JS/CSS chunks, fonts) → network-first with
     cache fallback, so the installed shell keeps loading offline. */
  event.respondWith(networkFirst(request).catch(() => caches.match(request).then((hit) => hit || Response.error())));
});
