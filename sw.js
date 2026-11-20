/*
  NEVO-TASK PWA SERVICE WORKER
  Strategy: Network-First for HTML/JS/CSS (always fresh code after deploy), Cache fallback when offline.
*/

const CACHE_NAME = 'nevo-task-pwa-v3.1';
const CORE_ASSETS = [
  './index.html',
  './login.html',
  './products.html',
  './model.html',
  './support.html',
  './index.css',
  './app-config.js',
  './security-utils.js',
  './firebase-service.js',
  './auth-service.js',
  './ui-service.js',
  './main.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      })
      .catch(() => caches.match(req))
  );
});
