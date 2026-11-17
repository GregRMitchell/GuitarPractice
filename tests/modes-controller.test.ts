import { expect, test, vi } from 'vitest';
import { createModesController } from '../src/modes/controller';
import type { CoachCapture, CoachHandlers } from '../src/coach/controller';
import type { RhythmHandlers, RhythmSnapshot } from '../src/rhythm/controller';

const rhythmSnapshot = (phase: RhythmSnapshot['phase'], elapsedSeconds = 0): RhythmSnapshot => ({
  phase, elapsedSeconds, targetSeconds: 60, bpm: 80, patternId: 'quarters', audible: true,
  soundMode: 'beat',
  activeSlot: 0, beat: 1, bar: 1, countInRemaining: 4,
  summary: { timingMeasured: false, estimatedStrums: null, expected: 0, matched: null,
    inTime: null, missed: null, extra: null, meanAbsoluteOffsetMs: null },
});

test('coach calibration before handle resolution stays authoritative; cancel stops late capture', async () => {
  let handlers!: CoachHandlers;
  let resolve!: (capture: CoachCapture) => void;
  const stop = vi.fn(async () => {});
  const completed = vi.fn();
  const controller = createModesController({ changed: vi.fn(), completed,
    startCoach: (_chord, callbacks) => {
      handlers = callbacks;
      callbacks.onCalibration({ status: 'calibrating', remainingMs: 1800 });
      return new Promise((done) => { resolve = done; });
    } });
  const pending = controller.startCoach('Am');
  expect(controller.state().phase).toBe('calibrating');
  const cancel = controller.reset();
  expect(controller.active()).toBe(true);
  resolve({ stop, selectOverall: vi.fn(), selectString: vi.fn(), settings: {}, analysisSampleRate: 48000 });
  await pending; await cancel;
  expect(stop).toHaveBeenCalledOnce();
  handlers.onCalibration({ status: 'ready', remainingMs: 0 });
  expect(controller.state().phase).toBe('idle');
  expect(completed).not.toHaveBeenCalled();
});

test('calibration ready before handle permits a timed coach round and only one summary', async () => {
  let now = 0;
  const completed = vi.fn();
  const selectString = vi.fn();
  const stop = vi.fn(async () => {});
  const controller = createModesController({ changed: vi.fn(), completed, now: () => now,
    startCoach: async (_chord, handlers) => {
      handlers.onCalibration({ status: 'ready', remainingMs: 0 });
      return { stop, selectString, selectOverall: vi.fn(), settings: {}, analysisSampleRate: 48000 };
    } });
  await controller.startCoach('Am');
  expect(controller.state().phase).toBe('running');
  controller.selectString(2);
  expect(selectString).toHaveBeenCalledWith(2);
  now = 60_100; controller.tick();
  await vi.waitFor(() => expect(controller.state().phase).toBe('finished'));
  expect(completed).toHaveBeenCalledOnce();
  expect(completed.mock.calls[0][0]).toMatchObject({ mode: 'coach', targetChord: 'Am',
    activeMs: 60_000, completed: true, confirmations: 0, successfulStrings: [] });
  controller.tick();
  expect(completed).toHaveBeenCalledOnce();
});

test('guided rhythm starts synchronously without microphone and retains early finish, not interruption', async () => {
  let callbacks!: RhythmHandlers;
  const completed = vi.fn();
  const stop = vi.fn(async () => rhythmSnapshot('stopped', 10));
  const startRhythm = vi.fn(async (_options, handlers: RhythmHandlers) => {
    callbacks = handlers;
    handlers.onChanged(rhythmSnapshot('count-in'));
    return { snapshot: rhythmSnapshot('count-in'), stop };
  });
  const controller = createModesController({ changed: vi.fn(), completed, startRhythm });
  const pending = controller.startRhythm('E', {});
  expect(startRhythm).toHaveBeenCalledWith(expect.objectContaining({ microphone: false, bpm: 80 }), expect.anything());
  expect(controller.state().phase).toBe('count-in');
  await pending;
  callbacks.onChanged(rhythmSnapshot('playing', 10));
  await controller.finish();
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ mode: 'rhythm',
    heldChord: 'E', activeMs: 10_000, completed: false, matched: null, tracking: 'guided' }));
  await controller.startRhythm('E', {});
  callbacks.onPause('hidden');
  await vi.waitFor(() => expect(controller.active()).toBe(false));
  expect(completed).toHaveBeenCalledOnce();
});

test('errors and late terminal callbacks cannot resurrect canceled rhythm', async () => {
  let callbacks!: RhythmHandlers;
  let resolve!: (value: { snapshot: RhythmSnapshot; stop: () => Promise<RhythmSnapshot> }) => void;
  const stop = vi.fn(async () => rhythmSnapshot('stopped'));
  const completed = vi.fn();
  const controller = createModesController({ changed: vi.fn(), completed,
    startRhythm: (_options, handlers) => {
      callbacks = handlers;
      return new Promise((done) => { resolve = done; });
    } });
  const pending = controller.startRhythm('A', {});
  const reset = controller.reset();
  callbacks.onChanged(rhythmSnapshot('finished', 60));
  resolve({ snapshot: rhythmSnapshot('finished', 60), stop });
  await pending; await reset;
  expect(controller.state().phase).toBe('idle');
  expect(completed).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
});

test('coach excludes observations arriving beyond its deadline and never certifies extra repetitions', async () => {
  let now = 0;
  let callbacks!: CoachHandlers;
  const completed = vi.fn();
  const controller = createModesController({ changed: vi.fn(), completed, now: () => now,
    startCoach: async (_chord, handlers) => {
      callbacks = handlers;
      handlers.onCalibration({ status: 'ready', remainingMs: 0 });
      return { stop: async () => {}, selectString: vi.fn(), selectOverall: vi.fn(),
        settings: {}, analysisSampleRate: 48000 };
    } });
  await controller.startCoach('A');
  const snapshot = { chord: 'A' as const, mode: 'overall' as const, stringIndex: null,
    targets: [], assessment: { status: 'good' as const, title: 'Sounds close', tip: 'Keep going' },
    overallConfirmations: 1, successfulStrings: [] };
  callbacks.onSnapshot(snapshot);
  now = 60_001;
  callbacks.onSnapshot({ ...snapshot, overallConfirmations: 2 });
  await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 1, activeMs: 60_000 }));
});

test('recalibration discards a coach round; returning to ready cannot resume it', async () => {
  let callbacks!: CoachHandlers;
  const completed = vi.fn();
  const controller = createModesController({ changed: vi.fn(), completed,
    startCoach: async (_chord, handlers) => {
      callbacks = handlers;
      handlers.onCalibration({ status: 'ready', remainingMs: 0 });
      return { stop: async () => {}, selectString: vi.fn(), selectOverall: vi.fn(),
        settings: {}, analysisSampleRate: 48000 };
    } });
  await controller.startCoach('E');
  callbacks.onCalibration({ status: 'calibrating', remainingMs: 2000 });
  await vi.waitFor(() => expect(controller.active()).toBe(false));
  callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
  expect(controller.state().phase).toBe('idle');
  expect(completed).not.toHaveBeenCalled();
});

test('rhythm cancellation aborts pending permission setup before any handle exists', async () => {
  let signal!: AbortSignal;
  const completed = vi.fn();
  const controller = createModesController({ changed: vi.fn(), completed,
    startRhythm: (options) => {
      signal = options.signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    } });
  const pending = controller.startRhythm('E', { microphone: true, audible: false });
  expect(signal.aborted).toBe(false);
  await controller.reset();
  await pending;
  expect(signal.aborted).toBe(true);
  expect(controller.active()).toBe(false);
  expect(controller.state().phase).toBe('idle');
  expect(completed).not.toHaveBeenCalled();
});

test('natural measured rhythm stays locked while finalizing and saves only final scored snapshot', async () => {
  let callbacks!: RhythmHandlers;
  const completed = vi.fn();
  const final = rhythmSnapshot('finished', 60);
  const controller = createModesController({ changed: vi.fn(), completed,
    startRhythm: async (_options, handlers) => {
      callbacks = handlers;
      return { snapshot: rhythmSnapshot('playing', 59), stop: async () => final };
    } });
  await controller.startRhythm('A', {});
  callbacks.onChanged(rhythmSnapshot('finalizing', 60));
  expect(controller.state().phase).toBe('finalizing');
  expect(controller.active()).toBe(true);
  await controller.finish();
  expect(completed).not.toHaveBeenCalled();
  callbacks.onChanged(final);
  await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ completed: true, activeMs: 60_000 }));
});

test('discard during finalizing never saves an aborted rhythm as a completed round', async () => {
  let callbacks!: RhythmHandlers;
  const completed = vi.fn();
  const controller = createModesController({ changed: vi.fn(), completed,
    startRhythm: async (_options, handlers) => {
      callbacks = handlers;
      return { snapshot: rhythmSnapshot('playing', 59), stop: async () => rhythmSnapshot('paused', 60) };
    } });
  await controller.startRhythm('A', {});
  callbacks.onChanged(rhythmSnapshot('finalizing', 60));
  await controller.reset();
  callbacks.onChanged(rhythmSnapshot('finished', 60));
  expect(controller.active()).toBe(false);
  expect(completed).not.toHaveBeenCalled();
});

test('hiding during asynchronous finish cleanup cancels the unsaved round', async () => {
  let callbacks!: RhythmHandlers;
  let release!: () => void;
  const completed = vi.fn();
  const stopped = new Promise<RhythmSnapshot>((resolve) => {
    release = () => resolve(rhythmSnapshot('stopped', 10));
  });
  const controller = createModesController({ changed: vi.fn(), completed,
    startRhythm: async (_options, handlers) => {
      callbacks = handlers;
      return { snapshot: rhythmSnapshot('playing', 10), stop: () => stopped };
    } });
  await controller.startRhythm('E', {});
  callbacks.onChanged(rhythmSnapshot('playing', 10));
  const finish = controller.finish();
  const hide = controller.reset();
  release();
  await finish; await hide;
  expect(controller.state().phase).toBe('idle');
  expect(completed).not.toHaveBeenCalled();
});
