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
  A7: [45, 52, 55, 61, 64], Am7: [45, 52, 55, 60, 64],
  C7: [48, 52, 58, 60, 64], D7: [50, 57, 60, 66],
  E7: [40, 47, 50, 56, 59, 64], Em7: [40, 47, 50, 55, 59, 64],
  G7: [43, 47, 50, 55, 59, 65], Asus2: [45, 52, 57, 59, 64],
  Asus4: [45, 52, 57, 62, 64], Dsus2: [50, 57, 62, 64],
  Dsus4: [50, 57, 62, 67], F: [41, 48, 53, 57, 60, 65],
  Bm: [47, 54, 59, 62, 66],
};

/** Generate a deterministic decaying, harmonic-rich chord for signal tests. */
export function synthesizeChord(
  chord: Chord,
  sampleRate: number,
  gain = 0.5,
  durationSeconds = 8192 / sampleRate,
  includedNotes: readonly number[] = MIDI_NOTES[chord],
  secondHarmonic = 0.5,
): Float32Array {
  const samples = new Float32Array(Math.ceil(sampleRate * durationSeconds));
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    const decay = Math.exp(-time * 2.5);
    let value = 0;
    for (const midi of includedNotes) {
      const fundamental = 440 * 2 ** ((midi - 69) / 12);
      for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
        value += Math.sin(2 * Math.PI * fundamental * harmonic * time)
          * (gain * decay) * (harmonic === 2 ? secondHarmonic : 1 / harmonic) / MIDI_NOTES[chord].length;
      }
    }
    samples[index] = value;
  }
  return samples;
}
