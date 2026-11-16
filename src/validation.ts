import { CHORDS, type Chord } from './chords';

/** Independently observed chord label on the session's monotonic clock. */
export interface Reference {
  /** Observation time in milliseconds from the validation session start. */
  readonly atMs: number;
  /** Chord label assigned by the independent observer. */
  readonly chord: Chord;
}

/** Chord transition accepted by the detector under evaluation. */
export interface AcceptedSwitch {
  /** Acceptance time in milliseconds on the same session clock. */
  readonly atMs: number;
  /** Detected destination chord. */
  readonly chord: Chord;
}

/** Counts and gate metrics for one independently labeled validation run. */
export interface Evaluation {
  /** Number of reference transitions, excluding the establishment chord. */
  readonly actualSwitchCount: number;
  /** Number of detector events inside the run's half-open time range. */
  readonly countedSwitchCount: number;
  /** Detector events matched one-to-one with the correct reference transition. */
  readonly truePositives: number;
  /** Counted detector events that did not match an unmatched transition. */
  readonly falsePositives: number;
  /** Reference transitions without a matching detector event. */
  readonly misses: number;
  /** True positives divided by counted events, or null when none were counted. */
  readonly precision: number | null;
  /** True positives divided by actual switches; zero when there were no switches. */
  readonly recall: number;
  /** Whether the minimum sample count and both precision/recall gates are met. */
  readonly passed: boolean;
}

/** Invalid independent reference labels, event data, or session timing. */
export class ValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MINIMUM_SWITCH_COUNT = 20;
const MINIMUM_PRECISION = 0.9;
const MINIMUM_RECALL = 0.8;

/**
 * Evaluates detector events against independently labeled chord transitions.
 *
 * The first reference establishes the source chord; subsequent references
 * define alternating transitions in one canonical chord pair. Transition
 * windows are half-open, and events at the run end are excluded.
 *
 * @param references Independent labels in nondecreasing session time order.
 * @param events Accepted detector events in nondecreasing session time order.
 * @param endedAtMs Exclusive end of the session in milliseconds.
 * @returns One-to-one match counts and the precision/recall gate result.
 * @throws {ValidationError} If labels or times are invalid or out of order.
 */
export function evaluate(
  references: readonly Reference[],
  events: readonly AcceptedSwitch[],
  endedAtMs: number,
): Evaluation {
  validateInputs(references, events, endedAtMs);

  const actualSwitchCount = references.length - 1;
  const countedEvents = events.filter(({ atMs }) => atMs < endedAtMs);
  let truePositives = 0;
  let transitionIndex = 0;
  let previousMatchedTransition = -1;

  for (const event of countedEvents) {
    while (
      transitionIndex + 1 < references.length
      && references[transitionIndex + 1].atMs <= event.atMs
    ) {
      transitionIndex += 1;
    }

    if (
      transitionIndex > 0
      && transitionIndex !== previousMatchedTransition
      && event.chord === references[transitionIndex].chord
    ) {
      truePositives += 1;
      previousMatchedTransition = transitionIndex;
    }
  }

  const falsePositives = countedEvents.length - truePositives;
  const misses = actualSwitchCount - truePositives;
  const precision = countedEvents.length === 0
    ? null
    : truePositives / countedEvents.length;
  const recall = actualSwitchCount === 0 ? 0 : truePositives / actualSwitchCount;
  const passed = actualSwitchCount >= MINIMUM_SWITCH_COUNT
    && precision !== null
    && precision >= MINIMUM_PRECISION
    && recall >= MINIMUM_RECALL;

  return {
    actualSwitchCount,
    countedSwitchCount: countedEvents.length,
    truePositives,
    falsePositives,
    misses,
    precision,
    recall,
    passed,
  };
}

function validateInputs(
  references: readonly Reference[],
  events: readonly AcceptedSwitch[],
  endedAtMs: number,
): void {
  if (!Number.isFinite(endedAtMs) || endedAtMs < 0) {
    throw new ValidationError('endedAtMs must be a finite nonnegative number.');
  }
  if (references.length === 0) {
    throw new ValidationError('At least one reference is required to establish the source chord.');
  }

  let previousReferenceTime = -1;
  for (const [index, reference] of references.entries()) {
    if (!isChord(reference.chord)) {
      throw new ValidationError(`references[${index}].chord is not a supported chord label.`);
    }
    if (
      !Number.isFinite(reference.atMs)
      || reference.atMs < 0
      || reference.atMs >= endedAtMs
    ) {
      throw new ValidationError(`references[${index}].atMs must be within the session.`);
    }
    if (reference.atMs <= previousReferenceTime) {
      throw new ValidationError('Reference times must be strictly increasing.');
    }
    if (index > 0 && reference.chord === references[index - 1].chord) {
      throw new ValidationError(`references[${index}] repeats the previous chord label.`);
    }
    previousReferenceTime = reference.atMs;
  }

  const canonicalPair = new Set([references[0].chord, references[1]?.chord]);
  if (references.some(({ chord }) => !canonicalPair.has(chord))) {
    throw new ValidationError('Reference labels must stay within the established chord pair.');
  }

  let previousEventTime = -1;
  for (const [index, event] of events.entries()) {
    if (!isChord(event.chord)) {
      throw new ValidationError(`events[${index}].chord is not a supported chord label.`);
    }
    if (!Number.isFinite(event.atMs) || event.atMs < 0 || event.atMs > endedAtMs) {
      throw new ValidationError(`events[${index}].atMs must be within the session.`);
    }
    if (event.atMs < previousEventTime) {
      throw new ValidationError('Event times must be sorted in nondecreasing order.');
    }
    previousEventTime = event.atMs;
  }
}

function isChord(value: unknown): value is Chord {
  return typeof value === 'string' && Object.hasOwn(CHORDS, value);
}
