import type { Chord } from '../chords';

export interface Observation {
  readonly atMs: number;
  readonly chord: Chord | null;
  readonly confidence: number;
}
