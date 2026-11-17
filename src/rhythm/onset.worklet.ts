import { OnsetDetector } from './onset';
import type { RhythmOnset } from './onset';

// Keep worklet globals module-local, including when compiled with the DOM app.
declare abstract class AudioWorkletProcessor {
  readonly port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: RhythmOnset): void;
  };
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: typeof RhythmOnsetProcessor): void;

class RhythmOnsetProcessor extends AudioWorkletProcessor {
  private readonly detector = new OnsetDetector(sampleRate, currentTime + 1);
  private outstanding = false;
  private deadline = Infinity;
  private capturing = true;
  private readonly emit = (onset: RhythmOnset): void => {
    if (this.outstanding || onset.atAudioTime >= this.deadline) return;
    this.outstanding = true;
    this.port.postMessage(onset);
  };

  constructor() {
    super();
    this.port.onmessage = ({ data }): void => {
      if (data === 'ack') { this.outstanding = false; return; }
      if (typeof data !== 'object' || data === null) return;
      const message = data as { type?: unknown; atAudioTime?: unknown };
      if (message.type === 'stop') this.capturing = false;
      if (message.type === 'deadline' && typeof message.atAudioTime === 'number'
        && Number.isFinite(message.atAudioTime)) this.deadline = message.atAudioTime;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channel = inputs[0]?.[0];
    if (channel && this.capturing) {
      const start = currentFrame / sampleRate;
      const length = Math.max(0, Math.min(channel.length, Math.ceil((this.deadline - start) * sampleRate)));
      if (length > 0) this.detector.process(channel.subarray(0, length), start, this.emit);
    }
    return true;
  }
}

registerProcessor('rhythm-onset', RhythmOnsetProcessor);
