import type { Chord } from '../chords';
import { startCoach, type CoachCapture, type CoachSnapshot } from '../coach/controller';
import { startRhythm, type RhythmOptions, type RhythmSession, type RhythmSnapshot } from '../rhythm/controller';
import type { Calibration } from '../audio/capture-protocol';
import type { PracticeResult } from '../history/model';

const ROUND_MS = 60_000;

/** Observable UI state; engine observations remain ephemeral and local. */
export interface ModesState {
  readonly mode: 'coach' | 'rhythm';
  readonly phase: 'idle' | 'starting' | 'calibrating' | 'count-in' | 'running' | 'finalizing' | 'stopping' | 'finished' | 'error';
  readonly chord: Chord;
  readonly elapsedMs: number;
  readonly coach: CoachSnapshot | null;
  readonly rhythm: RhythmSnapshot | null;
  readonly calibration: Calibration | null;
  readonly message: string;
}

/** Injectable gesture-bound engines, monotonic clock and local summary sink. */
export interface ModesOptions {
  readonly changed: () => void;
  readonly completed: (record: PracticeResult) => void;
  readonly now?: () => number;
  readonly startCoach?: typeof startCoach;
  readonly startRhythm?: typeof startRhythm;
}

/**
 * Coordinate non-resumable coaching/rhythm rounds and cancellation during async setup.
 * @param options Engine boundaries, render callback and summary sink.
 * @returns Start, selection, finish and discard controls; start calls engines before awaiting.
 */
export function createModesController(options: ModesOptions) {
  let state: ModesState = { mode: 'coach', phase: 'idle', chord: 'A', elapsedMs: 0,
    coach: null, rhythm: null, calibration: null, message: '' };
  let epoch = 0;
  let coach: CoachCapture | null = null;
  let rhythm: RhythmSession | null = null;
  let pending: Promise<void> | null = null;
  let stopping: Promise<RhythmSnapshot | undefined> | null = null;
  let abort: AbortController | null = null;
  let startedAt: number | null = null;
  const now = options.now ?? (() => performance.now());
  const patch = (value: Partial<ModesState>): void => {
    state = { ...state, ...value }; options.changed();
  };
  const active = (): boolean => !['idle', 'finished', 'error'].includes(state.phase);
  const stop = (): Promise<RhythmSnapshot | undefined> => {
    if (stopping) return stopping;
    const oldCoach = coach;
    const oldRhythm = rhythm;
    coach = null; rhythm = null;
    stopping = Promise.all([oldCoach?.stop(), oldRhythm?.stop()]).then((result) => result[1]);
    return stopping;
  };
  const reset = async (message = 'Round reset and discarded. Tap Start for a fresh minute.'): Promise<void> => {
    if (!active()) return;
    const token = ++epoch;
    abort?.abort(); abort = null;
    patch({ phase: 'stopping', message: 'Stopping audio…' });
    await stop();
    await pending;
    if (epoch !== token) return;
    startedAt = null;
    patch({ phase: 'idle', elapsedMs: 0, coach: null, rhythm: null, calibration: null, message });
  };
  const fail = (token: number): void => {
    if (token !== epoch) return;
    void reset('Audio stopped. Check microphone permission and audio availability, then tap Start to retry.')
      .then(() => patch({ phase: 'error' }));
  };
  const finish = async (): Promise<void> => {
    if (!active() || state.phase === 'stopping' || state.phase === 'finalizing') return;
    const current = state;
    let elapsedMs = current.mode === 'coach' && startedAt !== null
      ? Math.min(ROUND_MS, Math.max(0, now() - startedAt)) : current.elapsedMs;
    const token = ++epoch;
    patch({ phase: 'stopping', message: 'Finishing and switching audio off…' });
    const lastRhythm = await stop();
    abort?.abort(); abort = null;
    await pending;
    if (epoch !== token) return;
    if (lastRhythm) elapsedMs = lastRhythm.elapsedSeconds * 1000;
    if (elapsedMs <= 0) {
      patch({ phase: 'idle', message: 'Count-in / calibration ended. No practice round saved.' }); return;
    }
    const duration = Math.min(ROUND_MS, elapsedMs);
    const common = { activeMs: duration, targetMs: ROUND_MS, completed: duration === ROUND_MS };
    if (current.mode === 'coach') {
      options.completed({ ...common, mode: 'coach', targetChord: current.chord,
        confirmations: current.coach?.overallConfirmations ?? 0,
        successfulStrings: current.coach?.successfulStrings ?? [], tracking: 'microphone' });
    } else {
      const value = lastRhythm ?? current.rhythm;
      if (value) {
        const { timingMeasured, expected, estimatedStrums, matched, missed, extra, meanAbsoluteOffsetMs } = value.summary;
        options.completed({ ...common, mode: 'rhythm', heldChord: current.chord,
          bpm: value.bpm, patternId: value.patternId, audible: value.audible, timingMeasured,
          soundMode: value.soundMode,
          expected, estimatedStrums, matched, missed, extra, meanAbsoluteOffsetMs,
          tracking: timingMeasured ? 'microphone' : 'guided' });
      }
    }
    patch({ phase: 'finished', elapsedMs: duration, rhythm: lastRhythm ?? current.rhythm,
      message: 'Nice practice! Audio off. Check the local save status above.' });
  };
  const begin = (mode: ModesState['mode'], chord: Chord): number | null => {
    if (active()) return null;
    const token = ++epoch;
    stopping = null;
    startedAt = null;
    patch({ mode, chord, phase: 'starting', elapsedMs: 0, coach: null, rhythm: null,
      calibration: null, message: mode === 'coach' ? 'Requesting microphone permission…' : 'Starting your metronome…' });
    return token;
  };
  return {
    /** Return the latest render state. */
    state: (): ModesState => state,
    /** Include setup and resource teardown in navigation/update locks. */
    active,
    /** Clear an inactive preview without touching already retained history. */
    clear(): void {
      if (active()) return;
      state = { ...state, phase: 'idle', elapsedMs: 0, coach: null, rhythm: null,
        calibration: null, message: '' };
    },
    /** Start coach capture directly from the trusted click, with no preceding await. */
    startCoach(chord: Chord): Promise<void> {
      const token = begin('coach', chord);
      if (token === null) return Promise.resolve();
      const result = (options.startCoach ?? startCoach)(chord, {
        now,
        onSnapshot: (value): void => {
          if (epoch !== token) return;
          if (startedAt !== null && now() - startedAt >= ROUND_MS) { void finish(); return; }
          patch({ coach: value });
        },
        onCalibration: (value): void => {
          if (epoch !== token) return;
          if (value.status === 'calibrating' && startedAt !== null) {
            void reset('Capture interrupted. Round discarded; tap Start to recalibrate.'); return;
          }
          if (value.status === 'ready') {
            if (startedAt === null) startedAt = now();
            patch({ calibration: value, phase: 'running', message: 'Your minute starts now. Strum when ready!' });
          } else patch({ calibration: value, phase: 'calibrating', message: 'Calibrating. Stay quiet until ready.' });
        },
        onLevel: (): void => {},
        onError: (): void => fail(token),
        onPause: (): void => { if (epoch === token) void reset('Microphone interrupted. Round discarded; tap Start to try again.'); },
      });
      pending = result.then(async (value) => {
        if (epoch !== token) await value.stop();
        else coach = value;
      }).catch(() => { fail(token); });
      return pending;
    },
    /** Start guided metronome by default; optional timing microphone must be explicitly enabled. */
    startRhythm(chord: Chord, config: RhythmOptions): Promise<void> {
      const token = begin('rhythm', chord);
      if (token === null) return Promise.resolve();
      abort = new AbortController();
      const result = (options.startRhythm ?? startRhythm)({ bpm: 80, patternId: 'quarters',
        audible: true, soundMode: 'beat', microphone: false, ...config, signal: abort.signal }, {
        onChanged: (value): void => {
          if (epoch !== token) return;
          const phase = value.phase === 'playing' ? 'running'
            : value.phase === 'finished' ? 'running'
              : value.phase === 'finalizing' ? 'finalizing'
                : value.phase === 'count-in' ? 'count-in' : 'calibrating';
          patch({ rhythm: value, phase, elapsedMs: value.elapsedSeconds * 1000,
            message: value.phase === 'finalizing' ? 'Finishing timing estimates… Audio is stopping.'
              : value.phase === 'count-in' ? `Count in · ${value.countInRemaining}`
              : value.phase === 'calibrating' ? 'Timing calibration. Keep quiet for a second.'
                : 'Follow the pattern. Easy shoulders, steady pulse.' });
          if (value.phase === 'finished') void finish();
        },
        onPause: (): void => { if (epoch === token) void reset('Practice interrupted. Round discarded; tap Start for a fresh count-in.'); },
        onError: (): void => fail(token),
      });
      pending = result.then(async (value) => {
        if (epoch !== token) await value.stop();
        else rhythm = value;
      }).catch(() => { fail(token); });
      return pending;
    },
    /** Select one physical string explicitly; never auto-advance. */
    selectString(index: number): void { coach?.selectString(index); },
    /** Return to the overall chord assessment using the same microphone. */
    selectOverall(): void { coach?.selectOverall(); },
    /** Refresh the coach wall-clock deadline; rhythm uses its own audio clock. */
    tick(): void {
      if (state.mode !== 'coach' || state.phase !== 'running' || startedAt === null) return;
      const elapsedMs = Math.min(ROUND_MS, Math.max(0, now() - startedAt));
      patch({ elapsedMs });
      if (elapsedMs >= ROUND_MS) void finish();
    },
    /** Save a positive-duration early or natural finish, never setup-only time. */
    finish,
    /** Stop and discard, including a capture handle that arrives after cancellation. */
    reset,
  };
}

/** Public mode coordinator surface. */
export type ModesController = ReturnType<typeof createModesController>;
