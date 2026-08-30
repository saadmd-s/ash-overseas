/**
 * Service worker — SRS §10.10.
 *
 * "Cache the application shell ONLY; never cache financial data, because a
 *  stale balance is a dangerous balance."
 *
 * So: the shell is precached, and every /api/* request is network-only. There
 * is deliberately no stale-while-revalidate and no offline fallback that could
 * render a figure. If the network is down, the owner sees an error — never a
 * number that might be wrong.
 */

const SHELL = 'shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icon.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // NEVER cache financial data. Not the response, not a fallback, nothing.
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Shell assets: cache-first, since they are content-hashed by the build.
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(SHELL).then((cache) => cache.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
