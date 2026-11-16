import type { Chord } from '../src/chords';

const MIDI_NOTES: Readonly<Record<Chord, readonly number[]>> = {
  A: [45, 52, 57, 61, 64],
  Am: [45, 52, 57, 60, 64],
  C: [48, 52, 55, 60, 64],
  D: [50, 57, 62, 66],
  Dm: [50, 57, 62, 65],
  E: [40, 47, 52, 56, 59, 64],
  Em: [40, 47, 52, 55, 59, 64],
  G: [43, 47, 50, 55, 59, 67],
};

/** Generate a deterministic decaying, harmonic-rich chord for signal tests. */
export function synthesizeChord(
  chord: Chord,
  sampleRate: number,
  gain = 0.5,
  durationSeconds = 8192 / sampleRate,
): Float32Array {
  const samples = new Float32Array(Math.ceil(sampleRate * durationSeconds));
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    const decay = Math.exp(-time * 2.5);
    let value = 0;
    for (const midi of MIDI_NOTES[chord]) {
      const fundamental = 440 * 2 ** ((midi - 69) / 12);
      for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
        value += Math.sin(2 * Math.PI * fundamental * harmonic * time)
          * (gain * decay) / (harmonic * MIDI_NOTES[chord].length);
      }
    }
    samples[index] = value;
  }
  return samples;
}
