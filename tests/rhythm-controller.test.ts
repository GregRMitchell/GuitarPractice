import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startRhythm } from '../src/rhythm/controller';
import type { RhythmAudioFactory, RhythmHandlers } from '../src/rhythm/controller';
import type { RhythmAudio } from '../src/rhythm/audio';
import type { RhythmOnset } from '../src/rhythm/onset';

let now: number;
let emit: (onset: RhythmOnset) => void;
let pause: (reason: 'hidden' | 'interrupted') => void;
let fail: (error: Error) => void;
let audio: RhythmAudio;
let factory: RhythmAudioFactory;
let handlers: RhythmHandlers;
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  audio = {
    get now(): number { return now; },
    ready: vi.fn(async (microphone, callback) => { emit = callback; return microphone ? 1 : 0; }),
    click: vi.fn(), setCaptureDeadline: vi.fn(), stopCapture: vi.fn(), close: vi.fn(async () => undefined),
  };
  factory = vi.fn((_audible, onPause, onError) => { pause = onPause; fail = onError; return audio; });
  handlers = { onChanged: vi.fn(), onPause: vi.fn(), onError: vi.fn() };
});
afterEach(() => { vi.useRealTimers(); });
function step(time: number): void { now = time; vi.advanceTimersByTime(25); }

test('a configured duration ends on its deadline without an extra click', async () => {
  const session = await startRhythm({ bpm: 160, durationSeconds: 3 }, handlers, factory);
  expect(session.snapshot.targetSeconds).toBe(3);
  expect(audio.setCaptureDeadline).toHaveBeenCalledWith(4.55);
  step(4.5);
  step(4.55);
  expect(session.snapshot).toMatchObject({ phase: 'finished', elapsedSeconds: 3 });
  expect(vi.mocked(audio.click).mock.calls.every(([at]) => at < 4.55)).toBe(true);
  expect(session.snapshot.summary.expected).toBe(8);
});

test('fractional-duration completion preserves the canonical target exactly', async () => {
  const durationSeconds = 16 * 60 / 120.5;
  const session = await startRhythm({ bpm: 120.5, durationSeconds }, handlers, factory);
  const deadline = 0.05 + 4 * 60 / 120.5 + durationSeconds;
  step(deadline + 0.001);
  expect(session.snapshot.phase).toBe('finished');
  expect(session.snapshot.elapsedSeconds).toBe(durationSeconds);
  expect(session.snapshot.summary.expected).toBe(16);
  expect(vi.mocked(audio.click).mock.calls.every(([at]) => at < deadline)).toBe(true);
});

test('floating-point error never schedules a final downbeat at the phrase endpoint', async () => {
  const bpm = 40.1;
  const durationSeconds = 20 * 60 / bpm;
  const session = await startRhythm({ bpm, durationSeconds }, handlers, factory);
  const deadline = 0.05 + 4 * 60 / bpm + durationSeconds;
  step(deadline - 0.05);
  expect(vi.mocked(audio.click).mock.calls.every(([at]) => deadline - at > 1e-8)).toBe(true);
  step(deadline + 0.01);
  expect(session.snapshot.phase).toBe('finished');
});

test('a long exercise continues beyond the old minute and scores the complete target', async () => {
  const session = await startRhythm({ bpm: 80, durationSeconds: 120 }, handlers, factory);
  const start = 0.05 + 4 * 60 / 80;
  step(start + 70);
  expect(session.snapshot).toMatchObject({ phase: 'playing', targetSeconds: 120, elapsedSeconds: 70 });
  step(start + 120);
  expect(session.snapshot).toMatchObject({ phase: 'finished', elapsedSeconds: 120 });
  expect(session.snapshot.summary.expected).toBe(160);
});

test('audio-clock lookahead accents first beat and never schedules a past or post-finish click', async () => {
  const session = await startRhythm({ bpm: 120 }, handlers, factory);
  expect(audio.click).toHaveBeenCalledWith(0.05, true, 62.05);
  step(0.5);
  expect(audio.click).toHaveBeenLastCalledWith(0.55, false, 62.05);
  step(2);
  step(2.05);
  expect(session.snapshot).toMatchObject({ phase: 'playing', activeSlot: 0, beat: 1, elapsedSeconds: 0 });
  expect(audio.click).toHaveBeenLastCalledWith(2.05, true, 62.05);
  step(3.32);
  expect(session.snapshot).toMatchObject({ activeSlot: 5, beat: 3, bar: 1 });
  step(61.99);
  const calls = vi.mocked(audio.click).mock.calls;
  expect(calls.every(([at]) => at < 62.05)).toBe(true);
  step(62.1);
  expect(session.snapshot).toMatchObject({ phase: 'finished', elapsedSeconds: 60 });
  expect(session.snapshot.summary).toMatchObject({ timingMeasured: false, matched: null, expected: 120 });
  expect(audio.close).toHaveBeenCalledOnce();
  const final = session.snapshot;
  expect(await session.stop()).toBe(final);
});

test('muted microphone session calibrates before count-in and ignores count-in/stale/duplicate onsets', async () => {
  const session = await startRhythm({ bpm: 120, audible: false, microphone: true }, handlers, factory);
  expect(session.snapshot.phase).toBe('calibrating');
  step(1);
  expect(session.snapshot).toMatchObject({ phase: 'count-in', countInRemaining: 4 });
  emit({ atAudioTime: 1, strength: 0.2 });
  step(3);
  emit({ atAudioTime: 3, strength: 0.2 });
  emit({ atAudioTime: 3.01, strength: 0.2 });
  emit({ atAudioTime: Infinity, strength: 0.2 });
  step(3.6);
  emit({ atAudioTime: 3.2, strength: 0.2 });
  emit({ atAudioTime: 3.52, strength: 0.2 });
  step(4);
  expect(session.snapshot.summary).toMatchObject({ timingMeasured: true, estimatedStrums: 2, matched: 2 });
  expect(session.snapshot.summary.meanAbsoluteOffsetMs).toBeCloseTo(10);
  await session.stop();
});

test('headphone acknowledgement is enforced before creating audio or acquiring mic', async () => {
  await expect(startRhythm({ microphone: true }, handlers, factory)).rejects.toThrow('headphones');
  await expect(startRhythm({ bpm: 39 }, handlers, factory)).rejects.toThrow('Tempo');
  await expect(startRhythm({ bpm: NaN }, handlers, factory)).rejects.toThrow('Tempo');
  expect(factory).not.toHaveBeenCalled();
  await (await startRhythm({ microphone: true, headphonesAcknowledged: true }, handlers, factory)).stop();
});

test.each(['hidden', 'interrupted'] as const)('pause %s is terminal and stale callbacks cannot restart', async (reason) => {
  const session = await startRhythm({}, handlers, factory);
  const count = vi.mocked(handlers.onChanged).mock.calls.length;
  pause(reason);
  step(10);
  emit({ atAudioTime: 10, strength: 1 });
  pause(reason);
  fail(new Error('stale'));
  expect(session.snapshot.phase).toBe('paused');
  expect(handlers.onChanged).toHaveBeenCalledTimes(count + 1);
  expect(handlers.onPause).toHaveBeenCalledExactlyOnceWith(reason);
  expect(handlers.onError).not.toHaveBeenCalled();
  expect(audio.close).toHaveBeenCalledOnce();
  await session.stop();
});

test('setup failure and processing failure release resources once and report an error', async () => {
  vi.mocked(audio.ready).mockRejectedValueOnce(new Error('Permission denied'));
  await expect(startRhythm({ microphone: true, audible: false }, handlers, factory)).rejects.toThrow('Permission denied');
  expect(audio.close).toHaveBeenCalledOnce();
  expect(handlers.onError).toHaveBeenCalledOnce();
});

test('hidden while permission is pending prevents a late setup completion from starting', async () => {
  let resolve!: (time: number) => void;
  vi.mocked(audio.ready).mockImplementationOnce(() => new Promise<number>((done) => { resolve = done; }));
  const pending = startRhythm({}, handlers, factory);
  pause('hidden');
  resolve(0);
  await expect(pending).rejects.toThrow('stopped during setup');
  expect(audio.click).not.toHaveBeenCalled();
  expect(handlers.onPause).toHaveBeenCalledOnce();
});

test('permission/setup deadline bounds resource use and releases context', async () => {
  vi.mocked(audio.ready).mockImplementationOnce(() => new Promise<number>(() => undefined));
  const pending = startRhythm({ microphone: true, audible: false }, handlers, factory);
  const rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(audio.close).toHaveBeenCalledOnce();
  expect(handlers.onError).toHaveBeenCalledOnce();
});

test('runtime scheduling failure stops and reports instead of leaving an active timer', async () => {
  const session = await startRhythm({}, handlers, factory);
  vi.mocked(audio.click).mockImplementationOnce(() => { throw new Error('device failure'); });
  step(0.75);
  expect(session.snapshot.phase).toBe('error');
  expect(handlers.onError).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
  await session.stop();
});

test('abort cancels pending permission immediately without reporting a failure', async () => {
  const controller = new AbortController();
  vi.mocked(audio.ready).mockImplementationOnce(() => new Promise<number>(() => undefined));
  const pending = startRhythm({ microphone: true, audible: false, signal: controller.signal }, handlers, factory);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  expect(audio.close).toHaveBeenCalledOnce();
  await rejected;
  expect(handlers.onError).not.toHaveBeenCalled();
  expect(handlers.onPause).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('pre-aborted sessions never allocate audio and active aborts never restart', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(startRhythm({ signal: controller.signal }, handlers, factory)).rejects.toMatchObject({ name: 'AbortError' });
  expect(factory).not.toHaveBeenCalled();
  const active = new AbortController();
  const session = await startRhythm({ signal: active.signal }, handlers, factory);
  active.abort();
  expect(session.snapshot.phase).toBe('stopped');
  step(10);
  expect(audio.close).toHaveBeenCalledOnce();
  await session.stop();
});

test('abort winning after setup resolves still rejects with AbortError before scheduling', async () => {
  const controller = new AbortController();
  let resolve!: (at: number) => void;
  vi.mocked(audio.ready).mockImplementationOnce(() => new Promise<number>((done) => { resolve = done; }));
  const pending = startRhythm({ signal: controller.signal }, handlers, factory);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  resolve(0);
  await Promise.resolve();
  controller.abort();
  await rejected;
  expect(audio.click).not.toHaveBeenCalled();
  expect(handlers.onError).not.toHaveBeenCalled();
});

test('natural deadline drains a queued pre-deadline onset before publishing finished', async () => {
  const session = await startRhythm({ bpm: 120, patternId: 'eighths', audible: false, microphone: true }, handlers, factory);
  expect(audio.setCaptureDeadline).toHaveBeenCalledWith(63);
  step(63);
  expect(session.snapshot).toMatchObject({ phase: 'finalizing', elapsedSeconds: 60, activeSlot: null });
  expect(audio.stopCapture).toHaveBeenCalledOnce();
  expect(audio.close).not.toHaveBeenCalled();
  now = 63.04;
  emit({ atAudioTime: 62.7, strength: 0.3 });
  emit({ atAudioTime: 62.84, strength: 0.3 });
  emit({ atAudioTime: 63.01, strength: 0.3 });
  expect(vi.mocked(handlers.onChanged).mock.calls.some(([value]) => value.phase === 'finished')).toBe(false);
  now = 63.25;
  await vi.advanceTimersByTimeAsync(250);
  expect(session.snapshot).toMatchObject({ phase: 'finished', elapsedSeconds: 60 });
  expect(session.snapshot.summary).toMatchObject({ estimatedStrums: 1, matched: 1, missed: 239, extra: 0 });
  expect(session.snapshot.summary.meanAbsoluteOffsetMs).toBeCloseTo(90);
  expect(audio.close).toHaveBeenCalledOnce();
  emit({ atAudioTime: 62.9, strength: 1 });
  expect((await session.stop()).summary.estimatedStrums).toBe(1);
});

test('explicit stop during finalizing cancels drain and never emits a finished summary', async () => {
  const session = await startRhythm({ bpm: 120, audible: false, microphone: true }, handlers, factory);
  step(63);
  const final = await session.stop();
  expect(final.phase).toBe('stopped');
  emit({ atAudioTime: 62.9, strength: 1 });
  await vi.advanceTimersByTimeAsync(500);
  expect(session.snapshot).toBe(final);
  expect(audio.close).toHaveBeenCalledOnce();
  expect(vi.mocked(handlers.onChanged).mock.calls.some(([value]) => value.phase === 'finished')).toBe(false);
});

test('abort during finalizing cancels the queued drain and removes its timer', async () => {
  const controller = new AbortController();
  const session = await startRhythm({ bpm: 120, audible: false, microphone: true, signal: controller.signal }, handlers, factory);
  step(63);
  controller.abort();
  expect(session.snapshot.phase).toBe('stopped');
  expect(vi.getTimerCount()).toBe(0);
  expect(audio.close).toHaveBeenCalledOnce();
  expect(handlers.onError).not.toHaveBeenCalled();
  await session.stop();
});
