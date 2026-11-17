/** A locally estimated isolated-note fundamental, not a string identification. */
export interface PitchEstimate {
  /** Fundamental frequency in hertz. */
  readonly frequency: number;
  /** Periodicity confidence between zero and one. */
  readonly confidence: number;
}

const MIN_FREQUENCY = 65;
const MAX_FREQUENCY = 1000;
const YIN_THRESHOLD = 0.15;
const MIN_CONFIDENCE = 0.8;
const COMPARISON_SAMPLES = 2048;

/**
 * Estimate an isolated note using YIN's normalized difference function.
 * @param samples Mono PCM held inside the worker.
 * @param sampleRate Audio sample rate in hertz.
 * @param noiseFloorRms Calibrated ambient RMS.
 * @returns A periodic fundamental and confidence, or null when unpitched/quiet.
 */
export function estimatePitch(samples: Float32Array, sampleRate: number, noiseFloorRms: number): PitchEstimate | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(noiseFloorRms)
      || noiseFloorRms < 0 || samples.length < 4) return null;
  let sum = 0;
  let squared = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return null;
    sum += sample;
    squared += sample * sample;
  }
  const rms = Math.sqrt(Math.max(0, squared / samples.length - (sum / samples.length) ** 2));
  if (rms <= Math.max(0.003, noiseFloorRms * 2)) return null;
  const maxLag = Math.min(Math.floor(sampleRate / MIN_FREQUENCY), Math.floor(samples.length / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQUENCY));
  if (maxLag <= minLag) return null;
  const count = Math.min(COMPARISON_SAMPLES, samples.length - maxLag);
  const normalized = new Float64Array(maxLag + 1);
  let running = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let difference = 0;
    for (let i = 0; i < count; i += 1) {
      const delta = samples[i] - samples[i + lag];
      difference += delta * delta;
    }
    running += difference;
    normalized[lag] = running === 0 ? 1 : difference * lag / running;
  }
  let chosen = 0;
  for (let lag = minLag; lag < maxLag; lag += 1) {
    if (normalized[lag] < YIN_THRESHOLD) {
      while (lag + 1 <= maxLag && normalized[lag + 1] < normalized[lag]) lag += 1;
      chosen = lag;
      break;
    }
  }
  if (!chosen || 1 - normalized[chosen] < MIN_CONFIDENCE) return null;
  let refined = chosen;
  if (chosen > 1 && chosen < maxLag) {
    const left = normalized[chosen - 1];
    const middle = normalized[chosen];
    const right = normalized[chosen + 1];
    const denominator = left - 2 * middle + right;
    if (denominator !== 0) refined += 0.5 * (left - right) / denominator;
  }
  return { frequency: sampleRate / refined, confidence: Math.max(0, Math.min(1, 1 - normalized[chosen])) };
}
