import type { Observation } from './audio/classify';
import type { Chord, Pair } from './chords';
import type { AcceptedSwitch } from './validation';

const MIN_CONFIDENCE = 0.8;
const STABLE_DURATION_MS = 180;
const MAX_EVIDENCE_GAP_MS = 120;

interface Evidence {
  readonly chord: Chord;
  readonly startedAtMs: number;
  readonly lastAtMs: number;
}

export interface Drill {
  /**
   * Process an observation.
   * @param observation A chord observation on the monotonic session clock.
   * @returns A stably confirmed switch, or null when none is accepted.
   */
  observe(observation: Observation): AcceptedSwitch | null;
  /** Stop observing and discard the current chord and pending evidence. @returns Nothing. */
  pause(): void;
  /** Start afresh, requiring a stable starting chord without a count. @returns Nothing. */
  resume(): void;
}

/**
 * Create a paused drill for a chord pair.
 * @param pair Chords between which confirmed switches are counted.
 * @returns A drill that establishes its first stable chord without counting it.
 */
export function createDrill(pair: Pair): Drill {
  let listening = false;
  let source: Chord | null = null;
  let evidence: Evidence | null = null;
  let latestAtMs = -1;

  return {
    observe(observation: Observation): AcceptedSwitch | null {
      if (!listening) return null;

      const { atMs, chord, confidence } = observation;
      const validTime = Number.isFinite(atMs) && atMs >= 0 && atMs > latestAtMs;
      if (validTime) latestAtMs = atMs;

      if (
        !validTime ||
        !Number.isFinite(confidence) ||
        confidence < MIN_CONFIDENCE ||
        confidence > 1 ||
        chord === null ||
        !pair.includes(chord) ||
        chord === source
      ) {
        evidence = null;
        return null;
      }

      if (
        evidence === null ||
        evidence.chord !== chord ||
        atMs - evidence.lastAtMs > MAX_EVIDENCE_GAP_MS
      ) {
        evidence = { chord, startedAtMs: atMs, lastAtMs: atMs };
        return null;
      }

      evidence = { ...evidence, lastAtMs: atMs };
      if (atMs - evidence.startedAtMs < STABLE_DURATION_MS) return null;

      const isSwitch = source !== null;
      source = chord;
      evidence = null;
      return isSwitch ? { atMs, chord } : null;
    },
    pause(): void {
      listening = false;
      source = null;
      evidence = null;
    },
    resume(): void {
      listening = true;
      source = null;
      evidence = null;
    },
  };
}
