const CACHE_NAME = 'qth-locator-v4';
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname.endsWith('/')
  ? SCOPE_URL.pathname
  : SCOPE_URL.pathname + '/';

function inScope(pathname) {
  return pathname.startsWith(SCOPE_PATH);
}

function scopeAsset(path) {
  return new URL(path, self.registration.scope).pathname;
}

const APP_SHELL = [
  scopeAsset('./'),
  scopeAsset('index.html'),
  scopeAsset('manifest.webmanifest'),
  scopeAsset('icons/compass.svg'),
  scopeAsset('icons/compass-192.png'),
  scopeAsset('icons/compass-512.png'),
  scopeAsset('vendor/qth-locator.js'),
  scopeAsset('icons/icon-192.png'),
  scopeAsset('icons/icon-512.png')
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (req.mode === 'navigate' && inScope(url.pathname)) {
    event.respondWith(
      fetch(req).catch(() => caches.match(scopeAsset('index.html')))
    );
    return;
  }

  if (!inScope(url.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const copy = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return networkRes;
      });
    })
  );
});
