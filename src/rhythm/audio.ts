import workletUrl from './onset.worklet.ts?worker&url';
import type { RhythmOnset } from './onset';
import type { Stroke } from './patterns';

/** Audio boundary injected by deterministic controller tests. */
export interface RhythmAudio {
  readonly now: number;
  /** Resolve to the quiet-calibration deadline, or current time without mic. */
  ready(microphone: boolean, onset: (value: RhythmOnset) => void): Promise<number>;
  /** Bound onset production in the worklet's AudioContext clock domain. */
  setCaptureDeadline(atAudioTime: number): void;
  /** Release capture, retaining the message port/context for queued onset drain. */
  stopCapture(): void;
  click(at: number, accent: boolean, deadline: number, stroke?: Exclude<Stroke, null>): void;
  close(): Promise<void>;
}

/** Create/resume synchronously from a trusted gesture; never acquire mic implicitly. */
export function createRhythmAudio(
  audible: boolean, pause: (reason: 'hidden' | 'interrupted') => void,
  fail: (error: Error) => void,
): RhythmAudio {
  if (document.hidden) throw new Error('Start strumming practice from a visible page.');
  const context = new AudioContext();
  const resumed = context.resume();
  // Attach rejection handling immediately, even while microphone permission is pending.
  void resumed.catch(() => undefined);
  const clicks = context.createGain();
  clicks.gain.value = audible ? 0.18 : 0;
  clicks.connect(context.destination);
  const oscillators = new Map<OscillatorNode, GainNode>();
  let closed = false;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  let closePromise: Promise<void> | undefined;
  const interrupted = (): void => { if (!closed) pause('interrupted'); };
  const visibility = (): void => { if (document.hidden && !closed) pause('hidden'); };
  const state = (): void => { if (context.state !== 'running' && !closed) interrupted(); };
  document.addEventListener('visibilitychange', visibility);
  context.addEventListener('statechange', state);

  const stopCapture = (): void => {
    worklet?.port.postMessage({ type: 'stop' });
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener('ended', interrupted);
      track.removeEventListener('mute', interrupted);
      track.stop();
    }
    source?.disconnect();
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    document.removeEventListener('visibilitychange', visibility);
    context.removeEventListener('statechange', state);
    for (const [oscillator, envelope] of oscillators) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already ended. */ }
      oscillator.disconnect(); envelope.disconnect();
    }
    oscillators.clear();
    stopCapture();
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.onmessageerror = null;
      worklet.onprocessorerror = null;
      worklet.port.close();
    }
    source?.disconnect(); worklet?.disconnect(); sink?.disconnect(); clicks.disconnect();
    closePromise = context.close().catch(() => undefined);
    return closePromise;
  };
  return {
    get now(): number { return context.currentTime; },
    async ready(microphone, onset): Promise<number> {
      if (microphone) {
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (closed) {
          acquired.getTracks().forEach((track) => track.stop());
          throw new Error('Strumming practice stopped during microphone setup.');
        }
        stream = acquired;
        for (const track of stream.getTracks()) {
          track.addEventListener('ended', interrupted);
          track.addEventListener('mute', interrupted);
        }
        await context.audioWorklet.addModule(workletUrl);
        if (closed) throw new Error('Strumming practice stopped during microphone setup.');
        source = context.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(context, 'rhythm-onset', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
          channelCountMode: 'explicit',
        });
        sink = context.createGain();
        sink.gain.value = 0;
        source.connect(worklet); worklet.connect(sink); sink.connect(context.destination);
        worklet.port.onmessage = ({ data }: MessageEvent<unknown>): void => {
          if (closed) return;
          worklet?.port.postMessage('ack');
          const value = data as Partial<RhythmOnset> | null;
          if (value && typeof value.atAudioTime === 'number' && Number.isFinite(value.atAudioTime)
            && typeof value.strength === 'number' && Number.isFinite(value.strength) && value.strength > 0) {
            onset(value as RhythmOnset);
          }
        };
        worklet.onprocessorerror = (): void => { if (!closed) fail(new Error('Rhythm microphone processing failed.')); };
        worklet.port.onmessageerror = (): void => { if (!closed) fail(new Error('Rhythm microphone message failed.')); };
      }
      await resumed;
      if (closed || document.hidden || context.state !== 'running') throw new Error('Start strumming practice again from a visible page.');
      return context.currentTime + (microphone ? 1 : 0);
    },
    click(at, accent, deadline, stroke): void {
      if (closed || !audible) return;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const endAt = Math.min(at + 0.04, deadline);
      const attackAt = Math.min(at + 0.002, at + (endAt - at) / 2);
      oscillator.frequency.value = stroke ? STRUM_FREQUENCIES[stroke] : accent ? 1200 : 800;
      envelope.gain.setValueAtTime(0.001, at);
      envelope.gain.exponentialRampToValueAtTime(1, attackAt);
      envelope.gain.exponentialRampToValueAtTime(0.001, endAt);
      oscillator.connect(envelope); envelope.connect(clicks);
      oscillators.set(oscillator, envelope);
      oscillator.onended = (): void => {
        oscillators.delete(oscillator); oscillator.disconnect(); envelope.disconnect();
      };
      oscillator.start(at); oscillator.stop(endAt);
    },
    setCaptureDeadline(atAudioTime): void {
      if (!closed) worklet?.port.postMessage({ type: 'deadline', atAudioTime });
    },
    stopCapture,
    close,
  };
}

const STRUM_FREQUENCIES = { down: 440, up: 880 } as const;
