import workletUrl from './capture.worklet.ts?worker&url';
import workerUrl from './analysis.worker.ts?worker&url';
import { CHORDS } from '../chords';
import type { Pair } from '../chords';
import type { Observation } from './classify';
import { CALIBRATION_MS } from './capture-protocol';
import type { AnalysisReply, AnalysisRequest, AudioFrame, Calibration, FrameAck } from './capture-protocol';

export type { Calibration } from './capture-protocol';

/** Callbacks run on the main thread; consumers must not throw from them. */
export interface CaptureHandlers {
  /** Receives only fresh, post-calibration observations on the shared clock. */
  onObservation(value: Observation): void;
  /** Receives DC-centered RMS amplitude during calibration and recognition. */
  onLevel(rms: number): void;
  /** Receives setup and processing failures; setup failures also reject start. */
  onError(error: Error): void;
  /** Pause drill/timing immediately. Resume requires another explicit start. */
  onPause(reason: 'hidden' | 'interrupted'): void;
  /** Display quiet-room progress; pause timing whenever calibrating, resume only when ready. */
  onCalibration(value: Calibration): void;
  /** Shared monotonic milliseconds for labels and observations; default performance.now. */
  readonly now?: () => number;
}

/** One local-only capture session. No PCM is saved, uploaded, or played back. */
export interface Capture {
  /** Actual AudioContext/worklet analysis rate, which may differ from the track rate. */
  readonly analysisSampleRate: number;
  /** Effective device settings, which may differ from requested preferences. */
  readonly settings: MediaTrackSettings;
  /** Invalidate pending callbacks and release every resource; safe to repeat. */
  stop(): Promise<void>;
}

/** Maximum accepted age of an analysis frame/result on the shared clock. */
export const MAX_FRAME_AGE_MS = 250;
const RENDER_QUANTUM_SAMPLES = 128;
const WORKER_READY_TIMEOUT_MS = 5000;
const ANALYSIS_TIMEOUT_MS = 2000;

/**
 * Start quiet-room calibration directly from a visible user-gesture handler.
 * @param pair Distinct candidate chords.
 * @param handlers Observation, level, error, calibration, pause and optional clock callbacks.
 * @returns Capture with effective settings and idempotent asynchronous cleanup.
 * Use the same `now` for independent labels, even across explicit restarts. To
 * make a confirmed reference time zero, subtract that clock value from BOTH
 * labels and observations. Await stop when leaving; onPause must pause timing
 * synchronously. Hidden/interrupted sessions never resume automatically.
 * @throws Permission, unsupported-browser, cancellation or setup errors.
 */
export async function startCapture(pair: Pair, handlers: CaptureHandlers): Promise<Capture> {
  let active = true;
  let started = false;
  let reported = false;
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let sink: GainNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let worker: Worker | undefined;
  let stopPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelReady: ((error: Error) => void) | undefined;
  let pending: { id: number; atMs: number } | undefined;
  const now = handlers.now ?? ((): number => performance.now());
  const candidatePair: Pair = [pair[0], pair[1]];

  const report = (error: Error): void => {
    if (!reported) { reported = true; handlers.onError(error); }
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    active = false;
    clearTimeout(timer);
    pending = undefined;
    document.removeEventListener('visibilitychange', visibility);
    context?.removeEventListener('statechange', contextChanged);
    cancelReady?.(new Error('Capture stopped during setup.'));
    if (worker) {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
    }
    if (worklet) {
      worklet.onprocessorerror = null;
      worklet.port.onmessage = null;
      worklet.port.onmessageerror = null;
      worklet.port.close();
    }
    source?.disconnect(); worklet?.disconnect(); sink?.disconnect();
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener('mute', interrupted);
      track.removeEventListener('ended', interrupted);
      track.stop();
    }
    stopPromise = (async (): Promise<void> => {
      if (context && context.state !== 'closed') await context.close();
    })();
    return stopPromise;
  };
  const fail = (error: Error): void => {
    if (!active) return;
    const wasStarted = started;
    const cleanup = stop();
    if (wasStarted) handlers.onPause('interrupted');
    report(error);
    void cleanup.catch((closeError: unknown) => handlers.onError(asError(closeError)));
  };
  const interrupted = (): void => fail(new Error('Microphone capture was interrupted. Start again to recalibrate.'));
  const contextChanged = (): void => { if (started && context?.state !== 'running') interrupted(); };
  const visibility = (): void => {
    if (!document.hidden || !active) return;
    const cleanup = stop();
    handlers.onPause('hidden');
    void cleanup.catch((error: unknown) => handlers.onError(asError(error)));
  };
  const assertActive = (): void => { if (!active) throw new Error('Capture stopped during setup.'); };
  const ack = (id: number): void => {
    const message: FrameAck = { type: 'ack', id };
    worklet?.port.postMessage(message);
  };

  try {
    if (document.hidden || navigator.userActivation?.isActive !== true) {
      throw new Error('Microphone start requires a visible, explicit user gesture.');
    }
    if (candidatePair[0] === candidatePair[1]
      || !candidatePair.every((chord) => Object.hasOwn(CHORDS, chord))) {
      throw new RangeError('A distinct chord pair is required.');
    }
    document.addEventListener('visibilitychange', visibility);
    context = new AudioContext();
    // Audio time advances in render quanta, while the shared clock is continuous.
    const maxClockLeadMs = RENDER_QUANTUM_SAMPLES / context.sampleRate * 1000;
    // Resume before the first await so browser user activation is still present.
    const resumed = context.resume().then(() => undefined, asError);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    if (!active) {
      for (const track of stream.getTracks()) track.stop();
      assertActive();
    }
    const resumeError = await resumed;
    if (resumeError) throw resumeError;
    assertActive();
    await context.audioWorklet.addModule(workletUrl);
    assertActive();
    worklet = new AudioWorkletNode(context, 'guitar-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit',
    });
    worklet.onprocessorerror = interrupted;
    worklet.port.onmessageerror = interrupted;
    worker = new Worker(workerUrl, { type: 'module' });
    const ready = new Promise<void>((resolve, reject) => {
      cancelReady = reject;
      timer = setTimeout(() => fail(new Error('Audio analysis worker did not start.')), WORKER_READY_TIMEOUT_MS);
      worker!.onmessage = ({ data }: MessageEvent<AnalysisReply>): void => {
        if (!active) return;
        if (data.type === 'ready') {
          clearTimeout(timer);
          cancelReady = undefined;
          resolve();
          return;
        }
        if (!pending || data.id !== pending.id) return;
        const { id, atMs } = pending;
        pending = undefined;
        clearTimeout(timer);
        ack(id);
        if (data.type === 'error') { fail(new Error(data.message)); return; }
        const ageMs = now() - atMs;
        if (ageMs < -maxClockLeadMs || ageMs > MAX_FRAME_AGE_MS) return;
        handlers.onLevel(data.rms);
        if (!active) return;
        handlers.onCalibration(data.calibration);
        if (active && data.calibration.status === 'ready' && data.observation) {
          handlers.onObservation({ ...data.observation, atMs });
        }
      };
      worker!.onerror = (event: ErrorEvent): void => {
        event.preventDefault();
        fail(new Error('Audio analysis worker failed.'));
      };
      worker!.onmessageerror = (): void => fail(new Error('Audio analysis message could not be decoded.'));
    });
    await ready;
    assertActive();
    const anchorAudioMs = context.currentTime * 1000;
    const anchorSessionMs = now();
    worklet.port.onmessage = ({ data }: MessageEvent<AudioFrame>): void => {
      if (!active || data.type !== 'frame' || pending) return;
      const atMs = anchorSessionMs + data.audioTime * 1000 - anchorAudioMs;
      const ageMs = now() - atMs;
      if (!Number.isFinite(atMs) || atMs < 0 || ageMs < -maxClockLeadMs || ageMs > MAX_FRAME_AGE_MS) {
        ack(data.id);
        return;
      }
      pending = { id: data.id, atMs };
      timer = setTimeout(() => fail(new Error('Audio analysis timed out.')), ANALYSIS_TIMEOUT_MS);
      const request: AnalysisRequest = { type: 'analyze', frame: data, pair: candidatePair, atMs };
      try { worker!.postMessage(request, [data.samples.buffer]); }
      catch (error: unknown) { ack(data.id); fail(asError(error)); }
    };
    source = context.createMediaStreamSource(stream);
    sink = context.createGain();
    sink.gain.value = 0;
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(context.destination);
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('No microphone audio track was acquired.');
    for (const capturedTrack of stream.getTracks()) {
      capturedTrack.addEventListener('mute', interrupted);
      capturedTrack.addEventListener('ended', interrupted);
    }
    context.addEventListener('statechange', contextChanged);
    if (context.state !== 'running') throw new Error('Audio context is not running.');
    started = true;
    handlers.onCalibration({ status: 'calibrating', remainingMs: CALIBRATION_MS });
    return { analysisSampleRate: context.sampleRate, settings: { ...track.getSettings() }, stop };
  } catch (error: unknown) {
    const failure = asError(error);
    try { await stop(); } catch (closeError: unknown) { handlers.onError(asError(closeError)); }
    report(failure);
    throw failure;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Microphone capture failed.');
}
