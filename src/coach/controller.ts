import { CHORDS, type Chord, type Pair } from '../chords';
import { startCapture, type Capture, type CaptureHandlers } from '../audio/capture';
import type { TimedAnalysis } from '../audio/capture-protocol';
import { FRAME_SAMPLES } from '../audio/capture-protocol';
import { assessOverall, assessString, stringTargets, type Assessment, type StringTarget } from './assessment';

const STABLE_FRAMES = 3;
const MAX_FRAME_GAP_MS = 1000;

/** Snapshot of one local, ephemeral coaching session. */
export interface CoachSnapshot {
  /** Chord whose reference voicing is being practiced. */
  readonly chord: Chord;
  /** Overall strum or explicitly selected isolated string. */
  readonly mode: 'overall' | 'string';
  /** Selected physical string, low E = 0, or null in overall mode. */
  readonly stringIndex: number | null;
  /** Six reference string targets in low-to-high order. */
  readonly targets: readonly StringTarget[];
  /** Stable, cautious feedback. */
  readonly assessment: Assessment;
  /** Number of separate stable overall confirmations in this session. */
  readonly overallConfirmations: number;
  /** Unique physical strings with a stable matching isolated-note observation. */
  readonly successfulStrings: readonly number[];
}

/** Callbacks invoked on the main thread; callers must not throw. */
export interface CoachHandlers extends Omit<CaptureHandlers, 'onObservation' | 'onAnalysis'> {
  /** Receives snapshots when stable feedback or selection changes. */
  onSnapshot(value: CoachSnapshot): void;
}

/** One local coaching capture session. */
export interface CoachCapture extends Capture {
  /** Switch to whole-chord listening without reacquiring the microphone. */
  selectOverall(): void;
  /** Select a physical string, low E = 0 through high E = 5; muted strings are skipped. */
  selectString(index: number): void;
}

const WAITING: Assessment = { status: 'waiting', title: 'Waiting for a strum', tip: 'Strum the chord when ready.' };

/**
 * Start calibration and local chord coaching directly in a visible user gesture.
 * @param chord Supported chord to coach.
 * @param handlers Snapshot, calibration, level, error, pause and optional clock callbacks.
 * @returns Capture controls and explicit mode/string selection.
 * @throws Invalid chord, permission, unsupported browser, cancellation or setup errors.
 */
export async function startCoach(chord: Chord, handlers: CoachHandlers): Promise<CoachCapture> {
  if (!Object.hasOwn(CHORDS, chord)) throw new RangeError('Unsupported chord.');
  const alternate = (Object.keys(CHORDS) as Chord[]).find((candidate) => candidate !== chord)!;
  const pair: Pair = [chord, alternate];
  const now = handlers.now ?? ((): number => performance.now());
  const targets = stringTargets(chord);
  let selection: number | null = null;
  let selectedAt = -Infinity;
  let active = true;
  let assessment = WAITING;
  let previousKey = '';
  let stableFrames = 0;
  let lastAt = -Infinity;
  let overallConfirmations = 0;
  const successes = new Set<number>();
  const publish = (): void => handlers.onSnapshot({
    chord, mode: selection === null ? 'overall' : 'string', stringIndex: selection,
    targets, assessment, overallConfirmations, successfulStrings: [...successes].sort((a, b) => a - b),
  });
  const reset = (): void => { previousKey = ''; stableFrames = 0; lastAt = -Infinity; };
  const select = (index: number | null): void => {
    if (!active) return;
    if (index !== null && (!Number.isInteger(index) || index < 0 || index >= targets.length)) {
      throw new RangeError('Select a string from 0 to 5.');
    }
    selection = index;
    selectedAt = now() + FRAME_SAMPLES / capture.analysisSampleRate * 1000;
    reset();
    assessment = index === null ? WAITING : assessString(chord, index, null, false);
    publish();
  };
  const onAnalysis = (value: TimedAnalysis): void => {
    if (!active || value.atMs <= selectedAt) return;
    const overall = assessOverall(chord, value.features, value.clipped);
    const stringAssessment = selection === null ? null : assessString(chord, selection, value.pitch, value.clipped);
    const next = stringAssessment?.status === 'muted' ? stringAssessment
      : selection === null || overall.status === 'warning' ? overall : stringAssessment!;
    if (value.atMs <= lastAt || value.atMs - lastAt > MAX_FRAME_GAP_MS) reset();
    lastAt = value.atMs;
    const key = `${next.status}:${next.title}`;
    if (next.status === 'waiting' || next.status === 'muted' || next.status === 'warning') {
      reset();
      if (assessment.status !== next.status || assessment.title !== next.title) {
        assessment = next; publish();
      }
      return;
    }
    if (key !== previousKey) { previousKey = key; stableFrames = 1; }
    else stableFrames += 1;
    if (stableFrames !== STABLE_FRAMES) return;
    if (next.status === 'good') {
      if (selection === null) overallConfirmations += 1;
      else successes.add(selection);
    }
    assessment = next;
    publish();
  };
  const capture = await startCapture(pair, {
    ...handlers,
    onObservation: (): void => {},
    onAnalysis,
    onCalibration: (value): void => {
      if (value.status === 'calibrating') {
        reset();
        const waiting = selection === null ? WAITING : assessString(chord, selection, null, false);
        if (assessment.status !== waiting.status || assessment.title !== waiting.title) {
          assessment = waiting;
          publish();
        }
      }
      handlers.onCalibration(value);
    },
    onPause: (reason): void => { active = false; handlers.onPause(reason); },
  });
  publish();
  return {
    analysisSampleRate: capture.analysisSampleRate, settings: capture.settings,
    selectOverall: (): void => select(null),
    selectString: (index): void => select(index),
    stop: (): Promise<void> => { active = false; return capture.stop(); },
  };
}
