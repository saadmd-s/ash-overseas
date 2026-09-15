/**
 * Service worker — SRS §10.10.
 *
 * "Cache the application shell ONLY; never cache financial data, because a
 *  stale balance is a dangerous balance."
 *
 * So: every /api/* request is network-only. There is deliberately no
 * stale-while-revalidate and no offline fallback that could render a figure.
 * If the network is down, the owner sees an error — never a number that might
 * be wrong.
 *
 * THE HTML PAGE IS NETWORK-FIRST. The previous version served `/` cache-first
 * forever, and it took the live site down:
 *
 *   1. `/` was precached on first visit and never re-fetched.
 *   2. This file never changed, so the browser never installed a new worker,
 *      so that cache was never cleared.
 *   3. Every deploy renames the content-hashed bundles. The cached HTML went on
 *      asking for the old names, which no longer existed.
 *   4. The server's single-page-app fallback answered a missing .js with
 *      index.html and a 200, and the browser refused to run HTML as a script.
 *
 * Result: a blank page on the owner's phone after the first redeploy following
 * their first visit, while the site worked perfectly for anyone else.
 *
 * The rule now is the only one that is correct for a content-hashed build:
 *   - the HTML document, which NAMES the bundles, always comes from the network
 *     and uses the cache only when offline;
 *   - /assets/*, whose names change whenever their content does, is
 *     cache-first, because a given URL can never go stale.
 *
 * ⚠ Bump SHELL whenever this file's caching rules change. A changed file is
 * what makes the browser install the new worker, and the new name is what makes
 * `activate` delete everything the old one cached — including, this time, HTML
 * stored under .js URLs by the bug above.
 */

const SHELL = 'shell-v3';

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

/** Store a response only if it is really the thing that was asked for. */
function cacheable(request, res) {
  if (!res.ok || res.type !== 'basic') return false;
  // Belt and braces for the failure above: nothing under /assets/ is HTML.
  const isAsset = new URL(request.url).pathname.startsWith('/assets/');
  return !(isAsset && (res.headers.get('content-type') ?? '').startsWith('text/html'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // NEVER cache financial data. Not the response, not a fallback, nothing.
  if (url.pathname.startsWith('/api/')) return;

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // The HTML document: network-first. Offline, the cached shell still draws,
  // and its /api calls then fail into an error state — never a stale figure.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (cacheable(request, res)) {
            const copy = res.clone();
            event.waitUntil(
              caches
                .open(SHELL)
                .then((cache) => cache.put('/', copy))
                .catch(() => {}),
            );
          }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (
    !url.pathname.startsWith('/assets/') &&
    !['/manifest.webmanifest', '/icon.svg'].includes(url.pathname)
  )
    return;

  // Content-hashed assets and the other shell files: cache-first.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          if (cacheable(request, res)) {
            const copy = res.clone();
            event.waitUntil(
              caches
                .open(SHELL)
                .then((cache) => cache.put(request, copy))
                .catch(() => {}),
            );
          }
          return res;
        }),
    ),
  );
});
