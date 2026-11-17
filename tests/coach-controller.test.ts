import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startCoach } from '../src/coach/controller';
import { browser, FakeWorker, FakeWorklet } from './capture-fakes';
import { extractFeatures } from '../src/audio/features';

let environment: ReturnType<typeof browser>;
let clock: number;
beforeEach(() => { environment = browser(); clock = 1000; });
afterEach(() => { vi.unstubAllGlobals(); });

test('coach stabilizes feedback, switches strings without reacquiring and stops stale callbacks', async () => {
  const onSnapshot = vi.fn();
  const coach = await startCoach('E', {
    onSnapshot, onLevel: vi.fn(), onError: vi.fn(), onPause: vi.fn(),
    onCalibration: vi.fn(), now: () => clock,
  });
  const features = extractFeatures(Float32Array.from({ length: 8192 }, (_, index) =>
    [40, 47, 52, 56, 59, 64].reduce((sum, midi) =>
      sum + 0.1 * Math.sin(2 * Math.PI * 440 * 2 ** ((midi - 69) / 12) * index / 48000), 0)), 48000);
  const worker = FakeWorker.instances[0];
  const send = (id: number, pitch: { frequency: number; confidence: number } | null): void => {
    FakeWorklet.instances[0].port.emit({ type: 'frame', id, audioTime: 10 + (clock - 1000) / 1000,
      sampleRate: 48000, samples: new Float32Array(8192) });
    worker.emit({ type: 'result', id, rms: features.rms, calibration: { status: 'ready', remainingMs: 0 },
      analysis: { features, pitch, clipped: false } });
    clock += 100;
  };
  send(1, null);
  expect(onSnapshot.mock.calls.at(-1)?.[0].assessment.status).toBe('waiting');
  send(2, null); send(3, null);
  expect(onSnapshot.mock.calls.at(-1)?.[0].assessment.status).toBe('good');
  coach.selectString(0);
  send(4, { frequency: 82.4, confidence: 1 });
  expect(onSnapshot.mock.calls.at(-1)?.[0].assessment.status).toBe('waiting');
  clock += 100;
  send(5, { frequency: 82.4, confidence: 1 });
  send(6, { frequency: 82.4, confidence: 1 });
  send(7, { frequency: 82.4, confidence: 1 });
  expect(onSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
    mode: 'string', stringIndex: 0, assessment: { status: 'good' },
  });
  expect(environment.getUserMedia).toHaveBeenCalledOnce();
  const queued = worker.onmessage;
  await coach.stop();
  const count = onSnapshot.mock.calls.length;
  queued?.({ data: { type: 'result', id: 8 } } as MessageEvent);
  expect(onSnapshot).toHaveBeenCalledTimes(count);
  expect(environment.tracks.every((track) => track.stopped)).toBe(true);
});
