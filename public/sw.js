const CACHE = 'vault-shell-a2-v2';

async function cacheDocumentShell(cache, root) {
  const response = await fetch(root, { cache: 'reload' });
  if (!response.ok) throw new Error('Could not fetch Vault shell.');
  await cache.put(root, response.clone());
  const html = await response.text();
  const urls = new Set([root]);
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/giu)) {
    try {
      const url = new URL(match[1], root);
      if (url.origin === self.location.origin) urls.add(url.href);
    } catch {
      // Ignore malformed/non-network references.
    }
  }
  await Promise.all([...urls].filter(url => url !== root).map(url => cache.add(url)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const root = new URL('./', self.registration.scope).href;
    await cacheDocumentShell(cache, root);
    await Promise.allSettled([
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
    const results = await Promise.allSettled(urls.map(url => cache.add(url)));
    const failed = results.filter(result => result.status === 'rejected').length;
    event.ports?.[0]?.postMessage({ type: 'CACHE_URLS_DONE', failed });
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
        if (response.ok) await (await caches.open(CACHE)).put(event.request, response.clone());
        return response;
      } catch {
        const cached = await caches.match(event.request)
          ?? await caches.match(new URL('./', self.registration.scope).href);
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
