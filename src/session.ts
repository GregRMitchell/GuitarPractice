import type { Capture, CaptureHandlers, Calibration } from './audio/capture';
import type { Observation } from './audio/classify';
import { CHORDS, type Chord, type Pair } from './chords';
import { createDrill } from './drill';
import type { Reference, AcceptedSwitch } from './validation';

/** Separate pair and zero-false-switch control protocols. */
export type RunMode = 'pair' | 'silence' | 'speech' | 'same-chord';
/** Immutable configuration for one uninterrupted attempt. */
export interface RunConfig {
  readonly pair: Pair;
  readonly mode: RunMode;
  readonly independent: boolean;
}
/** Metadata and labels only: never retains PCM or an observation history. */
export interface SessionSnapshot {
  readonly phase: 'idle' | 'starting' | 'calibrating' | 'ready' | 'running' | 'paused' | 'finished';
  readonly config: RunConfig;
  readonly discarded: boolean;
  readonly discardCount: number;
  readonly elapsedMs: number;
  readonly references: readonly Reference[];
  readonly events: readonly AcceptedSwitch[];
  readonly calibration: Calibration | null;
  readonly settings: MediaTrackSettings;
  readonly analysisSampleRate: number | null;
  readonly level: number;
  readonly prediction: Observation | null;
  readonly source: Chord | null;
  readonly sourceAtStart: Chord | null;
  readonly error: string;
}
/** Browser boundaries supplied by the UI; capture must be called on the trusted click stack. */
export interface SessionOptions {
  readonly now: () => number;
  readonly startCapture: (pair: Pair, handlers: CaptureHandlers) => Promise<Capture>;
  readonly changed: () => void;
}
/** Lifecycle and independent labeling actions for one local validation screen. */
export interface Session {
  /** Start a fresh attempt using config synchronously; returns setup/handled-failure completion. */
  start(config: RunConfig): Promise<void>;
  /** Discard this attempt for reason, release capture, and require explicit restart. Returns nothing. */
  pause(reason: string): void;
  /** Freeze the current uninterrupted run and release capture. */
  finish(): void;
  /** Confirm the actual chord now; first confirmation defines time zero. Returns nothing. */
  confirm(chord: Chord): void;
  /** Begin exploratory timing or a source-established control; never generates pair labels. */
  begin(): void;
  /** Return a detached metadata snapshot, with current uninterrupted elapsed time. */
  snapshot(): SessionSnapshot;
}

/**
 * Create a session controller without browser globals or persistent storage.
 * @param options Shared monotonic clock, capture factory, and nonthrowing render notification.
 * @returns A controller that rejects stale callbacks and discards interrupted evidence.
 */
export function createSession(options: SessionOptions): Session {
  let config: RunConfig = { pair: ['A', 'D'], mode: 'pair', independent: true };
  let phase: SessionSnapshot['phase'] = 'idle';
  let drill = createDrill(config.pair);
  let capture: Capture | undefined;
  let generation = 0;
  let origin: number | null = null;
  let elapsedMs = 0;
  let references: Reference[] = [];
  let events: AcceptedSwitch[] = [];
  let calibration: Calibration | null = null;
  let settings: MediaTrackSettings = {};
  let analysisSampleRate: number | null = null;
  let level = 0;
  let prediction: Observation | null = null;
  let sourceAtStart: Chord | null = null;
  let discarded = false;
  let discardCount = 0;
  let error = '';

  const notify = (): void => options.changed();
  const clearEvidence = (): void => {
    origin = null; elapsedMs = 0; references = []; events = [];
    prediction = null; sourceAtStart = null; drill.pause();
  };
  const release = (): void => {
    generation += 1;
    const token = generation;
    const previous = capture;
    capture = undefined;
    if (previous) void previous.stop().catch(() => {
      if (token !== generation) return;
      error = 'Microphone cleanup failed. Close this page before continuing.'; notify();
    });
  };
  const discard = (): void => {
    discarded = true; discardCount += 1; clearEvidence();
  };
  const pause = (reason: string): void => {
    if (phase === 'idle' || phase === 'finished' || phase === 'paused') return;
    discard(); release(); phase = 'paused'; level = 0;
    error = `Run discarded (${reason}). Resume starts a new attempt with fresh calibration.`;
    notify();
  };
  const setOrigin = (): void => {
    origin = options.now(); elapsedMs = 0; events = []; references = [];
    prediction = null; discarded = false; phase = 'running';
  };
  return {
    start(next: RunConfig): Promise<void> {
      if (!['idle', 'paused', 'finished'].includes(phase)) return Promise.resolve();
      if (next.pair[0] === next.pair[1] || !next.pair.every((chord) => Object.hasOwn(CHORDS, chord))) {
        error = 'Choose two different supported chords.'; notify(); return Promise.resolve();
      }
      release(); config = { ...next, pair: [...next.pair] };
      drill = createDrill(config.pair); clearEvidence();
      settings = {}; analysisSampleRate = null; calibration = null;
      discarded = false; error = ''; level = 0;
      phase = 'starting';
      const token = generation;
      const active = (): boolean => token === generation;
      let errorReported = false;
      const fail = (failure: Error): void => {
        if (errorReported) return;
        if (!active()) {
          if (phase === 'paused' && generation === token + 1) {
            errorReported = true;
            error = `${failure.message} Run discarded; resume starts a new attempt.`; notify();
          }
          return;
        }
        errorReported = true;
        pause('capture error'); error = failure.message; notify();
      };
      const handlers: CaptureHandlers = {
        now: options.now,
        onError: fail,
        onPause: (reason) => { if (active()) pause(reason); },
        onLevel: (rms) => { if (active()) { level = rms; notify(); } },
        onCalibration: (value) => {
          if (!active()) return;
          if (value.status === 'calibrating') {
            if (phase === 'running' || phase === 'ready') discard();
            phase = 'calibrating';
          } else if (phase === 'starting' || phase === 'calibrating') {
            phase = 'ready'; drill.resume();
          }
          calibration = { ...value }; notify();
        },
        onObservation: (value) => {
          if (!active() || calibration?.status !== 'ready'
            || (phase !== 'ready' && phase !== 'running')
            || value.atMs > options.now()
            || (origin !== null && value.atMs <= origin)) return;
          prediction = { ...value };
          const event = drill.observe(value);
          if (phase === 'running' && event && origin !== null) {
            events.push({ ...event, atMs: event.atMs - origin });
          }
          notify();
        },
      };
      notify();
      // No await or microtask before invoking capture: preserve transient user activation.
      try {
        return options.startCapture(config.pair, handlers).then((value) => {
          if (!active()) {
            void value.stop().catch(() => {}); return;
          }
          capture = value; settings = { ...value.settings };
          analysisSampleRate = value.analysisSampleRate; notify();
        }).catch(fail);
      } catch (failure: unknown) {
        fail(failure instanceof Error ? failure : new Error('Microphone startup failed.'));
        return Promise.resolve();
      }
    },
    pause,
    finish(): void {
      if (phase === 'idle' || phase === 'finished') return;
      elapsedMs = origin === null ? 0 : Math.max(0, options.now() - origin);
      release(); drill.pause(); level = 0; phase = 'finished'; notify();
    },
    confirm(chord: Chord): void {
      if (config.mode !== 'pair' || !config.independent || !config.pair.includes(chord)) return;
      if (phase === 'ready') {
        setOrigin(); drill.pause(); drill.resume();
        references.push({ chord, atMs: 0 });
      } else if (phase === 'running' && origin !== null) {
        const atMs = options.now() - origin;
        const previous = references.at(-1);
        if (previous?.chord === chord || atMs <= (previous?.atMs ?? 0)) return;
        references.push({ chord, atMs });
      }
      notify();
    },
    begin(): void {
      if (phase !== 'ready') return;
      if (config.mode === 'pair') {
        if (config.independent) return;
        setOrigin(); drill.pause(); drill.resume();
      } else {
        if (drill.source !== config.pair[0]) return;
        sourceAtStart = drill.source;
        setOrigin(); drill.discardPending();
      }
      notify();
    },
    snapshot(): SessionSnapshot {
      return {
        phase, config: { ...config, pair: [...config.pair] }, discarded, discardCount,
        elapsedMs: phase === 'running' && origin !== null ? Math.max(0, options.now() - origin) : elapsedMs,
        references: references.map((value) => ({ ...value })),
        events: events.map((value) => ({ ...value })), calibration: calibration && { ...calibration },
        settings: { ...settings }, analysisSampleRate, level, prediction: prediction && { ...prediction },
        source: drill.source, sourceAtStart, error,
      };
    },
  };
}
