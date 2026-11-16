import { FRAME_SAMPLES, HOP_SAMPLES } from './capture-protocol';
import type { AudioFrame, FrameAck } from './capture-protocol';

// Module-local declarations keep the worklet realm out of the DOM/Worker globals.
declare abstract class AudioWorkletProcessor {
  readonly port: {
    onmessage: ((event: { data: FrameAck }) => void) | null;
    postMessage(frame: AudioFrame, transfer: ArrayBuffer[]): void;
  };
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: typeof CaptureProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly ring = new Float32Array(FRAME_SAMPLES);
  private writeIndex = 0;
  private filled = 0;
  private sinceWindow = 0;
  private nextId = 0;
  private outstanding: number | null = null;

  constructor() {
    super();
    this.port.onmessage = ({ data }: { data: FrameAck }): void => {
      if (data.type === 'ack' && data.id === this.outstanding) this.outstanding = null;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.ring[this.writeIndex] = channel[index];
      this.writeIndex = (this.writeIndex + 1) % FRAME_SAMPLES;
      this.filled = Math.min(FRAME_SAMPLES, this.filled + 1);
      this.sinceWindow += 1;
      if (this.filled < FRAME_SAMPLES || this.sinceWindow < HOP_SAMPLES) continue;
      this.sinceWindow = 0;
      if (this.outstanding !== null) continue;
      const samples = new Float32Array(FRAME_SAMPLES);
      const tail = this.ring.subarray(this.writeIndex);
      samples.set(tail);
      samples.set(this.ring.subarray(0, this.writeIndex), tail.length);
      this.outstanding = ++this.nextId;
      const frame: AudioFrame = {
        type: 'frame', id: this.outstanding, samples, sampleRate,
        audioTime: (currentFrame + index + 1) / sampleRate,
      };
      this.port.postMessage(frame, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('guitar-capture', CaptureProcessor);
