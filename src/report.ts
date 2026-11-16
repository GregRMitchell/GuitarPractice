import { MINIMUM_MARGIN, MINIMUM_SCORE, OUT_OF_CHORD_PENALTY } from './audio/classify';
import { MAX_FRAME_AGE_MS } from './audio/capture';
import { CALIBRATION_MS, FRAME_SAMPLES, HOP_SAMPLES } from './audio/capture-protocol';
import { MAX_EVIDENCE_GAP_MS, MIN_CONFIDENCE, STABLE_DURATION_MS } from './drill';
import type { SessionSnapshot } from './session';
import { evaluate, evaluateControl } from './validation';

/** User-reviewed context included only in an explicitly downloaded report. */
export interface ReportMetadata {
  readonly device: string;
  readonly browser: string;
  readonly environment: string;
  readonly reviewed: boolean;
}

/** Effective algorithm defaults, shared with the implementation rather than copied thresholds. */
export const DETECTOR_PARAMETERS = Object.freeze({
  frameSamples: FRAME_SAMPLES, hopSamples: HOP_SAMPLES, calibrationMs: CALIBRATION_MS,
  minimumScore: MINIMUM_SCORE, minimumMargin: MINIMUM_MARGIN,
  outOfChordPenalty: OUT_OF_CHORD_PENALTY, minimumConfidence: MIN_CONFIDENCE,
  stableDurationMs: STABLE_DURATION_MS, maximumEvidenceGapMs: MAX_EVIDENCE_GAP_MS,
  maximumFrameAgeMs: MAX_FRAME_AGE_MS,
});

/**
 * Serialize a finished attempt into versioned metadata, labels, events and metrics.
 * @param run Detached session snapshot; unfinished runs must first be finished.
 * @param metadata Device/browser context explicitly reviewed by the user.
 * @returns Download-ready JSON containing no audio or opaque device identifiers.
 * @throws If numbers are nonfinite, labels invalid, or the report is not ready.
 */
export function serializeReport(run: SessionSnapshot, metadata: ReportMetadata): string {
  assertFinite(run);
  if (run.phase !== 'finished') throw new Error('Finish this attempt before exporting.');
  if (!metadata.reviewed || !metadata.device.trim() || !metadata.browser.trim()) {
    throw new Error('Review the device and browser descriptions before exporting.');
  }
  const references = run.references.map(({ chord, atMs }) => ({ chord, atMs }));
  const events = run.events.map(({ chord, atMs }) => ({ chord, atMs }));
  const control = run.config.mode !== 'pair';
  const evidence = run.discarded ? 'discarded'
    : control ? 'control' : run.config.independent ? 'independent-reference' : 'exploratory';
  const hasRun = !run.discarded && run.elapsedMs > 0;
  const results = !hasRun ? null
    : control ? evaluateControl(events, 0, run.elapsedMs)
      : run.config.independent && references.length > 0
        ? evaluate(references, events, run.elapsedMs) : null;
  const settings = effectiveSettings(run.settings);
  const report = {
    version: 1,
    protocol: 'open-chord-microphone-validation',
    timebase: 'milliseconds since explicit run origin; uninterrupted; end exclusive for pair metrics',
    selection: { pair: [...run.config.pair], mode: run.config.mode },
    evidence, discarded: run.discarded, priorDiscardCount: run.discardCount,
    sourceAtStart: run.sourceAtStart,
    elapsedMs: run.elapsedMs,
    parameters: DETECTOR_PARAMETERS,
    calibration: run.calibration && {
      status: run.calibration.status, remainingMs: run.calibration.remainingMs,
      noiseFloorRms: run.calibration.noiseFloorRms,
    },
    settings,
    analysisSampleRate: run.analysisSampleRate,
    context: {
      device: metadata.device.trim(), browser: metadata.browser.trim(),
      environment: metadata.environment.trim(), reviewed: metadata.reviewed,
    },
    references, events, results,
    gatePassed: results?.passed === true && evidence !== 'exploratory'
      && (!control || run.sourceAtStart === run.config.pair[0])
      && run.analysisSampleRate !== null && run.analysisSampleRate > 0,
    error: run.error,
    scope: 'One attempt only; not an overall 28-pair release gate or real-device accuracy claim.',
  };
  assertFinite(report);
  return JSON.stringify(report, null, 2);
}

/**
 * Select useful effective capture settings without persistent device/group identifiers.
 * @param settings Browser-provided track settings.
 * @returns An allowlisted, display- and export-safe settings object.
 */
export function effectiveSettings(settings: MediaTrackSettings): MediaTrackSettings {
  const { sampleRate, sampleSize, channelCount, echoCancellation, noiseSuppression, autoGainControl } = settings;
  return { sampleRate, sampleSize, channelCount, echoCancellation, noiseSuppression, autoGainControl };
}

function assertFinite(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Report numbers must be finite.');
  if (Array.isArray(value)) value.forEach(assertFinite);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(assertFinite);
}
