import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setupPwa, type PwaState } from '../src/pwa';

beforeEach(() => {
  vi.stubEnv('DEV', false);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('unsupported browsers explain offline unavailability without registering or capturing', async () => {
  vi.stubGlobal('navigator', {});
  const states: { message: string; ready: boolean }[] = [];
  setupPwa({ safe: () => true, lock: () => {}, changed: (state) => states.push(state) });
  expect(states.at(-1)?.ready).toBe(false);
  expect(states.at(-1)?.message).toMatch(/not supported/i);
});

test('registration failure is explicit and never reports offline readiness', async () => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', {
    serviceWorker: Object.assign(new EventTarget(), {
      register: vi.fn().mockRejectedValue(new Error('disk full')),
    }),
  });
  vi.stubGlobal('window', new EventTarget());
  const states: { message: string; ready: boolean }[] = [];
  setupPwa({ safe: () => true, lock: () => {}, changed: (state) => states.push(state) });
  await vi.waitFor(() => expect(states.at(-1)?.message).toMatch(/failed/i));
  expect(states.every((state) => !state.ready)).toBe(true);
});

function browser(options: { ready?: boolean; version?: string; controlled?: boolean; waiting?: boolean; apply?: boolean } = {}) {
  const states: PwaState[] = [];
  const messages: string[] = [];
  const worker = Object.assign(new EventTarget(), {
    state: 'installed',
    postMessage: (data: { type: string }, ports: MessagePort[]) => {
      messages.push(data.type);
      ports[0].postMessage(data.type === 'STATUS'
        ? { ready: options.ready ?? true, version: options.version ?? 'development' }
        : { ok: options.apply ?? true });
      ports[0].close();
    },
  });
  const registration = Object.assign(new EventTarget(), {
    waiting: options.waiting ? worker : null,
    installing: null,
    update: vi.fn(async () => {}),
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: options.controlled === false ? null : worker,
    register: vi.fn(async () => registration),
  });
  const reload = vi.fn();
  const window = Object.assign(new EventTarget(), { location: { reload } });
  vi.stubGlobal('navigator', { serviceWorker, onLine: true });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('window', window);
  let safe = true;
  const lock = vi.fn();
  const api = setupPwa({ safe: () => safe, lock, changed: (state) => states.push(state) });
  return {
    api, states, worker, serviceWorker, registration, reload, lock, messages, window,
    setSafe: (value: boolean) => { safe = value; api.refresh(); },
  };
}

test('only a controlling same-version worker with the entire cache can certify offline readiness', async () => {
  for (const options of [{ controlled: false }, { ready: false }, { version: 'different' }]) {
    const h = browser(options);
    await vi.waitFor(() => expect(h.serviceWorker.register).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.states.at(-1)?.ready).toBe(false);
  }
  const h = browser();
  await vi.waitFor(() => expect(h.states.at(-1)?.ready).toBe(true));
  expect(h.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
});

test('network loss does not revoke a genuinely complete controlled offline cache', async () => {
  const h = browser();
  await vi.waitFor(() => expect(h.states.at(-1)?.ready).toBe(true));
  Object.assign(navigator, { onLine: false });
  h.window.dispatchEvent(new Event('offline'));
  await vi.waitFor(() => expect(h.states.at(-1)?.ready).toBe(true));
  expect(h.states.at(-1)?.network).toBe('Network: offline.');
});

test('waiting updates never activate/reload without safe explicit consent; interaction stays locked until activation', async () => {
  const h = browser({ waiting: true });
  await vi.waitFor(() => expect(h.states.at(-1)?.update).toBe(true));
  expect(h.messages).not.toContain('APPLY');
  h.setSafe(false);
  await h.api.applyUpdate();
  expect(h.messages).not.toContain('APPLY');
  expect(h.states.at(-1)?.update).toBe(false);
  expect(h.reload).not.toHaveBeenCalled();
  h.setSafe(true);
  const applying = h.api.applyUpdate();
  expect(h.lock).toHaveBeenLastCalledWith(true);
  await applying;
  expect(h.messages).toContain('APPLY');
  expect(h.reload).not.toHaveBeenCalled();
  h.worker.state = 'activated'; h.worker.dispatchEvent(new Event('statechange'));
  expect(h.reload).toHaveBeenCalledOnce();
});

test('another open tab defers an update without reloading and unlocks the existing report', async () => {
  const h = browser({ waiting: true, apply: false });
  await vi.waitFor(() => expect(h.states.at(-1)?.update).toBe(true));
  await h.api.applyUpdate();
  expect(h.states.at(-1)?.message).toContain('Close all other');
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.lock.mock.calls).toEqual([[true], [false]]);
});

test('unsolicited controller activation during an unfinished attempt never reloads the page', async () => {
  const h = browser({ waiting: true });
  h.setSafe(false);
  h.serviceWorker.dispatchEvent(new Event('controllerchange'));
  await vi.waitFor(() => expect(h.states.at(-1)?.ready).toBe(true));
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.lock).not.toHaveBeenCalled();
});

test('install prompt is optional, user initiated, and replaced by installed status', async () => {
  const h = browser();
  const prompt = vi.fn(async () => {});
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt, userChoice: Promise.resolve({ outcome: 'accepted' }),
  });
  h.window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(h.states.at(-1)?.canInstall).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
  await h.api.install();
  expect(prompt).toHaveBeenCalledOnce();
  h.window.dispatchEvent(new Event('appinstalled'));
  expect(h.states.at(-1)?.canInstall).toBe(false);
  expect(h.states.at(-1)?.install).toContain('Installed');
});

test('a failed installing worker reports caching failure instead of claiming readiness', async () => {
  const h = browser({ controlled: false });
  await vi.waitFor(() => expect(h.serviceWorker.register).toHaveBeenCalledOnce());
  Object.assign(h.registration, { installing: h.worker });
  h.registration.dispatchEvent(new Event('updatefound'));
  h.worker.state = 'redundant';
  h.worker.dispatchEvent(new Event('statechange'));
  expect(h.states.at(-1)?.ready).toBe(false);
  expect(h.states.at(-1)?.message).toMatch(/failed/);
});

test('registration itself checks for updates without starting a competing update job', async () => {
  const h = browser({ controlled: false });
  await vi.waitFor(() => expect(h.serviceWorker.register).toHaveBeenCalledOnce());
  expect(h.registration.update).not.toHaveBeenCalled();
});
