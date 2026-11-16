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
  /** Minimum separation between the best and runner-up chord profiles. */
  readonly minimumMargin?: number;
}

/** Default minimum winning profile score. */
export const MINIMUM_SCORE = 0.58;
/** Default minimum separation from the runner-up profile. */
export const MINIMUM_MARGIN = 0.14;
/** Weight applied to energy outside the candidate chord. */
export const OUT_OF_CHORD_PENALTY = 0.35;

/**
 * Classify extracted spectral evidence against an active pair, rejecting weak,
 * ambiguous, or out-of-pair chords rather than forcing a label.
 * @param features Polyphonic pitch evidence from `extractFeatures`.
 * @param pair The two distinct candidate chords.
 * @param atMs Monotonic session timestamp in milliseconds.
 * @param options Optional score and winner-separation thresholds.
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

  const scores = Object.entries(CHORDS)
    .map(([chord, definition]) => ({
      chord: chord as Chord,
      score: chordScore(features.pitchClassEnergies, definition.pitchClasses),
    }))
    .sort((left, right) => right.score - left.score);
  const winner = scores[0];
  const runnerUp = scores[1];
  const inPair = pair.includes(winner.chord);
  const pairScore = Math.max(...pair.map((chord) => (
    chordScore(features.pitchClassEnergies, CHORDS[chord].pitchClasses)
  )));
  const margin = winner.score - runnerUp.score;
  const accepted = features.rms > features.noiseFloorRms
    && inPair
    && winner.score >= minimumScore
    && pairScore >= minimumScore
    && margin > 0
    && margin >= minimumMargin;
  const confidence = accepted
    ? Math.min(1, 0.8 + ((margin - minimumMargin) / Math.max(0.01, 1 - minimumMargin)) * 0.2)
    : 0;
  return { atMs, chord: accepted ? winner.chord : null, confidence };
}

function chordScore(energies: readonly number[], pitchClasses: readonly number[]): number {
  const expected = new Set(pitchClasses);
  const inChord = pitchClasses.reduce((sum, pitchClass) => sum + (energies[pitchClass] ?? 0), 0)
    / pitchClasses.length;
  const outOfChord = energies.reduce(
    (sum, energy, pitchClass) => sum + (expected.has(pitchClass) ? 0 : energy),
    0,
  ) / (12 - expected.size);
  return Math.max(0, inChord - OUT_OF_CHORD_PENALTY * outOfChord);
}
