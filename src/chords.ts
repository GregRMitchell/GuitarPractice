/** Supported chord labels for the standard-tuned exercise. */
export type Chord = keyof typeof CHORDS;
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
export const CHORDS = Object.freeze({
  A: defineChord([45, 52, 57, 61, 64]),
  Am: defineChord([45, 52, 57, 60, 64]),
  C: defineChord([48, 52, 55, 60, 64]),
  D: defineChord([50, 57, 62, 66]),
  Dm: defineChord([50, 57, 62, 65]),
  E: defineChord([40, 47, 52, 56, 59, 64]),
  Em: defineChord([40, 47, 52, 55, 59, 64]),
  G: defineChord([43, 47, 50, 55, 59, 67]),
  A7: defineChord([45, 52, 55, 61, 64]),
  Am7: defineChord([45, 52, 55, 60, 64]),
  C7: defineChord([48, 52, 58, 60, 64]),
  D7: defineChord([50, 57, 60, 66]),
  E7: defineChord([40, 47, 50, 56, 59, 64]),
  Em7: defineChord([40, 47, 50, 55, 59, 64]),
  G7: defineChord([43, 47, 50, 55, 59, 65]),
  Asus2: defineChord([45, 52, 57, 59, 64]),
  Asus4: defineChord([45, 52, 57, 62, 64]),
  Dsus2: defineChord([50, 57, 62, 64]),
  Dsus4: defineChord([50, 57, 62, 67]),
  F: defineChord([41, 48, 53, 57, 60, 65]),
  Bm: defineChord([47, 54, 59, 62, 66]),
});
