import { startRhythm, type RhythmOptions, type RhythmSession, type RhythmSnapshot } from '../rhythm/controller';
import type { PracticeResult } from '../history/model';
import { progressionDuration, type ProgressionPlan } from './timeline';

/** Observable play-along state, containing only prompts and timing summaries. */
export interface ProgressionState {
  readonly phase: 'idle' | 'starting' | 'calibrating' | 'count-in' | 'playing' | 'finalizing' | 'stopping' | 'finished' | 'error';
  readonly plan: ProgressionPlan | null;
  readonly snapshot: RhythmSnapshot | null;
  readonly message: string;
}

/** Callbacks and injectable audio boundary for a non-resumable play-along. */
export interface ProgressionControllerOptions {
  readonly changed: () => void;
  readonly completed: (record: PracticeResult) => void;
  readonly startRhythm?: typeof startRhythm;
}

/** Coordinate an audio-clock exercise, its cancellation, and its single retained summary. */
export function createProgressionController(options: ProgressionControllerOptions) {
  let state: ProgressionState = { phase: 'idle', plan: null, snapshot: null, message: '' };
  let generation = 0;
  let session: RhythmSession | null = null;
  let pending: Promise<void> | null = null;
  let stopping: Promise<RhythmSnapshot | undefined> | null = null;
  let abort: AbortController | null = null;
  const patch = (update: Partial<ProgressionState>): void => { state = { ...state, ...update }; options.changed(); };
  const active = (): boolean => !['idle', 'finished', 'error'].includes(state.phase);
  const stop = (): Promise<RhythmSnapshot | undefined> => {
    if (stopping) return stopping;
    const handle = session;
    session = null;
    stopping = handle ? handle.stop() : Promise.resolve(undefined);
    return stopping;
  };
  const reset = async (message = 'Play-along discarded. Start again for a fresh count-in.'): Promise<void> => {
    if (!active()) return;
    const token = ++generation;
    abort?.abort();
    patch({ phase: 'stopping', message: 'Stopping audio…' });
    await stop();
    await pending;
    if (token !== generation) return;
    abort = null;
    patch({ phase: 'idle', snapshot: null, message });
  };
  const finish = async (natural = false): Promise<void> => {
    if (!active() || state.phase === 'stopping' || (!natural && state.phase === 'finalizing')) return;
    const token = ++generation;
    const plan = state.plan;
    const last = state.snapshot;
    patch({ phase: 'stopping', message: 'Finishing and switching audio off…' });
    const stopped = await stop();
    abort?.abort();
    await pending;
    if (token !== generation || !plan) return;
    abort = null;
    const value = stopped ?? last;
    if (!value || value.elapsedSeconds <= 0) {
      patch({ phase: 'idle', snapshot: null, message: 'Count-in ended. No practice round saved.' }); return;
    }
    const targetMs = progressionDuration(plan) * 1000;
    const duration = natural ? targetMs : Math.min(targetMs, value.elapsedSeconds * 1000);
    const { timingMeasured, expected, estimatedStrums, matched, missed, extra, meanAbsoluteOffsetMs } = value.summary;
    options.completed({ mode: 'progression', sequence: plan.sequence, bpm: plan.bpm,
      barsPerChord: plan.barsPerChord, loops: plan.loops, activeMs: duration, targetMs,
      completed: duration === targetMs, patternId: value.patternId, audible: value.audible,
      soundMode: value.soundMode, timingMeasured, expected, estimatedStrums, matched, missed, extra,
      meanAbsoluteOffsetMs, tracking: timingMeasured ? 'microphone' : 'guided' });
    patch({ phase: 'finished', snapshot: value, message: 'Play-along ended. Audio is off.' });
  };
  return {
    /** Return the current immutable-style render state. */
    state: (): ProgressionState => state,
    /** Whether setup, practice or cleanup is still in progress. */
    active,
    /** Clear a finished preview without removing its saved record. */
    clear(): void { if (!active()) state = { phase: 'idle', plan: null, snapshot: null, message: '' }; },
    /** Start from a trusted gesture; audio is allocated before this method returns. */
    start(plan: ProgressionPlan, config: RhythmOptions): Promise<void> {
      if (active()) return Promise.resolve();
      const token = ++generation;
      const fixedPlan = { ...plan, sequence: Object.freeze([...plan.sequence]) };
      stopping = null; session = null; abort = new AbortController();
      patch({ phase: 'starting', plan: fixedPlan, snapshot: null, message: 'Starting your metronome…' });
      let finishedBeforeHandle = false;
      const result = (options.startRhythm ?? startRhythm)({ ...config, bpm: plan.bpm,
        durationSeconds: progressionDuration(fixedPlan), signal: abort.signal }, {
        onChanged(value): void {
          if (token !== generation) return;
          if (value.phase === 'stopped' || value.phase === 'paused' || value.phase === 'error') return;
          if (value.phase === 'finished') {
            patch({ phase: 'finalizing', snapshot: value, message: 'Finishing play-along…' });
            if (session) void finish(true);
            else finishedBeforeHandle = true;
            return;
          }
          patch({ phase: value.phase, snapshot: value, message: value.phase === 'finalizing'
            ? 'Finishing timing estimates…' : value.phase === 'calibrating'
              ? 'Timing calibration. Keep quiet.' : '' });
        },
        onPause(): void { if (token === generation) void reset('Play-along interrupted and discarded.'); },
        onError(): void { if (token === generation) void reset('Audio unavailable. Check permission and try again.'); },
      });
      pending = result.then(async (handle) => {
        if (token !== generation) { await handle.stop(); return; }
        session = handle;
        if (finishedBeforeHandle) queueMicrotask(() => { if (token === generation) void finish(true); });
      }).catch(() => {
        if (token === generation) { abort = null; patch({ phase: 'error', message: 'Audio unavailable. Check permission and try again.' }); }
      });
      return pending;
    },
    /** Save positive playing time, or discard a count-in-only attempt. */
    finish: (): Promise<void> => finish(),
    /** Abort and discard, including pending permission and natural finalization. */
    reset,
  };
}
