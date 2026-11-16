/** Offline/install/update presentation, independent of microphone access. */
export interface PwaState {
  ready: boolean;
  message: string;
  network: string;
  install: string;
  canInstall: boolean;
  update: boolean;
  applying: boolean;
  updateMessage: string;
}
/** Session safety and UI boundaries used by the offline controller. */
export interface PwaOptions {
  safe: () => boolean;
  lock: (locked: boolean) => void;
  changed: (state: PwaState) => void;
}
/** Explicit user actions; refresh re-evaluates session-sensitive controls. */
export interface Pwa {
  /** Prompt installation if the browser supplied a deferred install event. */
  install(): Promise<void>;
  /** Consent to reload only if no unfinished attempt or other open tab exists. */
  applyUpdate(): Promise<void>;
  /** Refresh controls after session changes. */
  refresh(): void;
}
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
interface Reply { version?: string; ready?: boolean; ok?: boolean }
const REPLY_TIMEOUT_MS = 5000;
const BUILD = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'development';

function request(worker: ServiceWorker, type: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = globalThis.setTimeout(() => {
      channel.port1.close(); reject(new Error('Worker did not respond'));
    }, REPLY_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<Reply>) => {
      globalThis.clearTimeout(timer); channel.port1.close(); resolve(event.data);
    };
    worker.postMessage({ type }, [channel.port2]);
  });
}

/**
 * Register a production shell and expose explicit installation/update actions.
 * @param options Session safety checks, a temporary interaction lock, and UI notifications.
 * @returns Actions that never request microphone access or automatically reload.
 */
export function setupPwa(options: PwaOptions): Pwa {
  const state: PwaState = {
    ready: false, message: 'Preparing offline cache…', network: '',
    install: 'Install from the browser menu (Android Chrome: Add to Home screen).',
    canInstall: false, update: false, applying: false,
    updateMessage: '',
  };
  let registration: ServiceWorkerRegistration | undefined;
  let prompt: InstallEvent | undefined;
  let consent = false;
  let cacheFailure = false;
  const publish = (): void => {
    state.network = navigator.onLine === false ? 'Network: offline.' : 'Network: online (not a cache guarantee).';
    state.update = Boolean(registration?.waiting) && options.safe() && !state.applying;
    state.updateMessage = state.applying ? 'Applying update…'
      : registration?.waiting
        ? options.safe() ? 'Update waiting. Export your report, close other app windows, then apply.'
          : 'Update waiting. Finish this attempt (including paused attempts) and export before applying.'
        : 'No update waiting.';
    options.changed({ ...state });
  };
  const fail = (): void => {
    cacheFailure = true;
    state.ready = false;
    state.message = 'Offline caching or registration failed. Reconnect and reload to retry; offline use is not guaranteed.';
    publish();
  };
  const verify = async (): Promise<void> => {
    state.ready = false;
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      state.message = 'Caching app assets; waiting for a controlling worker.';
      publish(); return;
    }
    try {
      const reply = await request(controller, 'STATUS');
      // Recheck identity after awaiting: controller changes must not certify a stale reply.
      state.ready = controller === navigator.serviceWorker.controller && reply.ready === true && reply.version === BUILD;
      state.message = state.ready ? 'Offline ready: this version’s complete app shell is cached.'
        + (cacheFailure ? ' An update/cache operation failed; reconnect and reload when safe to retry.' : '')
        : 'Offline cache incomplete or a different version controls this page. Reconnect and reload when safe.';
      publish();
    } catch { fail(); }
  };
  const installed = (): void => {
    prompt = undefined; state.canInstall = false; state.install = 'Installed app window.'; publish();
  };
  const checkUpdate = (): void => {
    if (registration && navigator.onLine !== false) void registration.update().catch(fail);
  };
  const api: Pwa = {
    refresh: publish,
    async install() {
      if (!prompt) return;
      const event = prompt; prompt = undefined; state.canInstall = false; publish();
      try {
        await event.prompt();
        const choice = await event.userChoice;
        state.install = choice.outcome === 'accepted'
          ? 'Installation requested. Follow the browser confirmation.'
          : 'Installation dismissed. You can still install from the browser menu.';
        publish();
      } catch {
        state.install = 'Installation failed. Try Add to Home screen in the browser menu.'; publish();
      }
    },
    async applyUpdate() {
      const waiting = registration?.waiting;
      if (!waiting || !options.safe() || state.applying) return;
      // Lock before awaiting so a new attempt cannot start after consent was checked.
      consent = true; state.applying = true; options.lock(true); publish();
      try {
        const reply = await request(waiting, 'APPLY');
        if (!reply.ok) throw new Error('Other windows are open');
        state.message = 'Applying update; reloading after activation…'; publish();
        const activated = (): void => {
          if (waiting.state === 'activated' && consent) window.location.reload();
          else if (waiting.state === 'redundant') unlock('Update failed. Reconnect and retry.');
        };
        waiting.addEventListener('statechange', activated);
        activated();
      } catch {
        unlock('Update deferred. Close all other app tabs/windows, then try again. Your report remains here.');
      }
    },
  };
  const unlock = (message: string): void => {
    consent = false; state.applying = false; state.message = message; options.lock(false); publish();
  };
  if (!('serviceWorker' in navigator)) {
    state.message = 'Offline installation is not supported in this browser (or requires HTTPS).'; publish(); return api;
  }
  if (!globalThis.isSecureContext) {
    state.message = 'Offline installation requires HTTPS or localhost. This origin is not secure.'; publish(); return api;
  }
  if (import.meta.env.DEV) {
    state.message = 'Offline caching is disabled on the development server. Test a production build.'; publish(); return api;
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); prompt = event as InstallEvent; state.canInstall = true;
    state.install = 'Install this app for a standalone window. Microphone permission is separate.'; publish();
  });
  window.addEventListener('appinstalled', installed);
  if (window.matchMedia?.('(display-mode: standalone)').matches) installed();
  navigator.serviceWorker.addEventListener('controllerchange', () => { void verify(); });
  window.addEventListener('online', () => { publish(); void verify(); checkUpdate(); });
  window.addEventListener('offline', () => { publish(); void verify(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { void verify(); checkUpdate(); }
  });
  publish();
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL, updateViaCache: 'none',
  }).then((value) => {
    registration = value;
    const watch = (): void => {
      const worker = registration?.installing;
      if (!worker) return;
      cacheFailure = false;
      state.message = 'Caching all app assets…'; publish();
      worker.addEventListener('statechange', () => {
        if (worker.state === 'redundant') fail();
        else if (worker.state === 'installed') { void verify(); publish(); }
      });
    };
    value.addEventListener('updatefound', watch); watch();
    void verify(); publish();
  }).catch(fail);
  return api;
}
