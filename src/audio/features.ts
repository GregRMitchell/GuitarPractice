const MIDI_MIN = 36;
const MIDI_MAX = 84;
const DEFAULT_NOISE_FLOOR_RMS = 0.001;

/** Optional integration settings for signal feature extraction. */
export interface FeatureOptions {
  /** RMS floor measured during calibration; lower-energy frames become silence. */
  readonly noiseFloorRms?: number;
}

/** Spectral evidence from one mono audio frame. */
export interface Features {
  /** Root-mean-square amplitude after removing DC offset. */
  readonly rms: number;
  /** The extraction floor used to zero low-level pitch evidence. */
  readonly noiseFloorRms: number;
  /** Relative energy for C through B, normalized so the strongest class is 1. */
  readonly pitchClassEnergies: readonly number[];
  /** Relative spectral magnitude at each MIDI fundamental bin, offset by `midiMin`. */
  readonly noteEnergies: readonly number[];
  /** MIDI value represented by `noteEnergies[0]`. */
  readonly midiMin: number;
}

/**
 * Extract normalized polyphonic pitch evidence from one in-memory audio frame.
 * @param samples Mono PCM samples; practical windows are 8192 samples or larger.
 * @param sampleRate Samples per second.
 * @param options Optional calibrated silence threshold.
 * @returns RMS, note, and pitch-class energy features.
 */
export function extractFeatures(
  samples: Float32Array,
  sampleRate: number,
  options: FeatureOptions = {},
): Features {
  const noiseFloorRms = options.noiseFloorRms ?? DEFAULT_NOISE_FLOOR_RMS;
  if (
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(noiseFloorRms) ||
    noiseFloorRms < 0 ||
    [...samples].some((sample) => !Number.isFinite(sample))
  ) {
    throw new RangeError('Signal frame, sample rate, and noise floor must be valid.');
  }

  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const centered = Float64Array.from(samples, (sample) => sample - mean);
  const rms = Math.sqrt(centered.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  const emptyNotes = Array<number>(MIDI_MAX - MIDI_MIN + 1).fill(0);
  if (rms <= noiseFloorRms) {
    return { rms, noiseFloorRms, pitchClassEnergies: Array<number>(12).fill(0), noteEnergies: emptyNotes, midiMin: MIDI_MIN };
  }

  const fftSize = nextPowerOfTwo(samples.length);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  for (let index = 0; index < samples.length; index += 1) {
    const window = samples.length === 1
      ? 1
      : 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (samples.length - 1));
    real[index] = centered[index] * window;
  }
  fft(real, imaginary);

  const noteEnergies = emptyNotes;
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi += 1) {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    if (frequency >= sampleRate / 2) continue;
    const bin = (frequency * fftSize) / sampleRate;
    const center = Math.round(bin);
    noteEnergies[midi - MIDI_MIN] = Math.hypot(real[center], imaginary[center]);
  }

  const maxEnergy = Math.max(...noteEnergies);
  if (maxEnergy === 0) {
    return { rms, noiseFloorRms, pitchClassEnergies: Array<number>(12).fill(0), noteEnergies: emptyNotes, midiMin: MIDI_MIN };
  }
  for (let index = 0; index < noteEnergies.length; index += 1) {
    noteEnergies[index] /= maxEnergy;
  }

  const pitchClassEnergies = Array<number>(12).fill(0);
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi += 1) {
    const pitchClass = midi % 12;
    pitchClassEnergies[pitchClass] = Math.max(
      pitchClassEnergies[pitchClass],
      noteEnergies[midi - MIDI_MIN],
    );
  }
  return { rms, noiseFloorRms, pitchClassEnergies, noteEnergies, midiMin: MIDI_MIN };
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    while ((reversed & bit) !== 0) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let width = 2; width <= size; width *= 2) {
    const angle = (-2 * Math.PI) / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += width) {
      let factorReal = 1;
      let factorImaginary = 0;
      const halfWidth = width / 2;
      for (let offset = 0; offset < halfWidth; offset += 1) {
        const even = start + offset;
        const odd = even + halfWidth;
        const productReal = factorReal * real[odd] - factorImaginary * imaginary[odd];
        const productImaginary = factorReal * imaginary[odd] + factorImaginary * real[odd];
        real[odd] = real[even] - productReal;
        imaginary[odd] = imaginary[even] - productImaginary;
        real[even] += productReal;
        imaginary[even] += productImaginary;
        const nextFactorReal = factorReal * stepReal - factorImaginary * stepImaginary;
        factorImaginary = factorReal * stepImaginary + factorImaginary * stepReal;
        factorReal = nextFactorReal;
      }
    }
  }
}
