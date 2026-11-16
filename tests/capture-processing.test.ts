import { afterEach, expect, test, vi } from 'vitest';
import { FakePort } from './capture-fakes';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test('real worklet emits bounded latest windows, waits for ack, stamps sample time and outputs silence', async () => {
  let Processor: (new () => {
    port: FakePort;
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  }) | undefined;
  vi.stubGlobal('AudioWorkletProcessor', class { readonly port = new FakePort(); });
  vi.stubGlobal('registerProcessor', (_name: string, value: typeof Processor): void => { Processor = value; });
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('currentFrame', 480000);
  await import('../src/audio/capture.worklet');
  if (!Processor) throw new Error('Processor was not registered');
  const processor = new Processor();
  let sampleIndex = 0;
  const render = (blocks: number, value: number): void => {
    for (let block = 0; block < blocks; block += 1) {
      vi.stubGlobal('currentFrame', 480000 + sampleIndex);
      const output = new Float32Array(128).fill(1);
      expect(processor.process([[new Float32Array(128).fill(value)]], [[output]])).toBe(true);
      expect(output.every((sample) => sample === 0)).toBe(true);
      sampleIndex += 128;
    }
  };
  render(64, 1);
  expect(processor.port.sent).toHaveLength(1);
  const first = processor.port.sent[0] as { id: number; audioTime: number; samples: Float32Array };
  expect(first.samples).toHaveLength(8192);
  expect(processor.port.transfers[0]).toEqual([first.samples.buffer]);
  expect(first.audioTime).toBeCloseTo(10 + 8192 / 48000);
  render(96, 2);
  expect(processor.port.sent).toHaveLength(1);
  processor.port.emit({ type: 'ack', id: first.id + 99 });
  render(32, 3);
  expect(processor.port.sent).toHaveLength(1);
  processor.port.emit({ type: 'ack', id: first.id });
  render(32, 4);
  expect(processor.port.sent).toHaveLength(2);
  const latest = processor.port.sent[1] as typeof first;
  expect(latest.samples[0]).toBe(3);
  expect(latest.samples[8191]).toBe(4);
  expect(latest.audioTime).toBeCloseTo(10 + sampleIndex / 48000);
});

type Reply = {
  type: string;
  id: number;
  calibration?: { status: string; remainingMs: number; noiseFloorRms?: number };
  observation?: { atMs: number; chord: string | null };
  message?: string;
};

async function analysisWorker(): Promise<{
  replies: Reply[];
  send: (id: number, atMs: number, samples?: Float32Array) => Reply;
}> {
  const replies: Reply[] = [];
  vi.stubGlobal('postMessage', (reply: Reply): void => { replies.push(reply); });
  vi.stubGlobal('onmessage', null);
  await import('../src/audio/analysis.worker');
  expect(replies[0]).toEqual({ type: 'ready' });
  const send = (id: number, atMs: number, samples: Float32Array = new Float32Array(8192)): Reply => {
    const endpoint = globalThis as unknown as { onmessage: (event: MessageEvent) => void };
    endpoint.onmessage({ data: {
      type: 'analyze', pair: ['E', 'Em'], atMs,
      frame: { type: 'frame', id, audioTime: atMs / 1000, sampleRate: 8192, samples },
    } } as MessageEvent);
    return replies[replies.length - 1];
  };
  return { replies, send };
}

test('real worker requires two seconds of contiguous quiet calibration and applies measured RMS floor', async () => {
  const { send } = await analysisWorker();
  const noise = Float32Array.from({ length: 8192 }, (_, index) => index % 2 ? 0.002 : -0.002);
  expect(send(1, 1000, noise)).toMatchObject({
    type: 'result', calibration: { status: 'calibrating', remainingMs: 1000 },
  });
  expect(send(2, 1500, noise).observation).toBeUndefined();
  const ready = send(3, 2000, noise);
  expect(ready.calibration?.status).toBe('ready');
  expect(ready.calibration?.noiseFloorRms).toBeCloseTo(0.002);
  expect(ready.observation).toBeUndefined();
  expect(send(4, 2500, noise).observation).toEqual({ atMs: 2500, chord: null, confidence: 0 });
});

test('worker restarts calibration on missing audio rather than counting interrupted wall time', async () => {
  const { send } = await analysisWorker();
  send(1, 1000);
  expect(send(2, 4000)).toMatchObject({
    calibration: { status: 'calibrating', remainingMs: 1000 },
  });
  expect(send(3, 4500).observation).toBeUndefined();
  expect(send(4, 5000).calibration?.status).toBe('ready');
});

test('even a short uncovered sample gap restarts quiet calibration', async () => {
  const { send } = await analysisWorker();
  send(1, 1000);
  expect(send(2, 2100)).toMatchObject({
    calibration: { status: 'calibrating', remainingMs: 1000 },
  });
});

test('worker completes failed analysis with an error response, never a fabricated observation', async () => {
  const { send } = await analysisWorker();
  const invalid = new Float32Array(8192);
  invalid[0] = NaN;
  const reply = send(7, 1000, invalid);
  expect(reply).toMatchObject({ type: 'error', id: 7 });
  expect(reply.message).toMatch(/valid/i);
  expect(reply.observation).toBeUndefined();
  expect(send(8, 2000).calibration?.status).toBe('calibrating');
});
