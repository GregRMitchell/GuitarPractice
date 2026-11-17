import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { checkHistory } from './browser-history.mjs';
import { checkModes } from './browser-modes.mjs';
import { checkProgressions } from './browser-progressions.mjs';

// Optional real-browser verification using an existing Edge installation, with no dependencies.
const directory = resolve('.offline-check');
const edge = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let buildDirectory = 'root-a';
let offline = false;
let failAsset = false;
let browser;
const sockets = [];
const servers = [];
const requests = [];
const server = createServer(async (request, response) => {
  requests.push(request.url);
  if (offline) { response.writeHead(503).end('offline test: origin unavailable'); return; }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const nested = pathname.startsWith('/lab/');
  const name = decodeURIComponent(nested ? pathname.slice(5) : pathname.slice(1)) || 'index.html';
  const root = resolve(directory, nested ? 'nested' : buildDirectory);
  const file = resolve(root, name);
  if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  if (failAsset && name.includes('analysis.worker')) {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('/* intentionally corrupt runtime */');
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store' }).end(data);
  } catch { console.error('Missing browser fixture:', file); response.writeHead(404).end('not found'); }
});
servers.push(server);

/** Build a production graph at a specified base and isolated output. */
function build(name, base) {
  const result = spawnSync(process.execPath, ['node_modules\\vite\\bin\\vite.js', 'build',
    '--base', base, '--outDir', `.offline-check\\${name}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

/** Wait for a verifiable condition or fail with its most recent error. */
async function until(check, label) {
  let latest;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { const result = await check(); if (result) return result; } catch (error) { latest = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`, { cause: latest });
}

/** Connect a minimal Chrome DevTools Protocol client to one target. */
async function connect(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId); reject(new Error(`DevTools timed out: ${method} ${params.expression ?? ''}`));
    }, 20000);
    pending.set(requestId, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(String(data));
    if (!value.id) return;
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if (value.error) waiter.reject(new Error(JSON.stringify(value.error)));
    else waiter.resolve(value.result);
  });
  return {
    send: command,
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
  };
}

try {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await mkdir(directory, { recursive: true });
  build('root-a', '/'); build('root-b', '/'); build('nested', '/lab/');
  for (const name of ['root-a', 'root-b', 'nested']) {
    const root = resolve(directory, name);
    const source = await readFile(resolve(root, 'sw.js'), 'utf8');
    const graph = JSON.parse(source.match(/,(\{"version":.*\})\);\n$/)[1]);
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== 'sw.js')
      .map((entry) => resolve(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/')).sort();
    assert.deepEqual(graph.assets, files, `${name}: precache must equal every runtime output`);
  }
  console.log('PASS generated graphs: both root versions and nested base include every runtime output');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(edge, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${resolve(directory, 'profile')}`, 'about:blank'],
  { stdio: 'ignore' });
  const debugPort = await until(async () =>
    (await readFile(resolve(directory, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'browser debug port');
  const debug = `http://127.0.0.1:${debugPort}`;
  const newTab = async (url) => {
    const target = await (await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' })).json();
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });
    return { client, id: target.id };
  };
  const { client: page } = await newTab(origin);
  const ready = async (client) => {
    try {
      await until(() => client.evaluate(
        `document.getElementById('offline-status')?.textContent.includes('Offline ready')`), 'offline readiness');
    } catch (error) {
      console.error(await client.evaluate(`(async () => ({
        url: location.href, status: document.getElementById('offline-status')?.textContent,
        controller: navigator.serviceWorker?.controller?.scriptURL,
        caches: await caches.keys(), html: document.body.innerText.slice(0, 800),
        workers: (await navigator.serviceWorker.getRegistrations()).map(reg => ({
          active:reg.active?.state, waiting:reg.waiting?.state, installing:reg.installing?.state
        }))
      }))()`));
      throw error;
    }
  };
  await ready(page);
  const checkPracticeScreen = async (width, height) => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 600,
    });
    const layout = await page.evaluate(`(() => {
      const start = document.getElementById('start');
      const advanced = document.getElementById('advanced');
      const diagrams = [...document.querySelectorAll('.chord-diagram')];
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        startVisible: start.getBoundingClientRect().bottom < innerHeight && !start.disabled,
        title: document.title, advancedOpen: advanced.open,
        diagrams: diagrams.map(svg => svg.getAttribute('aria-label')),
        installationLast: document.getElementById('offline-title').closest('footer') === document.querySelector('main').lastElementChild,
        duplicateIds: [...document.querySelectorAll('[id]')].map(node => node.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index),
      };
    })()`);
    assert.equal(layout.overflow, false, `${width}px has no horizontal overflow`);
    assert.equal(layout.startVisible, true, `${width}px Start is immediately usable`);
    assert.equal(layout.advancedOpen, false);
    assert.equal(layout.installationLast, true);
    assert.deepEqual(layout.duplicateIds, []);
    assert.match(layout.title, /Chord Play/);
    assert.equal(layout.diagrams.length, 2);
    assert.match(layout.diagrams[0], /A chord.*low E muted.*A open.*high E open/);
    if (process.env.PRACTICE_SCREENSHOTS) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(resolve(process.env.PRACTICE_SCREENSHOTS, `practice-${width}.png`),
        Buffer.from(screenshot.data, 'base64'));
    }
  };
  await checkPracticeScreen(1280, 960);
  await checkPracticeScreen(390, 844);
  await checkPracticeScreen(320, 740);
  await page.evaluate(`document.getElementById('first').value = 'G';
    document.getElementById('first').dispatchEvent(new Event('change'));`);
  assert.match(await page.evaluate(`document.querySelector('#current-diagram svg').getAttribute('aria-label')`),
    /G chord.*low E fret 3.*B open.*high E fret 3/);
  for (const [chord, description, x1, y] of [
    ['F', /barre fret 1 from low E to high E/, '25', '43'],
    ['Bm', /barre fret 2 from A to high E/, '47', '69'],
  ]) {
    const diagram = await page.evaluate(`(() => {
      const first = document.getElementById('first');
      first.value = '${chord}'; first.dispatchEvent(new Event('change'));
      const svg = document.querySelector('#current-diagram svg');
      const barre = svg.querySelector('.barre');
      return { label: svg.getAttribute('aria-label'), x1: barre?.getAttribute('x1'),
        x2: barre?.getAttribute('x2'), y: barre?.getAttribute('y1'),
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert.match(diagram.label, description);
    assert.deepEqual([diagram.x1, diagram.x2, diagram.y, diagram.overflow], [x1, '135', y, false]);
  }
  await page.evaluate(`document.getElementById('first').value = 'A';
    document.getElementById('first').dispatchEvent(new Event('change'));
    document.getElementById('advanced').open = true;`);
  assert.equal(await page.evaluate(`document.getElementById('mode').getBoundingClientRect().height >= 44`), true);
  await page.evaluate(`document.getElementById('advanced').open = false;`);
  console.log('PASS practice screens: desktop / 390px / 320px, accessible diagrams, immediate Start, collapsed Advanced, installation last');
  const manifest = await page.send('Page.getAppManifest');
  assert.equal(manifest.errors.length, 0);
  const data = JSON.parse(manifest.data);
  assert.equal(data.display, 'standalone');
  assert.equal(data.start_url, '/');
  assert.equal(data.scope, '/');
  const installability = await page.send('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, []);
  console.log('PASS root: first install controls page, complete cache verified, manifest installable');

  const checkOffline = async () => {
    const assets = await page.evaluate(`(async () => {
      const currentScript = document.querySelector('script[type=module]').src;
      for (const key of await caches.keys()) {
        if (!key.startsWith('guitar-offline:')) continue;
        const cache = await caches.open(key);
        if (await cache.match(currentScript)) return (await cache.keys()).map(request => request.url);
      }
      throw new Error('Current graph missing');
    })()`);
    assert(assets.some((url) => url.includes('analysis.worker')));
    assert(assets.some((url) => url.includes('capture.worklet')));
    assert(assets.some((url) => url.includes('onset.worklet')));
    assert(assets.some((url) => url.endsWith('.css')));
    assert(assets.some((url) => url.endsWith('manifest.webmanifest')));
    assert(assets.filter((url) => url.includes('/icons/')).length === 2);
    offline = true;
    await page.evaluate(`globalThis.offlineNavigationToken = 'old document'`);
    await page.send('Page.reload');
    await until(() => page.evaluate(`globalThis.offlineNavigationToken === undefined`), 'offline navigation committed');
    await ready(page);
    assert.equal(await page.evaluate(`(async () => {
      const assets = ${JSON.stringify(assets)};
      for (const url of assets) { if (!(await fetch(url)).ok) return false; }
      const workerUrl = assets.find(url => url.includes('analysis.worker'));
      await new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl, {type:'module'});
        worker.onmessage = event => { worker.terminate(); event.data.type === 'ready' ? resolve() : reject(); };
        worker.onerror = reject;
      });
      const context = new AudioContext();
      await context.audioWorklet.addModule(assets.find(url => url.includes('capture.worklet')));
      await context.audioWorklet.addModule(assets.find(url => url.includes('onset.worklet')));
      await context.close();
      try { await fetch('/assets/missing.js'); return false; } catch {}
      return true;
    })()`), true);
    console.log('PASS offline: reload + every runtime asset + analysis Worker + AudioWorklet; missing JS rejects');
    offline = false;
  };
  // Keep capture startup unresolved: tests session safety without requesting real microphone access.
  await page.send('Page.bringToFront');
  await page.evaluate(`navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    document.getElementById('start').click();`);
  assert.match(await page.evaluate(`document.getElementById('status').textContent`), /Requesting/);
  buildDirectory = 'root-b';
  await page.evaluate(`globalThis.updateOutcome = 'pending'; void navigator.serviceWorker.getRegistration()
    .then(registration => registration.update())
    .then(() => globalThis.updateOutcome = 'updated', error => globalThis.updateOutcome = error.message)`);
  try {
    await until(() => page.evaluate(`navigator.serviceWorker.getRegistration().then(registration => !!registration.waiting)`), 'waiting update');
  } catch (error) {
    console.error(requests);
    console.error(await page.evaluate(`navigator.serviceWorker.getRegistration().then(r => ({
      active:r.active?.state, waiting:r.waiting?.state, installing:r.installing?.state,
      pwa:document.getElementById('offline-status').textContent,
      outcome:globalThis.updateOutcome, ready:document.readyState, online:navigator.onLine
    }))`));
    throw error;
  }
  assert.equal(await page.evaluate(`document.getElementById('apply-update').disabled`), true);
  const oldScript = await page.evaluate(`document.querySelector('script[type=module]').src`);
  const { client: other, id: otherId } = await newTab(origin);
  await ready(other);
  await other.evaluate(`navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    document.getElementById('start').click();`);
  await page.evaluate(`document.getElementById('finish').click(); document.getElementById('apply-update').click()`);
  await until(() => page.evaluate(`document.getElementById('offline-status').textContent.includes('Update deferred')`), 'cross-tab deferral');
  assert.equal(await page.evaluate(`document.querySelector('script[type=module]').src`), oldScript);
  assert.match(await other.evaluate(`document.getElementById('status').textContent`), /Requesting|Paused/);
  await fetch(`${debug}/json/close/${otherId}`);
  await until(() => page.evaluate(`navigator.serviceWorker.getRegistration().then(async () =>
    document.getElementById('apply-update').disabled === false)`), 'retry enabled');
  try {
    await until(async () => {
      await page.evaluate(`document.getElementById('apply-update')?.click()`);
      return (await page.evaluate(`document.querySelector('script[type=module]')?.src`)) !== oldScript;
    }, 'explicit update reload');
  } catch (error) {
    console.error(await page.evaluate(`navigator.serviceWorker.getRegistration().then(r => ({
      pwa:document.getElementById('offline-status')?.textContent,
      phase:document.getElementById('status')?.textContent,
      button:document.getElementById('apply-update')?.disabled,
      active:r.active?.state, waiting:r.waiting?.state
    }))`));
    throw error;
  }
  await ready(page);
  console.log('PASS updates: wait during startup, active other tab defers, sole finished tab explicitly applies/reloads');
  await checkOffline();
  const historyServer = createServer(server.listeners('request')[0]);
  servers.push(historyServer);
  await new Promise((resolve) => historyServer.listen(0, '127.0.0.1', resolve));
  const historyId = await checkHistory({
    page, otherOrigin: `http://127.0.0.1:${historyServer.address().port}`, newTab, until, directory,
  });
  await fetch(`${debug}/json/close/${historyId}`);
  offline = true;
  await page.send('Page.reload');
  await until(() => page.evaluate(`document.getElementById('history-total-rounds')?.textContent === '27'`),
    'offline history hash reload with persisted data');
  await ready(page);
  assert.equal(await page.evaluate(`(() => {
    globalThis.historyNavigationIdentity = {};
    const identity = globalThis.historyNavigationIdentity;
    document.getElementById('nav-practice').click();
    document.getElementById('nav-history').click();
    return location.hash === '#history' && globalThis.historyNavigationIdentity === identity
      && !document.getElementById('history-page').hidden;
  })()`), true);
  offline = false;
  console.log('PASS history offline: hash reload retains IndexedDB records; both nav actions stay within the same cached page');
  const modesServer = createServer(server.listeners('request')[0]);
  servers.push(modesServer);
  await new Promise((resolve) => modesServer.listen(0, '127.0.0.1', resolve));
  const modesId = await checkModes({
    page, otherOrigin: `http://127.0.0.1:${modesServer.address().port}`, newTab, until,
  });
  await fetch(`${debug}/json/close/${modesId}`);
  const progressionServer = createServer(server.listeners('request')[0]);
  servers.push(progressionServer);
  await new Promise((resolve) => progressionServer.listen(0, '127.0.0.1', resolve));
  const progressionId = await checkProgressions({
    page, otherOrigin: `http://127.0.0.1:${progressionServer.address().port}`, newTab, until,
  });
  await fetch(`${debug}/json/close/${progressionId}`);

  // A root worker intentionally owns all root-scope navigation, so use a separate origin.
  const nestedServer = createServer(server.listeners('request')[0]);
  servers.push(nestedServer);
  await new Promise((resolve) => nestedServer.listen(0, '127.0.0.1', resolve));
  const nestedOrigin = `http://127.0.0.1:${nestedServer.address().port}`;
  const { client: nested } = await newTab(`${nestedOrigin}/lab/`);
  await ready(nested);
  const nestedManifest = JSON.parse((await nested.send('Page.getAppManifest')).data);
  assert.equal(nestedManifest.start_url, '/lab/');
  assert.equal(nestedManifest.scope, '/lab/');
  assert(nestedManifest.icons.every((icon) => icon.src.startsWith('/lab/icons/')));
  offline = true;
  await nested.send('Page.navigate', { url: `${nestedOrigin}/lab/offline-route` });
  await until(() => nested.evaluate(`location.pathname === '/lab/offline-route'`), 'nested navigation committed');
  await ready(nested);
  assert.equal(await nested.evaluate(`navigator.serviceWorker.controller.scriptURL`), `${nestedOrigin}/lab/sw.js`);
  console.log('PASS nested base: scoped manifest/controller and offline deep navigation');
  offline = false;
  failAsset = true;
  const failedServer = createServer(server.listeners('request')[0]);
  servers.push(failedServer);
  await new Promise((resolve) => failedServer.listen(0, '127.0.0.1', resolve));
  const failedOrigin = `http://127.0.0.1:${failedServer.address().port}`;
  const { client: failed } = await newTab(`${failedOrigin}/lab/`);
  await until(() => failed.evaluate(`document.getElementById('offline-status')?.textContent.includes('failed')`), 'install failure');
  assert(!await failed.evaluate(`document.getElementById('offline-status').textContent.includes('Offline ready')`));
  assert.deepEqual(await failed.evaluate(`caches.keys()`), []);
  console.log('PASS real cache install failure: visible failure and no false readiness');
} finally {
  for (const socket of sockets) socket.close();
  if (browser) {
    browser.kill();
    await new Promise((resolve) => browser.once('exit', resolve));
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
