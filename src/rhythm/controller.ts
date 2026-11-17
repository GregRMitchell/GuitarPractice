import { createRhythmAudio } from './audio';
import type { RhythmAudio } from './audio';
import type { RhythmOnset } from './onset';
import { rhythmPattern } from './patterns';
import type { RhythmPattern } from './patterns';
import { expectedStrokes, MAX_RHYTHM_SECONDS, summarizeTiming } from './scoring';
import type { TimingSummary } from './scoring';

/** Beat clicks or tones describing the exercise's intended strum direction. */
export type RhythmSoundMode = 'beat' | 'strums';

/** Fixed exercise options. Controls must remain locked until stopped. */
export interface RhythmOptions {
  readonly bpm?: number;
  /** Active playing duration in seconds; defaults to 60 and excludes count-in. */
  readonly durationSeconds?: number;
  readonly patternId?: RhythmPattern['id'];
  readonly audible?: boolean;
  /** Quarter beat clicks by default; strums sounds only the pattern's strokes. */
  readonly soundMode?: RhythmSoundMode;
  readonly microphone?: boolean;
  /** Required explicitly when using both microphone and audible clicks. */
  readonly headphonesAcknowledged?: boolean;
  /** Abort pending permission/setup or active practice when leaving the mode. */
  readonly signal?: AbortSignal;
}

/** Readonly local summary. UI adds its one heldChord; never a switch count. */
export interface RhythmSnapshot {
  readonly phase: 'calibrating' | 'count-in' | 'playing' | 'finalizing' | 'finished' | 'stopped' | 'paused' | 'error';
  readonly bpm: number;
  readonly patternId: RhythmPattern['id'];
  readonly audible: boolean;
  readonly soundMode: RhythmSoundMode;
  readonly targetSeconds: number;
  readonly elapsedSeconds: number;
  readonly countInRemaining: number;
  readonly activeSlot: number | null;
  readonly beat: number | null;
  readonly bar: number | null;
  readonly summary: TimingSummary;
}

/** Main-thread callbacks must not throw. Paused sessions require an explicit new start. */
export interface RhythmHandlers {
  /** Render the audio-clock snapshot; timing is uncalibrated and cannot judge direction/chords. */
  onChanged(snapshot: RhythmSnapshot): void;
  /** Already stopped; this session will never automatically resume. */
  onPause(reason: 'hidden' | 'interrupted'): void;
  /** Already stopped; setup failures also reject startRhythm. */
  onError(error: Error): void;
}

/** One non-resumable exercise, owning its AudioContext and optional mic resources. */
export interface RhythmSession {
  /** Latest immutable snapshot, with no raw audio. */
  readonly snapshot: RhythmSnapshot;
  /** Cancel immediately, including pending finalization; no drain on explicit stop. */
  stop(): Promise<RhythmSnapshot>;
}

/** Injectable clock/audio boundary. Browser integration normally omits this argument. */
export type RhythmAudioFactory = typeof createRhythmAudio;
const TARGET_SECONDS = 60;
const LOOKAHEAD_SECONDS = 0.1;
const TICK_MS = 25;
const SETUP_TIMEOUT_MS = 15000;
/** Maximum accepted age and bounded natural-completion message drain. */
export const MAX_FRAME_AGE_MS = 250;

/**
 * Call directly from a trusted click (before awaiting anything else).
 * Defaults: 80 BPM, quarter downstrokes, audible beat clicks, no microphone.
 * Strums sound mode replaces exercise beat clicks with low down/high up tones.
 * Mic is opt-in; audible mic use requires an explicit headphone acknowledgement.
 * A quiet second precedes one 4/4 count-in bar; the exercise defaults to 60s.
 * signal abort rejects pending setup with AbortError, without onError/onPause.
 * Natural microphone completion publishes finalizing before its final finished summary.
 * @returns A session after setup; permission/setup errors reject with onError.
 */
export async function startRhythm(
  options: RhythmOptions, handlers: RhythmHandlers, factory: RhythmAudioFactory = createRhythmAudio,
): Promise<RhythmSession> {
  const aborted = (): DOMException => new DOMException('Strumming practice cancelled.', 'AbortError');
  if (options.signal?.aborted) throw aborted();
  const bpm = options.bpm ?? 80;
  const targetSeconds = options.durationSeconds ?? TARGET_SECONDS;
  const pattern = rhythmPattern(options.patternId ?? 'quarters');
  const audible = options.audible !== false;
  const microphone = options.microphone === true;
  const soundMode = options.soundMode === undefined ? 'beat' : options.soundMode;
  if (soundMode !== 'beat' && soundMode !== 'strums') throw new Error('Choose a supported sound mode.');
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 160) throw new Error('Tempo must be between 40 and 160 BPM.');
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0 || targetSeconds > MAX_RHYTHM_SECONDS) {
    throw new Error('Practice duration must be positive and at most 30 minutes.');
  }
  if (microphone && audible && options.headphonesAcknowledged !== true) {
    throw new Error('Acknowledge wearing headphones, or mute clicks, before enabling microphone timing.');
  }
  const beatSeconds = 60 / bpm;
  const slotSeconds = beatSeconds / 2;
  let audio: RhythmAudio | undefined;
  let running = true;
  let ready = false;
  let finalizing = false;
  let countInAt = Infinity;
  let playingAt = Infinity;
  let nextSlot = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: Promise<void> | undefined;
  let cancelSetup: ((error: Error) => void) | undefined;
  let lastOnset = -Infinity;
  const onsets: number[] = [];
  let snapshot: RhythmSnapshot = Object.freeze({
    phase: 'calibrating', bpm, patternId: pattern.id, audible, soundMode, targetSeconds,
    elapsedSeconds: 0, countInRemaining: 4, activeSlot: null, beat: null, bar: null,
    summary: Object.freeze(summarizeTiming([], microphone ? [] : null, bpm)),
  });

  const publish = (phase: RhythmSnapshot['phase']): void => {
    const now = audio?.now ?? 0;
    const elapsedSeconds = phase === 'finished' ? targetSeconds : Math.min(targetSeconds, Math.max(0, now - playingAt));
    const origin = phase === 'playing' ? playingAt : countInAt;
    const step = Math.max(0, Math.floor((now - origin) / slotSeconds));
    const visual = phase === 'count-in' || phase === 'playing';
    snapshot = Object.freeze({
      phase, bpm, patternId: pattern.id, audible, soundMode, targetSeconds, elapsedSeconds,
      countInRemaining: phase === 'count-in' ? Math.min(4, Math.max(0, 4 - Math.floor((now - countInAt) / beatSeconds))) : 0,
      activeSlot: visual ? step % 8 : null, beat: visual ? Math.floor(step % 8 / 2) + 1 : null,
      bar: phase === 'playing' ? Math.floor(step / 8) + 1 : null,
      summary: Object.freeze(summarizeTiming(expectedStrokes(pattern, bpm, elapsedSeconds), microphone ? onsets : null, bpm)),
    });
    handlers.onChanged(snapshot);
  };
  const end = (phase: RhythmSnapshot['phase'], cancellation?: Error): Promise<void> => {
    if (!running) return cleanup ?? Promise.resolve();
    running = false;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    cancelSetup?.(cancellation ?? new Error('Strumming practice stopped during setup.'));
    cleanup = audio?.close() ?? Promise.resolve();
    publish(phase);
    return cleanup;
  };
  const abort = (): void => { void end('stopped', aborted()); };
  const fail = (error: Error): void => {
    if (!running) return;
    void end('error');
    handlers.onError(error);
  };
  const pause = (reason: 'hidden' | 'interrupted'): void => {
    if (!running) return;
    void end('paused');
    handlers.onPause(reason);
  };
  const onset = (value: RhythmOnset): void => {
    if (!running || !ready || !microphone || !audio) return;
    const time = value.atAudioTime;
    if (!Number.isFinite(time) || time < playingAt || time >= playingAt + targetSeconds
      || time > audio.now || time < audio.now - MAX_FRAME_AGE_MS / 1000 || time - lastOnset < 0.08) return;
    lastOnset = time;
    onsets.push(time - playingAt);
  };
  const tick = (): void => {
    if (!running || !audio) return;
    try {
      const now = audio.now;
      const deadline = playingAt + targetSeconds;
      if (now >= deadline) {
        if (!microphone) { void end('finished'); return; }
        if (!finalizing) {
          finalizing = true;
          audio.stopCapture();
          publish('finalizing');
          if (running) timer = setTimeout(() => { void end('finished'); }, MAX_FRAME_AGE_MS);
        }
        return;
      }
      // Audio time, not timer invocation count, determines both schedule and visuals.
      nextSlot = Math.max(nextSlot, Math.ceil((now + 0.003 - countInAt) / slotSeconds));
      const deadlineTolerance = Number.EPSILON * Math.max(1, Math.abs(deadline)) * 16;
      while (countInAt + nextSlot * slotSeconds < Math.min(deadline - deadlineTolerance, now + LOOKAHEAD_SECONDS)) {
        const at = countInAt + nextSlot * slotSeconds;
        const countIn = nextSlot < 8;
        if (countIn || soundMode === 'beat') {
          if (nextSlot % 2 === 0) audio.click(at, nextSlot % 8 === 0, deadline);
        } else {
          const stroke = pattern.slots[(nextSlot - 8) % 8];
          if (stroke !== null) audio.click(at, false, deadline, stroke);
        }
        nextSlot += 1;
      }
      publish(microphone && now < countInAt ? 'calibrating' : now < playingAt ? 'count-in' : 'playing');
      if (running) timer = setTimeout(tick, TICK_MS);
    } catch (reason) {
      fail(reason instanceof Error ? reason : new Error('Metronome scheduling failed.'));
    }
  };
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    audio = factory(audible, pause, fail);
    countInAt = await Promise.race([
      audio.ready(microphone, onset),
      new Promise<never>((_resolve, reject) => {
        setupTimer = setTimeout(() => reject(new Error('Microphone/audio setup timed out. Start again.')), SETUP_TIMEOUT_MS);
      }),
      new Promise<never>((_resolve, reject) => { cancelSetup = reject; }),
    ]);
    if (!running) {
      await audio.close();
      throw options.signal?.aborted ? aborted() : new Error('Strumming practice stopped during setup.');
    }
    countInAt = Math.max(countInAt, audio.now + 0.05);
    playingAt = countInAt + 4 * beatSeconds;
    audio.setCaptureDeadline(playingAt + targetSeconds);
    ready = true;
    tick();
    if (!running) throw new Error('Unable to start the metronome.');
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error('Unable to start strumming practice.');
    fail(error);
    await end('error');
    throw error;
  } finally {
    clearTimeout(setupTimer);
    cancelSetup = undefined;
  }
  return {
    get snapshot(): RhythmSnapshot { return snapshot; },
    async stop(): Promise<RhythmSnapshot> { await end('stopped'); return snapshot; },
  };
}
