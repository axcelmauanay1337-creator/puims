/*
 * PUIMS app-shell service worker (Milestones 1 and 7).
 *
 * CACHES ONLY PHI-FREE STATIC ASSETS:
 *   - /offline.html (static notice page, no data)
 *   - icons and the web manifest
 *   - hashed, immutable build assets under /_next/static/
 *
 * NEVER CACHES: HTML pages, /api/* responses, RSC payloads, or any other
 * response that may contain patient data. Navigations go to the network; if
 * the network fails, the static offline notice is shown. Offline clinical
 * data and the sync queue live encrypted in IndexedDB, NOT in this cache.
 */
const VERSION = "puims-shell-v2";
// The offline capture page and its script/style are static and PHI-free; patient data reaches that page
// only via the encrypted IndexedDB snapshot (Milestone 7), never through this cache.
const PRECACHE = [
  "/offline.html",
  "/offline-capture.html",
  "/offline/capture.js",
  "/offline/capture.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.webmanifest",
];
const NETWORK_FIRST = ["/offline-capture.html", "/offline/capture.js", "/offline/capture.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Offline capture page + assets: network first (fresh code when online), cached copy when offline.
  if (NETWORK_FIRST.includes(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(() => caches.match(url.pathname)),
    );
    return;
  }

  // Page navigations: network only; static notice on failure. Never cached.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }

  // Immutable hashed build assets: cache-first (contain no patient data).
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Precached static files.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
  // Everything else (APIs, RSC payloads): default network behaviour, not cached.
});
