export type Chord = 'A' | 'Am' | 'C' | 'D' | 'Dm' | 'E' | 'Em' | 'G';
export type Pair = readonly [Chord, Chord];

export interface ChordDefinition {
  readonly pitchClasses: readonly number[];
  readonly midiNotes: readonly number[];
}
