import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CaptureHandlers } from '../src/audio/capture';
import type { CoachHandlers } from '../src/coach/controller';
import type { RhythmHandlers, RhythmSnapshot } from '../src/rhythm/controller';

const start = vi.hoisted(() => vi.fn());
const coachStart = vi.hoisted(() => vi.fn());
const rhythmStart = vi.hoisted(() => vi.fn());
vi.mock('../src/coach/controller', () => ({ startCoach: coachStart }));
vi.mock('../src/rhythm/controller', () => ({ startRhythm: rhythmStart }));
const historyOpen = vi.hoisted(() => vi.fn());
vi.mock('../src/history/store', () => ({ openHistoryStore: historyOpen }));
vi.mock('../src/audio/capture', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/audio/capture')>(), startCapture: start,
}));

class ScreenElement extends EventTarget {
  value = '';
  textContent = '';
  checked = false;
  disabled = false;
  hidden = false;
  href = '';
  download = '';
  readonly children: ScreenElement[] = [];
  clicked = false;
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  replaceChildren(...children: ScreenElement[]): void { this.children.splice(0, this.children.length, ...children); }
  append(child: ScreenElement): void { this.children.push(child); }
  remove(): void {}
  click(): void {
    if (this.disabled) return;
    this.clicked = true; this.dispatchEvent(new Event('click'));
  }
}

class ScreenDocument extends EventTarget {
  hidden = false;
  readonly body = new ScreenElement();
  readonly elements = new Map<string, ScreenElement>();
  getElementById(id: string): ScreenElement {
    let value = this.elements.get(id);
    if (!value) {
      value = new ScreenElement(); this.elements.set(id, value);
    }
    return value;
  }
  createElement(): ScreenElement { return new ScreenElement(); }
  createElementNS(): ScreenElement { return new ScreenElement(); }
}

let screen: ScreenDocument;
let callbacks: CaptureHandlers;
let now: number;
const stop = vi.fn(async (): Promise<void> => {});
const blobs: Blob[] = [];
const timers: (() => void)[] = [];
const ticks: (() => void)[] = [];
const revoke = vi.fn();
const get = (id: string): ScreenElement => screen.getElementById(id);

beforeEach(() => {
  vi.resetModules(); start.mockReset(); stop.mockClear(); revoke.mockClear();
  coachStart.mockReset(); rhythmStart.mockReset();
  blobs.length = 0; timers.length = 0; ticks.length = 0; now = 1000;
  screen = new ScreenDocument();
  get('independent').checked = true;
  get('mode').value = 'pair';
  vi.stubGlobal('document', screen);
  vi.stubGlobal('navigator', { userAgent: 'Chrome test boundary' });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const window = Object.assign(new EventTarget(), {
    location: { hash: '' },
    history: { replaceState: (_state: unknown, _unused: string, hash: string): void => {
      window.location.hash = hash;
    } },
    setInterval: (callback: () => void): number => ticks.push(callback),
    setTimeout: (callback: () => void): number => timers.push(callback),
  });
  vi.stubGlobal('window', window);
  historyOpen.mockReset().mockResolvedValue({
    list: async () => [], save: async () => {}, merge: async () => ({ added: 0, duplicates: 0 }),
    close: () => {},
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob): string => {
    if (!(blob instanceof Blob)) throw new Error('Expected report Blob');
    blobs.push(blob); return 'blob:local-report';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
  start.mockImplementation((_pair, handlers: CaptureHandlers) => {
    callbacks = handlers;
    handlers.onCalibration({ status: 'calibrating', remainingMs: 2000 });
    return Promise.resolve({ settings: { sampleRate: 44100 }, analysisSampleRate: 48000, stop });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('mode picker defaults to switches, coach keeps explicit string targets and saves only a finished minute', async () => {
  let coach!: CoachHandlers;
  const selectString = vi.fn();
  const selectOverall = vi.fn();
  coachStart.mockImplementation(async (_chord, handlers: CoachHandlers) => {
    coach = handlers;
    handlers.onCalibration({ status: 'calibrating', remainingMs: 2000 });
    return { settings: {}, analysisSampleRate: 48000, stop, selectString, selectOverall };
  });
  const save = vi.fn(async (_record: unknown) => {});
  historyOpen.mockResolvedValue({ list: async () => [], save, close: () => {} });
  await import('../src/main');
  expect(get('switch-practice').hidden).toBe(false);
  get('practice-coach').click();
  expect(get('switch-practice').hidden).toBe(true);
  expect(get('extra-chord').value).toBe('A');
  get('extra-chord').value = 'Am'; get('extra-chord').dispatchEvent(new Event('change'));
  get('extra-start').click();
  expect(coachStart).toHaveBeenCalledWith('Am', expect.anything());
  expect(get('extra-status').textContent).toMatch(/Calibrating/);
  expect(get('coach-quality').textContent).toMatch(/calibration/);
  expect(get('practice-rhythm').disabled).toBe(true);
  expect(get('nav-history').disabled).toBe(true);
  window.location.hash = '#history'; window.dispatchEvent(new Event('hashchange'));
  expect(window.location.hash).toBe('#practice');
  await Promise.resolve();
  coach.onCalibration({ status: 'ready', remainingMs: 0 });
  const target = { index: 1, name: 'A', fret: 0, midi: 45 };
  coach.onSnapshot({ chord: 'Am', mode: 'string', stringIndex: 1,
    targets: [target], assessment: { status: 'good', title: 'Pitch matches', tip: 'Keep it relaxed.', cents: 4 },
    overallConfirmations: 2, successfulStrings: [1] });
  expect(get('coach-target').textContent).toMatch(/A.*open.*A2.*alone/);
  expect(get('coach-tip').textContent).toMatch(/\+4 cents/);
  get('coach-strings').children[2].click();
  expect(selectString).toHaveBeenCalledWith(2);
  get('coach-overall').click();
  expect(selectOverall).toHaveBeenCalledOnce();
  now += 60_000; ticks.forEach((tick) => tick());
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0]).toMatchObject({ mode: 'coach', targetChord: 'Am',
    confirmations: 2, successfulStrings: [1], completed: true, activeMs: 60_000 });
  expect(stop).toHaveBeenCalledOnce();
});

test('guided rhythm is gesture-bound, defaults to no mic, validates headphones, and hidden discards', async () => {
  let rhythm!: RhythmHandlers;
  const snapshot: RhythmSnapshot = { phase: 'count-in', bpm: 80, patternId: 'quarters', audible: true, soundMode: 'beat',
    targetSeconds: 60, elapsedSeconds: 0, activeSlot: 0, beat: 1, bar: null, countInRemaining: 4,
    summary: { timingMeasured: false, expected: 0, estimatedStrums: null, matched: null,
      inTime: null, missed: null, extra: null, meanAbsoluteOffsetMs: null } };
  rhythmStart.mockImplementation(async (_config, handlers: RhythmHandlers) => {
    rhythm = handlers; handlers.onChanged(snapshot);
    return { snapshot, stop: async () => snapshot };
  });
  const module = await import('../src/pwa');
  const setup = vi.spyOn(module, 'setupPwa').mockReturnValue({
    refresh: vi.fn(), install: async () => {}, applyUpdate: async () => {},
  });
  await import('../src/main');
  get('practice-rhythm').click();
  expect(get('rhythm-bpm').value).toBe('80');
  expect(get('rhythm-sound').value).toBe('beat');
  get('rhythm-microphone').checked = true;
  get('extra-start').click();
  expect(get('extra-error').textContent).toMatch(/headphones/);
  expect(rhythmStart).not.toHaveBeenCalled();
  get('rhythm-microphone').checked = false;
  get('rhythm-sound').value = 'strums';
  get('extra-start').click();
  expect(rhythmStart).toHaveBeenCalledWith(expect.objectContaining({
    bpm: 80, microphone: false, audible: true, patternId: 'quarters', soundMode: 'strums',
  }), expect.anything());
  expect(start).not.toHaveBeenCalled();
  expect(get('rhythm-position').textContent).toMatch(/Count in: 4/);
  expect(get('rhythm-timing').textContent).toMatch(/timing not measured/);
  expect(setup.mock.calls[0][0].safe()).toBe(false);
  await Promise.resolve();
  rhythm.onChanged({ ...snapshot, phase: 'playing', elapsedSeconds: 12, bar: 2 });
  rhythm.onChanged({ ...snapshot, phase: 'finalizing', elapsedSeconds: 60 });
  expect(get('extra-status').textContent).toMatch(/Finishing timing/);
  expect(get('extra-finish').disabled).toBe(true);
  expect(setup.mock.calls[0][0].safe()).toBe(false);
  screen.hidden = true; screen.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(get('extra-status').textContent).toMatch(/discarded/));
  expect(get('history-save').textContent).toBe('');
  expect(setup.mock.calls[0][0].safe()).toBe(true);
});

test('browsers without service workers remain usable without starting the microphone', async () => {
  await import('../src/main');
  expect(get('offline-status').textContent).toMatch(/not supported/);
  expect(get('install-app').disabled).toBe(true);
  expect(get('apply-update').disabled).toBe(true);
  expect(get('start').disabled).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test('update safety spans every unfinished phase and the update lock prevents a new attempt', async () => {
  get('diagnostics').checked = true;
  const module = await import('../src/pwa');
  const setup = vi.spyOn(module, 'setupPwa').mockReturnValue({
    refresh: vi.fn(), install: async () => {}, applyUpdate: async () => {},
  });
  start.mockImplementation((_pair, handlers: CaptureHandlers) => {
    callbacks = handlers;
    return Promise.resolve({ settings: {}, analysisSampleRate: 48000, stop });
  });
  await import('../src/main');
  const options = setup.mock.calls[0][0];
  expect(options.safe()).toBe(true);
  options.lock(true);
  get('start').click();
  expect(start).not.toHaveBeenCalled();
  options.lock(false);
  get('start').click();
  expect(get('status').textContent).toContain('Requesting');
  expect(options.safe()).toBe(false);
  callbacks.onCalibration({ status: 'calibrating', remainingMs: 2000 });
  expect(options.safe()).toBe(false);
  callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
  await Promise.resolve();
  expect(options.safe()).toBe(false);
  get('confirm-first').click();
  expect(get('status').textContent).toContain('running');
  expect(options.safe()).toBe(false);
  get('pause').click();
  expect(get('status').textContent).toContain('discarded');
  expect(options.safe()).toBe(false);
  get('finish').click();
  expect(options.safe()).toBe(true);
  options.lock(true);
  expect(get('start').disabled).toBe(true);
});

test('trusted start, independent labeling, finish and explicit report download are wired end to end', async () => {
  get('diagnostics').checked = true;
  await import('../src/main');
  get('start').click();
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0][0]).toEqual(['A', 'D']);
  expect(get('configuration').disabled).toBe(true);
  expect(get('status').textContent).toContain('Calibrating');
  get('confirm-first').click();
  callbacks.onCalibration({ status: 'ready', remainingMs: 0, noiseFloorRms: 0.001 });
  await Promise.resolve();
  expect(blobs).toHaveLength(0);
  get('confirm-first').click();
  expect(get('prediction').textContent).toContain('hidden');
  now = 2000;
  get('confirm-second').click();
  expect(get('count').textContent).toBe('1');
  now = 3000;
  get('finish').click();
  expect(stop).toHaveBeenCalledOnce();
  expect(blobs).toHaveLength(0);
  get('device').value = 'Android test device';
  get('reviewed').checked = true;
  get('reviewed').dispatchEvent(new Event('change'));
  get('export').click();
  expect(blobs).toHaveLength(1);
  const report = JSON.parse(await blobs[0].text());
  expect(report.references).toEqual([{ chord: 'A', atMs: 0 }, { chord: 'D', atMs: 1000 }]);
  expect(report.rawResults).toMatchObject({ misses: 1, passed: false });
  expect(report.results).toBeNull();
  expect(report.analysisSampleRate).toBe(48000);
  expect(report.settings.sampleRate).toBe(44100);
  expect(screen.body.children.at(-1)?.clicked).toBe(true);
  expect(screen.body.children.at(-1)?.download).toMatch(/^chord-validation-v2-/);
  timers.forEach((callback) => callback());
  expect(revoke).toHaveBeenCalledWith('blob:local-report');
});

test('editing independent-reference timing clears its attestation', async () => {
  get('diagnostics').checked = true;
  await import('../src/main');
  get('start').click();
  callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
  await Promise.resolve();
  get('confirm-first').click();
  now = 2000;
  get('confirm-second').click();
  now = 3000;
  get('finish').click();

  get('reference-times').value = '0\n900';
  get('reference-evidence').value = 'Independent timecoded event log';
  get('reference-attested').checked = true;
  get('reference-attested').dispatchEvent(new Event('change'));
  expect(get('reference-attested').checked).toBe(true);

  get('reference-times').value = '0\n850';
  get('reference-times').dispatchEvent(new Event('input'));
  expect(get('reference-attested').checked).toBe(false);
  expect(get('reference-status').textContent).toMatch(/cannot certify/i);

  get('reference-attested').checked = true;
  get('reference-attested').dispatchEvent(new Event('change'));
  get('reference-evidence').value = 'Second independent clock';
  get('reference-evidence').dispatchEvent(new Event('input'));
  expect(get('reference-attested').checked).toBe(false);
});

test('hidden page discards capture and returning visible cannot restart it without a tap', async () => {
  get('diagnostics').checked = true;
  await import('../src/main');
  get('start').click();
  callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
  await Promise.resolve();
  get('confirm-first').click();
  screen.hidden = true; screen.dispatchEvent(new Event('visibilitychange'));
  expect(stop).toHaveBeenCalledOnce();
  expect(get('status').textContent).toContain('discarded');
  screen.hidden = false; screen.dispatchEvent(new Event('visibilitychange'));
  expect(start).toHaveBeenCalledOnce();
  get('resume').click();
  expect(start).toHaveBeenCalledTimes(2);
  expect(get('status').textContent).toContain('Calibrating');
});

test('denied permission is visible and leaves a new-attempt resume path', async () => {
  start.mockImplementation((_pair, handlers: CaptureHandlers) => {
    const error = new Error('Permission denied by browser');
    handlers.onError(error);
    return Promise.reject(error);
  });
  await import('../src/main');
  get('start').click();
  await Promise.resolve();
  expect(get('error').hidden).toBe(false);
  expect(get('error').textContent).toContain('Permission denied by browser');
  expect(get('resume').disabled).toBe(false);
  expect(blobs).toHaveLength(0);
});

  test('one practice gesture calibrates then automatically starts, even before capture promise resolves', async () => {
    start.mockImplementation((_pair, handlers: CaptureHandlers) => {
      callbacks = handlers;
      handlers.onCalibration({ status: 'ready', remainingMs: 0 });
      return Promise.resolve({ settings: {}, analysisSampleRate: 48000, stop });
    });
    await import('../src/main');
    expect(get('observer').hidden).toBe(true);
    get('start').click();
    expect(start).toHaveBeenCalledOnce();
    expect(get('status').textContent).toMatch(/Go|practice/i);
    expect(get('begin').hidden).toBe(true);
    now += 60500;
    ticks.forEach((tick) => tick());
    expect(get('countdown').textContent).toBe('0');
    expect(get('practice-result').textContent).toMatch(/60.*second|minute/i);
    expect(get('configuration').disabled).toBe(false);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });

  test('practice waits for calibration, resets after interruption, and replays the newly selected pair', async () => {
    await import('../src/main');
    get('start').click();
    expect(get('status').textContent).toMatch(/Calibrating/);
    now += 10000;
    ticks.forEach((tick) => tick());
    expect(get('countdown').textContent).toBe('60');
    callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
    for (const chord of ['A', 'D'] as const) {
      for (let frame = 0; frame < 3; frame++) {
        now += 100;
        callbacks.onObservation({ chord, confidence: 1, atMs: now });
      }
    }
    expect(get('count').textContent).toBe('1');
    expect(get('practice-feedback').textContent).toMatch(/First switch/);
    screen.hidden = true; screen.dispatchEvent(new Event('visibilitychange'));
    expect(get('count').textContent).toBe('0');
    expect(get('practice-result').textContent).not.toMatch(/switches per minute/);
    screen.hidden = false; screen.dispatchEvent(new Event('visibilitychange'));
    expect(start).toHaveBeenCalledOnce();
    get('resume').click();
    expect(start).toHaveBeenCalledTimes(2);
    callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
    now += 60000; ticks.forEach((tick) => tick());
    await vi.waitFor(() => expect(get('start').disabled).toBe(false));
    get('first').value = 'G'; get('second').value = 'Em';
    get('first').dispatchEvent(new Event('change'));
    expect(get('current').textContent).toBe('G');
    expect(get('next').textContent).toBe('Em');
    get('start').click();
    expect(start.mock.calls.at(-1)?.[0]).toEqual(['G', 'Em']);
    expect(get('count').textContent).toBe('0');
  });

  test('history hash cannot interrupt capture; finished history preserves summary and saving locks updates', async () => {
    const module = await import('../src/pwa');
    const setup = vi.spyOn(module, 'setupPwa').mockReturnValue({
      refresh: vi.fn(), install: async () => {}, applyUpdate: async () => {},
    });
    let commit!: () => void;
    const save = vi.fn(() => new Promise<void>((done) => { commit = done; }));
    historyOpen.mockResolvedValue({ list: async () => [], save, close: () => {} });
    await import('../src/main');
    get('start').click();
    expect(get('nav-history').disabled).toBe(true);
    window.location.hash = '#history'; window.dispatchEvent(new Event('hashchange'));
    expect(window.location.hash).toBe('#practice');
    expect(get('history-page').hidden).toBe(true);
    callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
    now += 60_000; ticks.forEach((tick) => tick());
    expect(get('history-save').textContent).toMatch(/Saving/);
    expect(setup.mock.calls[0][0].safe()).toBe(false);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    get('nav-history').click();
    window.dispatchEvent(new Event('hashchange'));
    expect(get('practice-page').hidden).toBe(false);
    commit();
    await vi.waitFor(() => expect(get('history-save').textContent).toMatch(/Saved/));
    expect(setup.mock.calls[0][0].safe()).toBe(true);
    get('nav-history').click(); window.dispatchEvent(new Event('hashchange'));
    expect(get('practice-page').hidden).toBe(true);
    get('nav-practice').click(); window.dispatchEvent(new Event('hashchange'));
    expect(get('practice-result').textContent).toMatch(/One minute/);
    expect(get('countdown').textContent).toBe('0');
  });

  test('startup history failure is visible without blocking practice and retryable failed save blocks reload', async () => {
    historyOpen.mockRejectedValue(new Error('IDB boundary unavailable'));
    const module = await import('../src/pwa');
    const setup = vi.spyOn(module, 'setupPwa').mockReturnValue({
      refresh: vi.fn(), install: async () => {}, applyUpdate: async () => {},
    });
    await import('../src/main');
    await vi.waitFor(() => expect(get('history-storage').textContent).toMatch(/unavailable/i));
    expect(get('start').disabled).toBe(false);
    get('start').click();
    callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
    now += 1000; get('finish').click();
    await vi.waitFor(() => expect(get('history-save').textContent).toMatch(/not saved/i));
    expect(get('history-retry').hidden).toBe(false);
    expect(setup.mock.calls[0][0].safe()).toBe(false);
    expect(get('start').disabled).toBe(true);
    historyOpen.mockResolvedValue({ list: async () => [], save: async () => {}, close: () => {} });
    get('history-retry').click();
    await vi.waitFor(() => expect(get('history-save').textContent).toMatch(/Saved/));
    expect(get('start').disabled).toBe(false);
  });

test('switching from a finished diagnostic control to practice does not invent a practice result', async () => {
  get('diagnostics').checked = true;
  get('mode').value = 'silence';
  await import('../src/main');
  get('start').click();
  callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
  expect(get('begin').hidden).toBe(false);
  expect(get('begin').disabled).toBe(true);
  for (let frame = 0; frame < 3; frame++) {
    now += 100;
    callbacks.onObservation({ chord: 'A', confidence: 1, atMs: now });
  }
  expect(get('begin').disabled).toBe(false);
  get('begin').click();
  now += 60000; ticks.forEach((tick) => tick());
  expect(get('finish').disabled).toBe(false);
  get('finish').click();
  expect(get('results').textContent).toMatch(/Control passed/);
  get('diagnostics').checked = false;
  get('diagnostics').dispatchEvent(new Event('change'));
  expect(get('countdown').textContent).toBe('60');
  expect(get('practice-result').textContent).toBe('');
  expect(get('begin').hidden).toBe(true);
});

test('practice milestones follow live confirmed changes and partial rounds do not invent a minute rate', async () => {
  await import('../src/main');
  get('start').click();
  callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
  for (let change = 0; change <= 10; change++) {
    for (let frame = 0; frame < 3; frame++) {
      now += 100;
      callbacks.onObservation({ chord: change % 2 === 0 ? 'A' : 'D', confidence: 1, atMs: now });
    }
    now += 200;
    if (change === 5) expect(get('practice-feedback').textContent).toMatch(/5 switches/);
  }
  expect(get('count').textContent).toBe('10');
  expect(get('practice-feedback').textContent).toMatch(/10 switches/);
  expect(get('current-diagram').children[0]?.getAttribute('aria-label')).toMatch(/A chord.*low E muted/);
  get('finish').click();
  expect(get('practice-result').textContent).toMatch(/ended early.*10 confirmed switches/);
  expect(get('practice-result').textContent).not.toMatch(/switches per minute/);
});
