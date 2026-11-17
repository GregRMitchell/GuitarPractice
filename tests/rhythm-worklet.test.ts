import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RhythmOnset } from '../src/rhythm/onset';

interface Processor {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

let processor: Processor;
const RATE = 48000;
beforeEach(async () => {
  vi.resetModules();
  class BaseProcessor {
    readonly port = { onmessage: null, postMessage: vi.fn() };
  }
  vi.stubGlobal('AudioWorkletProcessor', BaseProcessor);
  vi.stubGlobal('sampleRate', RATE);
  vi.stubGlobal('currentTime', 0);
  vi.stubGlobal('currentFrame', 0);
  vi.stubGlobal('registerProcessor', (_name: string, Constructor: new () => Processor): void => {
    processor = new Constructor();
  });
  await import('../src/rhythm/onset.worklet');
});
afterEach(() => { vi.unstubAllGlobals(); });

function render(at: number, attack: boolean): void {
  vi.stubGlobal('currentFrame', Math.round(at * RATE));
  const input = Float32Array.from({ length: 128 }, (_, index) =>
    attack ? 0.4 * Math.sin(2 * Math.PI * 220 * index / RATE) : 0);
  const output = new Float32Array(128).fill(1);
  expect(processor.process([[input]], [[output]])).toBe(true);
  expect(output.every((value) => value === 0)).toBe(true);
}

test('worklet enforces a preannounced deadline inside a render block and keeps pending messages', () => {
  processor.port.onmessage?.({ data: { type: 'deadline', atAudioTime: 1.201 } });
  render(1.2, true);
  expect(processor.port.postMessage).toHaveBeenCalledOnce();
  const onset = processor.port.postMessage.mock.calls[0][0] as RhythmOnset;
  expect(onset.atAudioTime).toBeGreaterThanOrEqual(1.2);
  expect(onset.atAudioTime).toBeLessThan(1.201);
  processor.port.onmessage?.({ data: 'ack' });
  for (let index = 0; index < 100; index += 1) render(1.21 + index * 128 / RATE, false);
  render(1.6, true);
  expect(processor.port.postMessage).toHaveBeenCalledOnce();
});

test('explicit capture stop suppresses production without clearing the queued onset', () => {
  render(1.2, true);
  expect(processor.port.postMessage).toHaveBeenCalledOnce();
  processor.port.onmessage?.({ data: { type: 'stop' } });
  processor.port.onmessage?.({ data: 'ack' });
  for (let index = 0; index < 100; index += 1) render(1.21 + index * 128 / RATE, false);
  render(1.6, true);
  expect(processor.port.postMessage).toHaveBeenCalledOnce();
});
