const CACHE = 'vault-shell-a2-v1';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const root = new URL('./', self.registration.scope).href;
    await Promise.allSettled([
      cache.add(root),
      cache.add(new URL('manifest.webmanifest', root).href),
      cache.add(new URL('icon.svg', root).href),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key.startsWith('vault-shell-')) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_URLS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = event.data.urls
      .filter(value => typeof value === 'string')
      .filter(value => {
        try { return new URL(value).origin === self.location.origin; } catch { return false; }
      });
    await Promise.allSettled(urls.map(url => cache.add(url)));
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
        return response;
      } catch {
        const cached = await caches.match(event.request) ?? await caches.match(new URL('./', self.registration.scope).href);
        return cached ?? new Response('Vault is offline and its application shell has not been cached yet.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) {
      event.waitUntil(fetch(event.request).then(async response => {
        if (response.ok) await (await caches.open(CACHE)).put(event.request, response.clone());
      }).catch(() => undefined));
      return cached;
    }
    const response = await fetch(event.request);
    if (response.ok) await (await caches.open(CACHE)).put(event.request, response.clone());
    return response;
  })());
});
