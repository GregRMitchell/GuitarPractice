/**
 * Register an isolated static-shell worker. Dependencies are injectable for worker tests.
 * @param {ServiceWorkerGlobalScope} scope Worker realm.
 * @param {CacheStorage} storage Scope-local versioned shell storage.
 * @param {typeof fetch} fetcher Network boundary.
 * @param {{version: string, assets: string[], integrity?: Record<string, string>}} build Generated complete build graph.
 * @returns {void}
 */
export function offlineRuntime(scope, storage, fetcher, build) {
  const root = scope.registration.scope;
  const prefix = `guitar-offline:${root}:`;
  const cacheName = prefix + build.version;
  const assets = build.assets.map((asset) => new URL(asset, root).href);
  const shell = new URL('index.html', root).href;
  const firstInstall = !scope.registration.active;
  const inScope = (url) => url.origin === new URL(root).origin && url.href.startsWith(root);
  const complete = async () => {
    const cache = await storage.open(cacheName);
    return (await Promise.all(assets.map((url) => cache.match(url)))).every(Boolean);
  };
  scope.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      try {
        const responses = await Promise.all(assets.map(async (url, index) => {
          const response = await fetcher(new Request(url, {
            cache: 'reload', credentials: 'same-origin',
            integrity: build.integrity?.[build.assets[index]] ?? '',
          }));
          if (!response.ok || response.redirected) throw new Error('Shell download failed');
          const type = response.headers.get('content-type') ?? '';
          const expected = url.endsWith('.html') ? 'text/html'
            : url.endsWith('.css') ? 'text/css'
              : url.endsWith('.png') ? 'image/png'
                : url.endsWith('.webmanifest') ? 'application/manifest+json' : undefined;
          if ((expected && !type.includes(expected))
            || (url.endsWith('.js') && !/(java|ecma)script/.test(type))) {
            throw new Error('Invalid runtime asset type');
          }
          // Consume now: Chromium limits concurrent installation fetches until bodies drain.
          return new Response(await response.arrayBuffer(), {
            status: response.status, statusText: response.statusText, headers: response.headers,
          });
        }));
        const cache = await storage.open(cacheName);
        await Promise.all(assets.map((url, index) => cache.put(url, responses[index])));
        if (!await complete()) throw new Error('Incomplete shell cache');
      } catch (error) {
        await storage.delete(cacheName);
        throw error;
      }
    })());
  });
  const windows = async () => (await scope.clients.matchAll({
    type: 'window', includeUncontrolled: true,
  })).filter((client) => inScope(new URL(client.url)));
  scope.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const keys = (await storage.keys()).filter((key) => key.startsWith(prefix));
      // Never remove a graph while any window may still reference its hashed chunks.
      if ((await windows()).length === 0) {
        await Promise.all(keys.filter((key) => key !== cacheName).map((key) => storage.delete(key)));
      }
      // Only a first installation claims existing pages. Updates never force a tab reload.
      if (firstInstall) await scope.clients.claim();
    })());
  });
  scope.addEventListener('message', (event) => {
    const port = event.ports?.[0];
    if (!port) return;
    event.waitUntil((async () => {
      if (event.data?.type === 'STATUS') {
        port.postMessage({ version: build.version, ready: await complete() });
      } else if (event.data?.type === 'APPLY') {
        const cached = await complete();
        const pages = await windows();
        const ok = cached && pages.length === 1 && pages[0].id === event.source?.id;
        port.postMessage({ ok });
        if (ok) await scope.skipWaiting();
      }
    })());
  });
  scope.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || !inScope(url)) return;
    if (request.mode === 'navigate') {
      // Intact graphs stay version-pinned; eviction permits uncached online recovery.
      event.respondWith(storage.open(cacheName).then(async (cache) => {
        const response = await cache.match(shell);
        if (!await complete()) {
          try {
            const online = await fetcher(new Request(shell, { cache: 'no-store', credentials: 'same-origin' }));
            if (online.ok && !online.redirected && online.headers.get('content-type')?.includes('text/html')) {
              return online;
            }
          } catch { /* The remaining cached shell may still explain incomplete offline support. */ }
        }
        if (!response) throw new Error('Offline shell unavailable');
        return response;
      }));
    } else if (assets.includes(url.href) || url.pathname.startsWith(new URL('assets/', root).pathname)) {
      event.respondWith((async () => {
        const keys = await storage.keys();
        for (const key of [cacheName, ...keys.filter((name) => name.startsWith(prefix) && name !== cacheName)]) {
          const response = await (await storage.open(key)).match(url.href);
          if (response) return response;
        }
        const response = await fetcher(request);
        if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
          throw new Error('Runtime asset unavailable');
        }
        return response;
      })());
    }
  });
}
