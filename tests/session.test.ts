import { expect, test, vi } from 'vitest';
import type { Capture, CaptureHandlers } from '../src/audio/capture';
import { createSession } from '../src/session';
import type { RunMode } from '../src/session';

function harness(mode: RunMode = 'pair', independent = true): {
  session: ReturnType<typeof createSession>;
  handlers: () => CaptureHandlers;
  time: (value: number) => void;
  resolve: () => void;
  stop: ReturnType<typeof vi.fn>;
  observe: (chord: 'A' | 'D', times: number[]) => void;
} {
  let now = 0;
  let callbacks: CaptureHandlers;
  let resolve!: (capture: Capture) => void;
  const stop = vi.fn(async (): Promise<void> => {});
  const session = createSession({
    now: () => now,
    startCapture: (_pair, handlers) => {
      callbacks = handlers;
      handlers.onCalibration({ status: 'ready', remainingMs: 0, noiseFloorRms: 0.001 });
      return new Promise<Capture>((done) => { resolve = done; });
    },
    changed: () => {},
  });
  void session.start({ pair: ['A', 'D'], mode, independent });
  return {
    session, handlers: () => callbacks, time: (value) => { now = value; }, stop,
    resolve: () => resolve({ stop, analysisSampleRate: 48000, settings: { sampleRate: 48000 } }),
    observe: (chord, times) => {
      for (const atMs of times) {
        now = atMs;
        callbacks.onObservation({ atMs, chord, confidence: 1 });
      }
    },
  };
}

test('ready callback before startup resolution is not overwritten; late capture is released', async () => {
  const h = harness();
  expect(h.session.snapshot().phase).toBe('ready');
  h.session.pause('hidden');
  h.resolve();
  await Promise.resolve();
  expect(h.stop).toHaveBeenCalledOnce();
  expect(h.session.snapshot().phase).toBe('paused');
  h.handlers().onCalibration({ status: 'ready', remainingMs: 0 });
  expect(h.session.snapshot().phase).toBe('paused');
});

test('independent labels normalize the shared clock and discard pre-origin source/evidence', () => {
  const h = harness();
  h.observe('D', [500, 590, 680]);
  h.time(1000);
  h.session.confirm('A');
  h.handlers().onObservation({ atMs: 990, chord: 'D', confidence: 1 });
  h.observe('A', [1010, 1100, 1190]);
  h.time(1300);
  h.session.confirm('D');
  h.observe('D', [1310, 1400, 1490]);
  h.time(1600);
  h.session.finish();
  const run = h.session.snapshot();
  expect(run.references).toEqual([{ chord: 'A', atMs: 0 }, { chord: 'D', atMs: 300 }]);
  expect(run.events).toEqual([{ chord: 'D', atMs: 490 }]);
  expect(run.elapsedMs).toBe(600);
});

test('pause discards labels/events and explicit restart creates a fresh clock origin', () => {
  const h = harness();
  h.time(1000); h.session.confirm('A');
  h.time(2000); h.session.confirm('D');
  h.session.pause('interrupted');
  expect(h.session.snapshot()).toMatchObject({
    phase: 'paused', discarded: true, references: [], events: [], elapsedMs: 0,
  });
  h.time(5000);
  void h.session.start({ pair: ['A', 'D'], mode: 'pair', independent: true });
  h.time(6000); h.session.confirm('A');
  h.time(6500); h.session.finish();
  expect(h.session.snapshot()).toMatchObject({ elapsedMs: 500, discarded: false });
  expect(h.session.snapshot().references).toEqual([{ chord: 'A', atMs: 0 }]);
});

test('recalibration discards run eligibility and requires a new explicit origin', () => {
  const h = harness();
  h.time(1000); h.session.confirm('A');
  h.handlers().onCalibration({ status: 'calibrating', remainingMs: 2000 });
  expect(h.session.snapshot()).toMatchObject({
    discarded: true, phase: 'calibrating', references: [], events: [], elapsedMs: 0,
  });
  h.handlers().onCalibration({ status: 'ready', remainingMs: 0 });
  expect(h.session.snapshot().phase).toBe('ready');
  h.time(5000); h.session.confirm('D');
  expect(h.session.snapshot()).toMatchObject({ discarded: false, elapsedMs: 0 });
});

test.each(['silence', 'speech', 'same-chord'] as const)(
  '%s timer cannot start before detector source establishment; same chord never adds a switch',
  (mode) => {
    const h = harness(mode);
    h.time(1000); h.session.begin();
    expect(h.session.snapshot().phase).toBe('ready');
    h.observe('A', [1010, 1100, 1190]);
    h.time(2000); h.session.begin();
    expect(h.session.snapshot().phase).toBe('running');
    h.observe('A', [2010, 2100, 2190, 3000]);
    h.time(32000); h.session.finish();
    expect(h.session.snapshot()).toMatchObject({ elapsedMs: 30000, events: [] });
    expect(h.session.snapshot().sourceAtStart).toBe('A');
  },
);

test('a control counts a real detector switch after the source without resetting the drill', () => {
  const h = harness('silence');
  h.observe('A', [1010, 1100, 1190]);
  h.time(2000); h.session.begin();
  h.observe('D', [2010, 2100, 2190]);
  expect(h.session.snapshot().events).toEqual([{ atMs: 190, chord: 'D' }]);
});

test('a control boundary retains source but discards provisional pre-control switch evidence', () => {
  const h = harness('silence');
  h.observe('A', [1010, 1100, 1190]);
  h.observe('D', [1810, 1900]);
  h.time(1950); h.session.begin();
  h.observe('D', [1990]);
  expect(h.session.snapshot().events).toEqual([]);
  h.observe('D', [2080, 2170]);
  expect(h.session.snapshot().events).toEqual([{ atMs: 220, chord: 'D' }]);
});

test('exploratory runs do not manufacture independent references', () => {
  const h = harness('pair', false);
  h.time(1000); h.session.begin();
  h.observe('A', [1010, 1100, 1190]);
  h.observe('D', [1210, 1300, 1390]);
  expect(h.session.snapshot().references).toEqual([]);
  expect(h.session.snapshot().events).toHaveLength(1);
});

test('startup is synchronous and permission rejection becomes a visible discarded state', async () => {
  let invoked = false;
  const session = createSession({
    now: () => 0, changed: () => {},
    startCapture: (_pair, handlers) => {
      invoked = true;
      const error = new Error('Permission denied');
      handlers.onError(error);
      return Promise.reject(error);
    },
  });
  const pending = session.start({ pair: ['A', 'D'], mode: 'pair', independent: true });
  expect(invoked).toBe(true);
  await pending;
  expect(session.snapshot()).toMatchObject({ phase: 'paused', error: 'Permission denied' });
});

test('runtime pause followed by error still displays the specific device failure', () => {
  const h = harness();
  h.handlers().onPause('interrupted');
  h.handlers().onError(new Error('Audio processing timed out'));
  expect(h.session.snapshot().error).toContain('Audio processing timed out');
});

test('a late sample-end timestamp cannot place an event after the finish clock', () => {
  const h = harness();
  h.time(1000); h.session.confirm('A');
  h.observe('A', [1010, 1100, 1190]);
  h.observe('D', [1210, 1300]);
  h.time(1389);
  h.handlers().onObservation({ atMs: 1390, chord: 'D', confidence: 1 });
  h.session.finish();
  expect(h.session.snapshot().events).toEqual([]);
});

test('capture resolution after finish releases resources without changing the frozen report', async () => {
  const h = harness();
  h.time(1000); h.session.confirm('A');
  h.time(1500); h.session.finish();
  const frozen = h.session.snapshot();
  h.resolve();
  await Promise.resolve();
  h.handlers().onObservation({ atMs: 2000, chord: 'D', confidence: 1 });
  expect(h.stop).toHaveBeenCalledOnce();
  expect(h.session.snapshot()).toEqual(frozen);
});

test('callbacks from a discarded generation cannot contaminate the explicit restart', () => {
  const h = harness();
  const old = h.handlers();
  h.session.pause('hidden');
  void h.session.start({ pair: ['A', 'D'], mode: 'pair', independent: true });
  old.onError(new Error('Old failure'));
  old.onPause('interrupted');
  old.onObservation({ atMs: 0, chord: 'A', confidence: 1 });
  expect(h.session.snapshot()).toMatchObject({ phase: 'ready', error: '', prediction: null });
});

test('a previous capture cleanup rejection cannot contaminate a new attempt', async () => {
  const h = harness();
  h.resolve();
  await Promise.resolve();
  let rejectStop!: (reason: Error) => void;
  h.stop.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
    rejectStop = reject;
  }));
  h.session.pause('hidden');
  const starting = h.session.start({ pair: ['A', 'D'], mode: 'pair', independent: true });
  h.resolve();
  await starting;
  h.time(1000); h.session.confirm('A');
  const current = h.session.snapshot();

  rejectStop(new Error('Old cleanup failed'));
  await Promise.resolve();

  expect(h.session.snapshot()).toEqual(current);
  expect(h.session.snapshot()).toMatchObject({ phase: 'running', error: '' });
});

test.each(['pause', 'finish'] as const)('current %s cleanup errors remain explicit', async (action) => {
  const h = harness();
  h.resolve();
  await Promise.resolve();
  h.stop.mockRejectedValueOnce(new Error('Current cleanup failed'));

  if (action === 'pause') h.session.pause('hidden');
  else h.session.finish();
  await Promise.resolve();

  expect(h.session.snapshot()).toMatchObject({
    phase: action === 'pause' ? 'paused' : 'finished',
    error: 'Microphone cleanup failed. Close this page before continuing.',
  });
});
