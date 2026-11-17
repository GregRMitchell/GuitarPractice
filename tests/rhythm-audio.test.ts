import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRhythmAudio } from '../src/rhythm/audio';
import { browser, FakeContext, FakeWorklet } from './capture-fakes';
import { startRhythm } from '../src/rhythm/controller';

let environment: ReturnType<typeof browser>;
beforeEach(() => { environment = browser(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('guided visual mode resumes its context synchronously without asking for microphone', async () => {
  const runtime = createRhythmAudio(false, vi.fn(), vi.fn());
  expect(FakeContext.instances).toHaveLength(1);
  expect(await runtime.ready(false, vi.fn())).toBe(10);
  expect(environment.getUserMedia).not.toHaveBeenCalled();
  await runtime.close();
  await runtime.close();
  expect(FakeContext.instances[0].closed).toBe(true);
});

test('real audio boundary schedules accented oscillator envelopes and cancels queued sounds', async () => {
  const oscillators: {
    frequency: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null;
  }[] = [];
  const ramp = vi.fn();
  class ClickContext extends FakeContext {
    override createGain(): typeof this.sink {
      const gain = super.createGain();
      Object.assign(gain.gain, { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: ramp });
      return gain;
    }
    createOscillator(): typeof oscillators[number] {
      const oscillator = {
        frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(),
        start: vi.fn(), stop: vi.fn(), onended: null,
      };
      oscillators.push(oscillator);
      return oscillator;
    }
  }
  vi.stubGlobal('AudioContext', ClickContext);
  const runtime = createRhythmAudio(true, vi.fn(), vi.fn());
  await runtime.ready(false, vi.fn());
  runtime.click(11, true, 12);
  runtime.click(11.99, false, 12);
  expect(oscillators.map((oscillator) => oscillator.frequency.value)).toEqual([1200, 800]);
  expect(oscillators[0].start).toHaveBeenCalledWith(11);
  expect(oscillators[1].stop).toHaveBeenCalledWith(12);
  expect(ramp).toHaveBeenLastCalledWith(0.001, 12);
  oscillators[0].onended?.();
  expect(oscillators[0].disconnect).toHaveBeenCalledOnce();
  await runtime.close();
  expect(oscillators[1].stop).toHaveBeenLastCalledWith();
  expect(oscillators[1].disconnect).toHaveBeenCalledOnce();
});

test('microphone is mono and silent, sends only validated compact onsets, and releases every resource', async () => {
  const received = vi.fn();
  const runtime = createRhythmAudio(false, vi.fn(), vi.fn());
  expect(await runtime.ready(true, received)).toBe(11);
  expect(environment.getUserMedia).toHaveBeenCalledExactlyOnceWith({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const context = FakeContext.instances[0];
  const node = FakeWorklet.instances[0];
  expect(node.options).toMatchObject({ outputChannelCount: [1], channelCountMode: 'explicit' });
  expect(context.sink.gain.value).toBe(0);
  node.port.emit({ atAudioTime: 11, strength: 0.3 });
  node.port.emit({ atAudioTime: NaN, strength: 0.3 });
  node.port.emit({ atAudioTime: 11, strength: -1 });
  node.port.emit(null);
  expect(received).toHaveBeenCalledExactlyOnceWith({ atAudioTime: 11, strength: 0.3 });
  const stale = node.port.onmessage;
  await runtime.close();
  stale?.({ data: { atAudioTime: 12, strength: 0.4 } } as MessageEvent);
  expect(received).toHaveBeenCalledOnce();
  expect(node.port.closed).toBe(true);
  expect(node.disconnected).toBe(true);
  expect(context.source.disconnected).toBe(true);
  expect(context.sink.disconnected).toBe(true);
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
});

test('setup failure stops acquired microphone tracks, and denial reports clearly', async () => {
  vi.useFakeTimers();
  FakeContext.moduleFailure = true;
  const handlers = { onChanged: vi.fn(), onPause: vi.fn(), onError: vi.fn() };
  await expect(startRhythm({ audible: false, microphone: true }, handlers)).rejects.toThrow('worklet setup failed');
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(FakeContext.instances[0].closed).toBe(true);
  expect(handlers.onError).toHaveBeenCalledOnce();
  environment.getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
  await expect(startRhythm({ audible: false, microphone: true }, handlers)).rejects.toThrow('Permission denied');
  expect(FakeContext.instances[1].closed).toBe(true);
});

test('pending permission resolved after hidden cancellation stops the late stream', async () => {
  vi.useFakeTimers();
  let resolve!: (value: { getTracks: () => typeof environment.tracks }) => void;
  environment.getUserMedia.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const handlers = { onChanged: vi.fn(), onPause: vi.fn(), onError: vi.fn() };
  const pending = startRhythm({ audible: false, microphone: true }, handlers);
  const rejected = expect(pending).rejects.toThrow('stopped during setup');
  environment.document.hide();
  resolve({ getTracks: () => environment.tracks });
  await rejected;
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(handlers.onPause).toHaveBeenCalledExactlyOnceWith('hidden');
  expect(handlers.onError).not.toHaveBeenCalled();
});

test('device interruption and worklet failure stop active sessions with no automatic resume', async () => {
  vi.useFakeTimers();
  const handlers = { onChanged: vi.fn(), onPause: vi.fn(), onError: vi.fn() };
  const session = await startRhythm({ audible: false, microphone: true }, handlers);
  environment.tracks[0].dispatchEvent(new Event('mute'));
  expect(session.snapshot.phase).toBe('paused');
  expect(FakeContext.instances[0].closed).toBe(true);
  await session.stop();
  const next = await startRhythm({ audible: false, microphone: true }, handlers);
  FakeWorklet.instances[1].onprocessorerror?.();
  expect(next.snapshot.phase).toBe('error');
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(handlers.onError).toHaveBeenCalledOnce();
  await next.stop();
});

test('aborting pending microphone setup closes context and stops a late permission grant', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let resolve!: (value: { getTracks: () => typeof environment.tracks }) => void;
  environment.getUserMedia.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const handlers = { onChanged: vi.fn(), onPause: vi.fn(), onError: vi.fn() };
  const pending = startRhythm({ audible: false, microphone: true, signal: controller.signal }, handlers);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  expect(FakeContext.instances[0].closed).toBe(true);
  await rejected;
  resolve({ getTracks: () => environment.tracks });
  await Promise.resolve();
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(FakeWorklet.instances).toHaveLength(0);
  expect(handlers.onError).not.toHaveBeenCalled();
});

test('capture shutdown releases tracks but preserves the port for bounded queued onset drain', async () => {
  const receive = vi.fn();
  const pause = vi.fn();
  const runtime = createRhythmAudio(false, pause, vi.fn());
  await runtime.ready(true, receive);
  const node = FakeWorklet.instances[0];
  runtime.setCaptureDeadline(15);
  expect(node.port.sent).toContainEqual({ type: 'deadline', atAudioTime: 15 });
  runtime.stopCapture();
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(FakeContext.instances[0].source.disconnected).toBe(true);
  expect(node.port.closed).toBe(false);
  node.port.emit({ atAudioTime: 14.99, strength: 0.3 });
  expect(receive).toHaveBeenCalledOnce();
  environment.tracks[0].dispatchEvent(new Event('ended'));
  expect(pause).not.toHaveBeenCalled();
  await runtime.close();
  expect(node.port.closed).toBe(true);
});
