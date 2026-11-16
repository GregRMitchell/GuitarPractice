import type { Pair } from '../chords';
import type { Observation } from './classify';

/** Quiet-room calibration progress; ready does not imply recognition accuracy. */
export interface Calibration {
  readonly status: 'calibrating' | 'ready';
  readonly remainingMs: number;
  readonly noiseFloorRms?: number;
}

/** One bounded mono window, timestamped at its last sample on the audio clock. */
export interface AudioFrame {
  readonly type: 'frame';
  readonly id: number;
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly audioTime: number;
}

/** Main-thread request, with audio time translated onto the shared session clock. */
export interface AnalysisRequest {
  readonly type: 'analyze';
  readonly frame: AudioFrame;
  readonly pair: Pair;
  readonly atMs: number;
}

/** Every analyzed frame completes with a result or an explicit failure. */
export type AnalysisReply =
  | { readonly type: 'ready' }
  | { readonly type: 'error'; readonly id: number; readonly message: string }
  | {
    readonly type: 'result';
    readonly id: number;
    readonly rms: number;
    readonly calibration: Calibration;
    readonly observation?: Observation;
  };

/** Releases the worklet's single outstanding transfer slot. */
export interface FrameAck {
  readonly type: 'ack';
  readonly id: number;
}

export const FRAME_SAMPLES = 8192;
export const HOP_SAMPLES = 4096;
export const CALIBRATION_MS = 2000;
