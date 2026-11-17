import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { startCapture } from '../src/audio/capture';
import type { CaptureHandlers } from '../src/audio/capture';
import { browser, FakeContext, FakeWorker, FakeWorklet } from './capture-fakes';

let environment: ReturnType<typeof browser>;
let nowMs: number;
type HandlerSpies = {
  [Key in Exclude<keyof CaptureHandlers, 'now' | 'onAnalysis'>]: Mock<CaptureHandlers[Key]>;
} & { now: () => number };
const handlers = (): HandlerSpies => ({
  onObservation: vi.fn(), onLevel: vi.fn(), onError: vi.fn(),
  onPause: vi.fn(), onCalibration: vi.fn(), now: () => nowMs,
});

beforeEach(() => { environment = browser(); nowMs = 1000; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function frame(id = 1, audioTime = 10): void {
  FakeWorklet.instances[0].port.emit({
    type: 'frame', id, audioTime, sampleRate: 48000, samples: new Float32Array(8192),
  });
}

function result(id = 1, atMs = 1000): object {
  return {
    type: 'result', id, rms: 0.1,
    calibration: { status: 'ready', remainingMs: 0, noiseFloorRms: 0.002 },
    observation: { atMs, chord: 'E', confidence: 1 },
  };
}

test('requires a visible explicit user gesture before requesting permission', async () => {
  environment.activation.isActive = false;
  const callbacks = handlers();
  await expect(startCapture(['E', 'Em'], callbacks)).rejects.toThrow(/gesture/i);
  expect(environment.getUserMedia).not.toHaveBeenCalled();
  expect(callbacks.onError).toHaveBeenCalledOnce();
});

test('permission rejection reaches caller and error callback, closing context', async () => {
  const denied = new Error('permission denied');
  environment.getUserMedia.mockRejectedValueOnce(denied);
  const callbacks = handlers();
  await expect(startCapture(['E', 'Em'], callbacks)).rejects.toBe(denied);
  expect(callbacks.onError).toHaveBeenCalledWith(denied);
  expect(FakeContext.instances[0].closed).toBe(true);
});

test.each(['worklet', 'worker', 'resume'] as const)('%s setup failure releases acquired tracks and context', async (stage) => {
  FakeContext.moduleFailure = stage === 'worklet';
  FakeWorker.failure = stage === 'worker';
  FakeContext.resumeFailure = stage === 'resume';
  const callbacks = handlers();
  await expect(startCapture(['E', 'Em'], callbacks)).rejects.toThrow(/failed/);
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(FakeContext.instances[0].closed).toBe(true);
  expect(callbacks.onError).toHaveBeenCalledOnce();
  expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  expect(FakeWorklet.instances.every((node) => node.port.closed && node.disconnected)).toBe(true);
});

test('requests preferred music constraints and routes through a zero-output sink', async () => {
  const capture = await startCapture(['E', 'Em'], handlers());
  expect(environment.getUserMedia).toHaveBeenCalledWith({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  });
  expect(capture.settings).toEqual({ sampleRate: 48000, echoCancellation: true });
  const context = FakeContext.instances[0];
  const worklet = FakeWorklet.instances[0];
  expect(context.source.connections).toEqual([worklet]);
  expect(worklet.connections).toEqual([context.sink]);
  expect(context.sink.gain.value).toBe(0);
  expect(context.sink.connections).toEqual([context.destination]);
  await capture.stop();
});

test('reports the analysis sample rate separately from possibly resampled track settings', async () => {
  vi.spyOn(environment.tracks[0], 'getSettings').mockReturnValueOnce({ sampleRate: 44100 });
  const capture = await startCapture(['E', 'Em'], handlers());
  expect(capture.analysisSampleRate).toBe(48000);
  expect(capture.settings.sampleRate).toBe(44100);
  await capture.stop();
});

test('stop is idempotent and invalidates queued callbacks from both threads', async () => {
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  const context = FakeContext.instances[0];
  const worker = FakeWorker.instances[0];
  const worklet = FakeWorklet.instances[0];
  frame();
  const queuedWorker = worker.onmessage;
  const queuedWorklet = worklet.port.onmessage;
  await Promise.all([capture.stop(), capture.stop()]);
  queuedWorker?.({ data: result() } as MessageEvent);
  queuedWorklet?.({ data: { type: 'frame', id: 2 } } as MessageEvent);
  expect(callbacks.onObservation).not.toHaveBeenCalled();
  expect(callbacks.onLevel).not.toHaveBeenCalled();
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(worker.terminated).toBe(true);
  expect(worklet.port.closed).toBe(true);
  expect([context.source, worklet, context.sink].every((node) => node.disconnected)).toBe(true);
  expect(context.closed).toBe(true);
});

test('translates audio timestamps onto caller clock, permits only one in-flight frame and drops old results', async () => {
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  const worker = FakeWorker.instances[0];
  nowMs = 1100;
  frame(1, 10.1);
  frame(2, 10.12);
  expect(worker.sent).toHaveLength(1);
  expect(worker.sent[0]).toMatchObject({ type: 'analyze', atMs: 1100, pair: ['E', 'Em'] });
  const request = worker.sent[0] as { frame: { samples: Float32Array } };
  expect(worker.transfers[0]).toEqual([request.frame.samples.buffer]);
  worker.emit(result(99, 1100));
  expect(callbacks.onObservation).not.toHaveBeenCalled();
  worker.emit(result(1, 1100));
  expect(callbacks.onObservation).toHaveBeenCalledWith({ atMs: 1100, chord: 'E', confidence: 1 });
  nowMs = 1200;
  frame(3, 10.2);
  nowMs = 1600;
  worker.emit(result(3, 1200));
  expect(callbacks.onObservation).toHaveBeenCalledOnce();
  frame(4, 10.2);
  expect(worker.sent).toHaveLength(2);
  await capture.stop();
});

test('optional local analysis is requested and delivered only for fresh post-calibration frames', async () => {
  const callbacks = { ...handlers(), onAnalysis: vi.fn() };
  const capture = await startCapture(['E', 'Em'], callbacks);
  frame();
  const worker = FakeWorker.instances[0];
  expect(worker.sent[0]).toMatchObject({ includeAnalysis: true });
  const analysis = { features: { rms: 0.1 }, pitch: null, clipped: false };
  worker.emit({ ...result(), analysis });
  expect(callbacks.onAnalysis).toHaveBeenCalledWith({ ...analysis, atMs: 1000 });
  frame(2);
  nowMs = 1400;
  worker.emit({ ...result(2), analysis });
  expect(callbacks.onAnalysis).toHaveBeenCalledOnce();
  await capture.stop();
});

test('re-anchors once when the audio clock slips behind the caller clock but frames stay fresh', async () => {
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  const context = FakeContext.instances[0];
  const worker = FakeWorker.instances[0];
  context.currentTime = 10.1;
  nowMs = 1400;
  frame(1, 10.1);
  expect(worker.sent).toHaveLength(1);
  expect(worker.sent[0]).toMatchObject({ atMs: 1400 });
  worker.emit(result(1, 1400));
  expect(callbacks.onObservation).toHaveBeenCalledWith({ atMs: 1400, chord: 'E', confidence: 1 });
  context.currentTime = 10.2;
  nowMs = 1500;
  frame(2, 10.2);
  expect(worker.sent[1]).toMatchObject({ atMs: 1500 });
  worker.emit(result(2, 1500));
  context.currentTime = 10.6;
  nowMs = 1900;
  frame(3, 10.3);
  expect(worker.sent).toHaveLength(2);
  expect(FakeWorklet.instances[0].port.sent).toContainEqual({ type: 'ack', id: 3 });
  await capture.stop();
});

test('reports calibration without emitting observations and acknowledges analysis failures', async () => {
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  expect(callbacks.onCalibration).toHaveBeenCalledWith({ status: 'calibrating', remainingMs: 2000 });
  frame();
  FakeWorker.instances[0].emit({
    type: 'result', id: 1, rms: 0.002,
    calibration: { status: 'calibrating', remainingMs: 1800 },
  });
  expect(callbacks.onObservation).not.toHaveBeenCalled();
  expect(callbacks.onLevel).toHaveBeenCalledWith(0.002);
  expect(FakeWorklet.instances[0].port.sent).toContainEqual({ type: 'ack', id: 1 });
  frame(2);
  FakeWorker.instances[0].emit({ type: 'error', id: 2, message: 'invalid signal' });
  expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalid signal' }));
  expect(FakeWorklet.instances[0].port.sent).toContainEqual({ type: 'ack', id: 2 });
  await capture.stop();
});

test('hidden page notifies the caller synchronously to pause and never automatically reacquires', async () => {
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  environment.document.hide();
  expect(callbacks.onPause).toHaveBeenCalledWith('hidden');
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  environment.document.hidden = false;
  environment.document.dispatchEvent(new Event('visibilitychange'));
  expect(environment.getUserMedia).toHaveBeenCalledOnce();
  await capture.stop();
});

test('hiding during permission acquisition stops tracks acquired after cancellation', async () => {
  let grant: ((value: { getTracks: () => typeof environment.tracks; getAudioTracks: () => typeof environment.tracks }) => void) | undefined;
  environment.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
  const callbacks = handlers();
  const pending = startCapture(['E', 'Em'], callbacks);
  environment.document.hide();
  grant?.({ getTracks: () => environment.tracks, getAudioTracks: () => environment.tracks });
  await expect(pending).rejects.toThrow(/stopped|cancel/i);
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(FakeContext.instances[0].closed).toBe(true);
  expect(callbacks.onPause).toHaveBeenCalledWith('hidden');
});

test('hiding during worklet loading prevents any subsequent worker or node creation', async () => {
  let finishModule: (() => void) | undefined;
  FakeContext.moduleGate = new Promise((resolve) => { finishModule = resolve; });
  const callbacks = handlers();
  const pending = startCapture(['E', 'Em'], callbacks);
  await vi.waitFor(() => expect(environment.getUserMedia).toHaveBeenCalledOnce());
  environment.document.hide();
  finishModule?.();
  await expect(pending).rejects.toThrow(/stopped/i);
  expect(FakeWorklet.instances).toHaveLength(0);
  expect(FakeWorker.instances).toHaveLength(0);
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
});

test('a late setup failure after connecting the graph cleans up all owned resources', async () => {
  vi.spyOn(environment.tracks[0], 'getSettings').mockImplementationOnce(() => { throw new Error('settings failed'); });
  await expect(startCapture(['E', 'Em'], handlers())).rejects.toThrow('settings failed');
  const context = FakeContext.instances[0];
  expect([context.source, context.sink, FakeWorklet.instances[0]].every((node) => node.disconnected)).toBe(true);
  expect(FakeWorker.instances[0].terminated).toBe(true);
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  expect(context.closed).toBe(true);
});

test('an old session callback cannot enter a newly started capture', async () => {
  const callbacks = handlers();
  const first = await startCapture(['E', 'Em'], callbacks);
  frame();
  const queued = FakeWorker.instances[0].onmessage;
  await first.stop();
  const second = await startCapture(['A', 'D'], callbacks);
  queued?.({ data: result() } as MessageEvent);
  expect(callbacks.onObservation).not.toHaveBeenCalled();
  expect(callbacks.onLevel).not.toHaveBeenCalled();
  await second.stop();
});

test('sample-clock rounding of up to one rendering quantum does not discard fresh windows', async () => {
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  frame(1, 10.002);
  expect(FakeWorker.instances[0].sent).toHaveLength(1);
  FakeWorker.instances[0].emit(result(1, 1002));
  expect(callbacks.onObservation).toHaveBeenCalledWith({ atMs: 1002, chord: 'E', confidence: 1 });
  await capture.stop();
});

test('an unresponsive analysis worker is bounded by a timeout that pauses and cleans up', async () => {
  vi.useFakeTimers();
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  frame();
  await vi.advanceTimersByTimeAsync(2000);
  expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Audio analysis timed out.' }));
  expect(callbacks.onPause).toHaveBeenCalledWith('interrupted');
  expect(FakeWorker.instances[0].terminated).toBe(true);
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  await capture.stop();
});

test.each(['suspended', 'muted', 'ended', 'processor', 'worker', 'worklet-message', 'worker-message'] as const)('%s interruption surfaces and releases capture', async (kind) => {
  const callbacks = handlers();
  const capture = await startCapture(['E', 'Em'], callbacks);
  const context = FakeContext.instances[0];
  if (kind === 'suspended') {
    context.state = 'suspended';
    context.dispatchEvent(new Event('statechange'));
  } else if (kind === 'muted' || kind === 'ended') {
    environment.tracks[0].dispatchEvent(new Event(kind === 'muted' ? 'mute' : 'ended'));
  } else if (kind === 'processor') {
    FakeWorklet.instances[0].onprocessorerror?.();
  } else if (kind === 'worklet-message') {
    FakeWorklet.instances[0].port.onmessageerror?.();
  } else if (kind === 'worker-message') {
    FakeWorker.instances[0].onmessageerror?.();
  } else {
    FakeWorker.instances[0].onerror?.({ preventDefault: (): void => {} } as ErrorEvent);
  }
  expect(callbacks.onPause).toHaveBeenCalledWith('interrupted');
  expect(callbacks.onError).toHaveBeenCalledOnce();
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
  await capture.stop();
});
