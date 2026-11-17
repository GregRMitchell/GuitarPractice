/** Compact local-only onset; time is in the AudioContext clock domain. */
export interface RhythmOnset { readonly atAudioTime: number; readonly strength: number }

/**
 * Sample-level amplitude/positive-flux envelope detector with 80ms refractory time.
 * Quiet calibration estimates the noise floor. Sustained tone is not a new strum.
 * This is a timing estimate, not a chord/direction recognizer.
 */
export class OnsetDetector {
  private readonly fastDecay: number;
  private readonly slowDecay: number;
  private readonly noiseDecay: number;
  private fast = 0;
  private slow = 0;
  private noise = 0;
  private previous = 0;
  private flux = 0;
  private last = -Infinity;
  private armed = true;
  private readonly calibrationEnd: number;

  /** Construct for a sample rate and absolute audio-clock calibration deadline. */
  constructor(private readonly rate: number, calibrationEnd: number) {
    if (!Number.isFinite(rate) || rate < 8000 || !Number.isFinite(calibrationEnd)) {
      throw new Error('Invalid onset detector clock.');
    }
    this.calibrationEnd = calibrationEnd;
    this.fastDecay = Math.exp(-1 / (rate * 0.003));
    this.slowDecay = Math.exp(-1 / (rate * 0.06));
    this.noiseDecay = Math.exp(-1 / (rate * 0.08));
  }

  /** Consume a render block without retaining audio; emit only compact attacks. */
  process(samples: Float32Array, startTime: number, emit: (onset: RhythmOnset) => void): void {
    if (!Number.isFinite(startTime)) return;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Number.isFinite(samples[index]) ? Math.min(1, Math.abs(samples[index])) : 0;
      const atAudioTime = startTime + index / this.rate;
      const delta = Math.max(0, sample - this.previous);
      this.previous = sample;
      this.fast = this.fastDecay * this.fast + (1 - this.fastDecay) * sample;
      this.slow = this.slowDecay * this.slow + (1 - this.slowDecay) * sample;
      this.flux = this.fastDecay * this.flux + (1 - this.fastDecay) * delta;
      const calibrating = atAudioTime < this.calibrationEnd;
      if (calibrating || this.fast < this.noise * 2 + 0.004) {
        this.noise = this.noiseDecay * this.noise + (1 - this.noiseDecay) * sample;
      }
      const threshold = Math.max(0.008, this.noise * 4);
      if (this.fast < Math.max(threshold * 0.65, this.slow * 1.12)) this.armed = true;
      if (!calibrating && this.armed && atAudioTime - this.last >= 0.08
        && this.fast > threshold && this.fast > this.slow * 1.5 && this.flux > threshold * 0.015) {
        this.last = atAudioTime;
        this.armed = false;
        emit({ atAudioTime, strength: this.fast });
      }
    }
  }
}
