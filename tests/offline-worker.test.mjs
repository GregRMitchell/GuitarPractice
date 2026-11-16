import { expect, test, vi } from 'vitest';
import { offlineRuntime } from '../build/offline-runtime.mjs';

function harness({ fail = false, clients = [], active = null, htmlAsset = false } = {}) {
  const stores = new Map();
  const handlers = {};
  const scope = {
    registration: { scope: 'https://local.test/lab/', active },
    location: { origin: 'https://local.test' },
    clients: { matchAll: async () => clients, claim: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener: (name, handler) => { handlers[name] = handler; },
  };
  const cacheStorage = {
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        put: async (url, response) => store.set(String(url), response.clone()),
        match: async (url) => store.get(String(url))?.clone(),
      };
    },
  };
  const fetcher = vi.fn(async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    if (fail || url.endsWith('missing.js')) throw new Error('offline');
    const html = url.endsWith('.html') || htmlAsset;
    return new Response(html ? '<html>shell</html>' : 'asset', {
      headers: { 'Content-Type': html ? 'text/html' : 'text/javascript' },
    });
  });
  offlineRuntime(scope, cacheStorage, fetcher, {
    version: 'v1', assets: ['index.html', 'assets/main.js', 'assets/worklet.js', 'assets/analysis.js'],
  });
  return {
    scope, stores, fetcher,
    async event(name, extra = {}) {
      let done = Promise.resolve();
      handlers[name]({ ...extra, waitUntil: (promise) => { done = promise; } });
      await done;
    },
    async request(url, mode = 'cors') {
      let result;
      handlers.fetch({ request: { url, mode, method: 'GET' }, respondWith: (response) => { result = response; } });
      return result;
    },
  };
}

test('precache failure is atomic and cannot answer ready', async () => {
  const h = harness({ fail: true });
  await expect(h.event('install')).rejects.toThrow();
  expect(h.stores.size).toBe(0);
});

test('a failed upgrade preserves old graphs, and HTML masquerading as JS cannot be installed', async () => {
  for (const options of [{ fail: true }, { htmlAsset: true }]) {
    const h = harness(options);
    h.stores.set('guitar-offline:https://local.test/lab/:old', new Map());
    await expect(h.event('install')).rejects.toThrow();
    expect([...h.stores.keys()]).toEqual(['guitar-offline:https://local.test/lab/:old']);
  }
});

test('all graph assets and scoped navigation work offline; missing JS is not HTML', async () => {
  const h = harness();
  await h.event('install');
  h.fetcher.mockRejectedValue(new Error('offline'));
  expect(await (await h.request('https://local.test/lab/deep', 'navigate')).text()).toContain('shell');
  for (const asset of ['main', 'worklet', 'analysis']) {
    expect(await (await h.request(`https://local.test/lab/assets/${asset}.js`)).text()).toBe('asset');
  }
  await expect(h.request('https://local.test/lab/assets/missing.js')).rejects.toThrow('offline');
  expect(await h.request('https://other.test/lab/assets/main.js')).toBeUndefined();
  expect(await h.request('https://local.test/elsewhere', 'navigate')).toBeUndefined();
  expect(await h.request('blob:https://local.test/report')).toBeUndefined();
});

test('cross-tab activation is refused and live-client activation never deletes old graphs', async () => {
  const replies = [];
  const h = harness({ clients: [{ id: 'one', url: 'https://local.test/lab/' }, { id: 'two', url: 'https://local.test/lab/' }] });
  await h.event('install');
  h.stores.set('guitar-offline:https://local.test/lab/:old', new Map());
  await h.event('message', { data: { type: 'APPLY' }, source: { id: 'one' }, ports: [{ postMessage: (value) => replies.push(value) }] });
  expect(h.scope.skipWaiting).not.toHaveBeenCalled();
  expect(replies.at(-1).ok).toBe(false);
  await h.event('activate');
  expect(h.stores.size).toBe(2);
});

test('install does not skip waiting; only the requesting sole window may explicitly activate', async () => {
  const h = harness({ clients: [{ id: 'one', url: 'https://local.test/lab/' }] });
  await h.event('install');
  expect(h.scope.skipWaiting).not.toHaveBeenCalled();
  const replies = [];
  const ports = [{ postMessage: (value) => replies.push(value) }];
  await h.event('message', { data: { type: 'APPLY' }, source: { id: 'foreign' }, ports });
  expect(replies.at(-1).ok).toBe(false);
  await h.event('message', { data: { type: 'APPLY' }, source: { id: 'one' }, ports });
  expect(replies.at(-1).ok).toBe(true);
  expect(h.scope.skipWaiting).toHaveBeenCalledOnce();
});

test('natural activation without windows removes only this scope’s old caches', async () => {
  const h = harness({ active: {} });
  await h.event('install');
  h.stores.set('guitar-offline:https://local.test/lab/:old', new Map());
  h.stores.set('guitar-offline:https://local.test/other/:v1', new Map());
  h.stores.set('unrelated-app', new Map());
  await h.event('activate');
  expect([...h.stores.keys()]).toEqual([
    'guitar-offline:https://local.test/lab/:v1',
    'guitar-offline:https://local.test/other/:v1',
    'unrelated-app',
  ]);
  expect(h.scope.clients.claim).not.toHaveBeenCalled();
});

test('readiness verifies every asset, including worklet; evicted entries revoke readiness', async () => {
  const h = harness();
  await h.event('install');
  const replies = [];
  const event = { data: { type: 'STATUS' }, ports: [{ postMessage: (value) => replies.push(value) }] };
  await h.event('message', event);
  expect(replies.at(-1)).toEqual({ version: 'v1', ready: true });
  [...h.stores.values()][0].delete('https://local.test/lab/assets/worklet.js');
  await h.event('message', event);
  expect(replies.at(-1).ready).toBe(false);
});

test('an evicted graph can recover online without caching unknown HTML as the old version', async () => {
  const h = harness();
  await h.event('install');
  [...h.stores.values()][0].delete('https://local.test/lab/assets/main.js');
  h.fetcher.mockResolvedValue(new Response('<html>new network build</html>', {
    headers: { 'Content-Type': 'text/html' },
  }));
  expect(await (await h.request('https://local.test/lab/', 'navigate')).text()).toContain('new network build');
  expect([...h.stores.values()][0].has('https://local.test/lab/assets/main.js')).toBe(false);
  h.fetcher.mockRejectedValue(new Error('offline'));
  expect(await (await h.request('https://local.test/lab/', 'navigate')).text()).toContain('shell');
});
