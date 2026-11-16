/** Supported chord labels for the standard-tuned open-chord exercise. */
export type Chord = 'A' | 'Am' | 'C' | 'D' | 'Dm' | 'E' | 'Em' | 'G';
/** The two distinct chord labels being compared in one exercise. */
export type Pair = readonly [Chord, Chord];

/** MIDI-note and pitch-class profile for one supported chord. */
export interface ChordDefinition {
  /** Unique pitch classes represented by the MIDI voicing. */
  readonly pitchClasses: readonly number[];
  /** MIDI notes in the reference open-position voicing. */
  readonly midiNotes: readonly number[];
}

const defineChord = (midiNotes: readonly number[]): ChordDefinition => ({
  midiNotes: Object.freeze([...midiNotes]),
  pitchClasses: Object.freeze([...new Set(midiNotes.map((midiNote) => midiNote % 12))]),
});

/** Standard-tuning open-position note profiles for the supported chords. */
export const CHORDS: Readonly<Record<Chord, ChordDefinition>> = Object.freeze({
  A: defineChord([45, 52, 57, 61, 64]),
  Am: defineChord([45, 52, 57, 60, 64]),
  C: defineChord([48, 52, 55, 60, 64]),
  D: defineChord([50, 57, 62, 66]),
  Dm: defineChord([50, 57, 62, 65]),
  E: defineChord([40, 47, 52, 56, 59, 64]),
  Em: defineChord([40, 47, 52, 55, 59, 64]),
  G: defineChord([43, 47, 50, 55, 59, 67]),
});
