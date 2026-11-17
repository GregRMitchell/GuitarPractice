import { classify } from './classify';
import { extractFeatures } from './features';
import { CALIBRATION_MS } from './capture-protocol';
import type { AnalysisReply, AnalysisRequest, Calibration } from './capture-protocol';
import { estimatePitch } from '../coach/pitch';

interface AnalysisEndpoint {
  onmessage: ((event: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage(value: AnalysisReply): void;
}

const endpoint = globalThis as unknown as AnalysisEndpoint;
let calibrationStart: number | undefined;
let previousAtMs: number | undefined;
let squaredRmsSum = 0;
let calibrationFrames = 0;
let noiseFloorRms: number | undefined;

function resetCalibration(): void {
  calibrationStart = undefined;
  previousAtMs = undefined;
  squaredRmsSum = 0;
  calibrationFrames = 0;
  noiseFloorRms = undefined;
}

endpoint.onmessage = ({ data }: MessageEvent<AnalysisRequest>): void => {
  const { frame, pair, atMs } = data;
  try {
    const windowMs = frame.samples.length / frame.sampleRate * 1000;
    if (!Number.isFinite(atMs) || atMs < 0) throw new RangeError('Invalid capture timestamp.');
    if (previousAtMs !== undefined
      && (atMs <= previousAtMs || atMs - previousAtMs > windowMs)) {
      resetCalibration();
    }
    previousAtMs = atMs;
    const features = extractFeatures(frame.samples, frame.sampleRate, { noiseFloorRms: noiseFloorRms ?? 0 });
    if (noiseFloorRms === undefined) {
      calibrationStart ??= atMs - windowMs;
      squaredRmsSum += features.rms ** 2;
      calibrationFrames += 1;
      const remainingMs = Math.max(0, CALIBRATION_MS - (atMs - calibrationStart));
      if (remainingMs === 0) noiseFloorRms = Math.sqrt(squaredRmsSum / calibrationFrames);
      const calibration: Calibration = {
        status: remainingMs === 0 ? 'ready' : 'calibrating', remainingMs,
        ...(noiseFloorRms === undefined ? {} : { noiseFloorRms }),
      };
      endpoint.postMessage({ type: 'result', id: frame.id, rms: features.rms, calibration });
      return;
    }
    endpoint.postMessage({
      type: 'result', id: frame.id, rms: features.rms,
      calibration: { status: 'ready', remainingMs: 0, noiseFloorRms },
      observation: classify(features, pair, atMs),
      ...(data.includeAnalysis ? {
        analysis: {
          features,
          pitch: estimatePitch(frame.samples, frame.sampleRate, noiseFloorRms),
          clipped: frame.samples.some((sample) => Math.abs(sample) >= 0.99),
        },
      } : {}),
    });
  } catch (error: unknown) {
    resetCalibration();
    endpoint.postMessage({
      type: 'error', id: frame.id,
      message: error instanceof Error ? error.message : 'Audio analysis failed.',
    });
  }
};
endpoint.postMessage({ type: 'ready' });
