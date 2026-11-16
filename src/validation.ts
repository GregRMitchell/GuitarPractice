import type { Chord } from './chords';

export interface Reference {
  readonly atMs: number;
  readonly chord: Chord;
}

export interface AcceptedSwitch {
  readonly atMs: number;
  readonly chord: Chord;
}
