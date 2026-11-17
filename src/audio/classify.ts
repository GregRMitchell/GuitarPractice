import { CHORDS } from '../chords';
import type { Chord, Pair } from '../chords';
import type { Features } from './features';

/** One accepted chord prediction or explicit rejection on the session clock. */
export interface Observation {
  /** Monotonic session timestamp in milliseconds. */
  readonly atMs: number;
  /** Recognized chord, or null when evidence is rejected. */
  readonly chord: Chord | null;
  /** Confidence in the accepted label; zero for rejection. */
  readonly confidence: number;
}

/** Optional acceptance thresholds for chord-profile matching. */
export interface ClassificationOptions {
  /** Minimum winning profile score, from 0 to 1. */
  readonly minimumScore?: number;
  /** Minimum distinctive-note evidence advantage over every competing voicing. */
  readonly minimumMargin?: number;
}

/** Default minimum winning profile score. */
export const MINIMUM_SCORE = 0.58;
/** Default minimum distinctive-note advantage over every competitor. */
export const MINIMUM_MARGIN = 0.14;
/** Relative octave energy reserved for a lower note's second harmonic. */
export const OCTAVE_HARMONIC_ALLOWANCE = 1;
/** Minimum relative octave-adjusted energy for every distinct reference pitch class. */
export const MINIMUM_CHORD_TONE_ENERGY = 0.14;

const PROFILES = Object.entries(CHORDS).map(([chord, definition]) => ({
  chord: chord as Chord, notes: definition.midiNotes, pitchClasses: definition.pitchClasses,
}));
const LOWEST_NOTE = Math.min(...PROFILES.flatMap((profile) => profile.notes));
const HIGHEST_NOTE = Math.max(...PROFILES.flatMap((profile) => profile.notes));

/**
 * Rank reference voicings by note-bin cosine similarity, then require each
 * competing voicing to lose on its distinguishing notes. Reserve octave
 * energy for a possible second harmonic before comparing those notes.
 * Require each distinct pitch class to have a sufficiently strong reference
 * fundamental; matching one occurrence of a doubled note is sufficient.
 * Reject weak, ambiguous, or out-of-pair evidence rather than forcing a label.
 * @param features Polyphonic pitch evidence from `extractFeatures`.
 * @param pair The two distinct candidate chords.
 * @param atMs Monotonic session timestamp in milliseconds.
 * @param options Optional voicing similarity and distinctive-note thresholds.
 * @returns A confident chord observation, or a null-chord rejection.
 */
export function classify(
  features: Features,
  pair: Pair,
  atMs: number,
  options: ClassificationOptions = {},
): Observation {
  if (
    pair.length !== 2 ||
    pair[0] === pair[1] ||
    !Object.hasOwn(CHORDS, pair[0]) ||
    !Object.hasOwn(CHORDS, pair[1]) ||
    !Number.isFinite(atMs) ||
    atMs < 0
  ) {
    throw new RangeError('A distinct chord pair and non-negative timestamp are required.');
  }
  const minimumScore = options.minimumScore ?? MINIMUM_SCORE;
  const minimumMargin = options.minimumMargin ?? MINIMUM_MARGIN;
  if (
    !Number.isFinite(minimumScore) ||
    minimumScore < 0 ||
    minimumScore > 1 ||
    !Number.isFinite(minimumMargin) ||
    minimumMargin < 0 ||
    minimumMargin > 1
  ) {
    throw new RangeError('Classification thresholds must be between zero and one.');
  }

  const energies = features.noteEnergies;
  const evidenceNorm = Math.sqrt(Array.from({ length: HIGHEST_NOTE - LOWEST_NOTE + 1 },
    (_, index) => (energies[LOWEST_NOTE + index - features.midiMin] ?? 0) ** 2)
    .reduce((sum, value) => sum + value, 0));
  const scores = PROFILES.map((profile) => ({
    ...profile,
    score: voicingScore(energies, features.midiMin, profile.notes, evidenceNorm),
  })).sort((left, right) => right.score - left.score);
  const winner = scores[0];
  const inPair = pair.includes(winner.chord);
  const margin = Math.min(...scores.slice(1).map((other) =>
    distinctiveAdvantage(energies, features.midiMin, winner.notes, other.notes)));
  const accepted = features.rms > features.noiseFloorRms
    && inPair
    && winner.score >= minimumScore
    && winner.pitchClasses.every((pitchClass) => winner.notes.some((note) =>
      note % 12 === pitchClass && fundamentalEvidence(energies, features.midiMin, note) >= MINIMUM_CHORD_TONE_ENERGY))
    && margin > 0
    && margin >= minimumMargin;
  const confidence = accepted
    ? Math.min(1, 0.8 + ((margin - minimumMargin) / Math.max(0.01, 1 - minimumMargin)) * 0.2)
    : 0;
  return { atMs, chord: accepted ? winner.chord : null, confidence };
}

function fundamentalEvidence(energies: readonly number[], midiMin: number, note: number): number {
  const energy = energies[note - midiMin] ?? 0;
  const lower = energies[note - 12 - midiMin] ?? 0;
  return Math.max(0, energy - OCTAVE_HARMONIC_ALLOWANCE * lower);
}

function voicingScore(energies: readonly number[], midiMin: number, notes: readonly number[], norm: number): number {
  if (norm === 0) return 0;
  return notes.reduce((sum, note) => sum + (energies[note - midiMin] ?? 0), 0)
    / (norm * Math.sqrt(notes.length));
}

function distinctiveAdvantage(
  energies: readonly number[], midiMin: number, candidate: readonly number[], competitor: readonly number[],
): number {
  const meanUnique = (notes: readonly number[], other: readonly number[]): number => {
    const unique = notes.filter((note) => !other.includes(note));
    return unique.length === 0 ? 0
      : unique.reduce((sum, note) => sum + fundamentalEvidence(energies, midiMin, note), 0) / unique.length;
  };
  return meanUnique(candidate, competitor) - meanUnique(competitor, candidate);
}
