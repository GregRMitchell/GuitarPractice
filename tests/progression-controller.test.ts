import { expect, test, vi } from 'vitest';
import { createProgressionController } from '../src/progression/controller';
import type { RhythmHandlers, RhythmSnapshot } from '../src/rhythm/controller';

const plan = { sequence: ['Em', 'Am'] as const, bpm: 160, barsPerChord: 1, loops: 1 };
const snapshot = (phase: RhythmSnapshot['phase'], elapsedSeconds: number): RhythmSnapshot => ({
  phase, elapsedSeconds, targetSeconds: 3, bpm: 160, patternId: 'quarters', audible: true,
  soundMode: 'beat', activeSlot: 0, beat: 1, bar: 1, countInRemaining: 4,
  summary: { timingMeasured: false, estimatedStrums: null, expected: 8, matched: null,
    inTime: null, missed: null, extra: null, meanAbsoluteOffsetMs: null },
});

test('natural finish before handle resolves saves once only after the actual finish', async () => {
  let callbacks!: RhythmHandlers;
  let resolve!: (session: { snapshot: RhythmSnapshot; stop: () => Promise<RhythmSnapshot> }) => void;
  const completed = vi.fn();
  const controller = createProgressionController({ changed: vi.fn(), completed,
    startRhythm: (options, handlers) => {
      expect(options.durationSeconds).toBe(3);
      callbacks = handlers;
      return new Promise((done) => { resolve = done; });
    } });
  const started = controller.start(plan, {});
  callbacks.onChanged(snapshot('finished', 3));
  expect(controller.active()).toBe(true);
  expect(completed).not.toHaveBeenCalled();
  resolve({ snapshot: snapshot('finished', 3), stop: async () => snapshot('finished', 3) });
  await started;
  await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ mode: 'progression',
    sequence: ['Em', 'Am'], targetMs: 3000, activeMs: 3000, completed: true, tracking: 'guided' }));
  callbacks.onChanged(snapshot('finished', 3));
  expect(completed).toHaveBeenCalledOnce();
});

test('early end records actual playing time, while cancellation aborts pending permission', async () => {
  let callbacks!: RhythmHandlers;
  let signal!: AbortSignal;
  const completed = vi.fn();
  const controller = createProgressionController({ changed: vi.fn(), completed,
    startRhythm: async (options, handlers) => {
      signal = options.signal!;
      callbacks = handlers;
      return { snapshot: snapshot('playing', 1), stop: async () => snapshot('stopped', 1) };
    } });
  await controller.start(plan, {});
  callbacks.onChanged(snapshot('playing', 1));
  await controller.finish();
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ activeMs: 1000, completed: false }));
  await controller.start(plan, {});
  await controller.reset();
  expect(signal.aborted).toBe(true);
  callbacks.onChanged(snapshot('finished', 3));
  expect(completed).toHaveBeenCalledOnce();
});

test('natural finalization waits for the final summary and reset discards late callbacks', async () => {
  let callbacks!: RhythmHandlers;
  const completed = vi.fn();
  const controller = createProgressionController({ changed: vi.fn(), completed,
    startRhythm: async (_options, handlers) => {
      callbacks = handlers;
      return { snapshot: snapshot('playing', 2.9), stop: async () => snapshot('stopped', 3) };
    } });
  await controller.start(plan, { microphone: true, audible: false });
  callbacks.onChanged(snapshot('finalizing', 3));
  await controller.finish();
  expect(controller.active()).toBe(true);
  expect(completed).not.toHaveBeenCalled();
  await controller.reset();
  callbacks.onChanged(snapshot('finished', 3));
  expect(completed).not.toHaveBeenCalled();
  expect(controller.state().phase).toBe('idle');
});

test('reset aborts unresolved permission and cannot resurrect the attempt', async () => {
  let callbacks!: RhythmHandlers;
  let signal!: AbortSignal;
  const completed = vi.fn();
  const controller = createProgressionController({ changed: vi.fn(), completed,
    startRhythm: (options, handlers) => {
      signal = options.signal!;
      callbacks = handlers;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    } });
  const pending = controller.start(plan, { microphone: true, audible: false });
  await controller.reset();
  await pending;
  expect(signal.aborted).toBe(true);
  callbacks.onChanged(snapshot('finished', 3));
  expect(controller.active()).toBe(false);
  expect(completed).not.toHaveBeenCalled();
});

test('ending during count-in creates no record', async () => {
  const completed = vi.fn();
  const controller = createProgressionController({ changed: vi.fn(), completed,
    startRhythm: async () => ({ snapshot: snapshot('count-in', 0), stop: async () => snapshot('stopped', 0) }),
  });
  await controller.start(plan, {});
  await controller.finish();
  expect(completed).not.toHaveBeenCalled();
  expect(controller.state().phase).toBe('idle');
});
