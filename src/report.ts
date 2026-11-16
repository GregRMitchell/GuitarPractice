import { MINIMUM_MARGIN, MINIMUM_SCORE, OUT_OF_CHORD_PENALTY } from './audio/classify';
import { MAX_FRAME_AGE_MS } from './audio/capture';
import { CALIBRATION_MS, FRAME_SAMPLES, HOP_SAMPLES } from './audio/capture-protocol';
import { MAX_EVIDENCE_GAP_MS, MIN_CONFIDENCE, STABLE_DURATION_MS } from './drill';
import type { SessionSnapshot } from './session';
import { evaluate, evaluateControl, type Reference } from './validation';

/** User-reviewed context included only in an explicitly downloaded report. */
export interface ReportMetadata {
  readonly device: string;
  readonly browser: string;
  readonly environment: string;
  readonly reviewed: boolean;
}

/** Explicit post-run correction based on independent timing evidence. */
export interface ReferenceTimingReview {
  /** Corrected source-relative reference times; labels must match the raw sequence. */
  readonly references: readonly Reference[];
  /** Describe the independent clock or timecoded observation used for correction. */
  readonly evidence: string;
  /** User attestation that times were verified against playing, not button reactions or predictions. */
  readonly attested: boolean;
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
 * @param timingReview Optional independent post-run timing correction and attestation.
 * @returns Download-ready JSON containing no audio or opaque device identifiers.
 * @throws If numbers are nonfinite, labels invalid, or the report is not ready.
 */
export function serializeReport(
  run: SessionSnapshot,
  metadata: ReportMetadata,
  timingReview?: ReferenceTimingReview,
): string {
  assertFinite(run);
  if (run.phase !== 'finished') throw new Error('Finish this attempt before exporting.');
  if (!metadata.reviewed || !metadata.device.trim() || !metadata.browser.trim()) {
    throw new Error('Review the device and browser descriptions before exporting.');
  }
  const rawButtonReferences = run.references.map(({ chord, atMs }) => ({ chord, atMs }));
  const events = run.events.map(({ chord, atMs }) => ({ chord, atMs }));
  const control = run.config.mode !== 'pair';
  const hasTimingReview = timingReview !== undefined;
  if (timingReview) validateTimingReview(rawButtonReferences, timingReview, run.elapsedMs);
  if (timingReview?.attested && !timingReview.evidence.trim()) {
    throw new Error('Describe independent timing evidence before certifying reference times.');
  }
  const timingAttested = Boolean(
    !run.discarded && run.config.mode === 'pair' && run.config.independent
    && timingReview?.attested && timingReview.evidence.trim(),
  );
  const references = timingReview?.references.map(({ chord, atMs }) => ({ chord, atMs })) ?? null;
  const evidence = run.discarded ? 'discarded'
    : control ? 'control'
      : timingAttested ? 'independently-reviewed-reference'
        : run.config.independent ? 'provisional-reference-timing' : 'exploratory';
  const hasRun = !run.discarded && run.elapsedMs > 0;
  const rawResults = !hasRun || control || !run.config.independent || rawButtonReferences.length === 0
    ? null : evaluate(rawButtonReferences, events, run.elapsedMs);
  const results = !hasRun ? null
    : control ? evaluateControl(events, 0, run.elapsedMs)
      : timingAttested && references ? evaluate(references, events, run.elapsedMs) : null;
  const settings = effectiveSettings(run.settings);
  const report = {
    version: 2,
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
    references: rawButtonReferences,
    rawButtonReferences,
    reviewedReferences: references,
    timingReview: {
      status: timingAttested ? 'independently-verified' : 'not-certified',
      provenance: timingAttested ? 'independent-reference-clock' : hasTimingReview
        ? 'user-edited-unverified-times' : 'button-reaction-times-only',
      evidence: timingReview?.evidence.trim() ?? '',
      attested: timingAttested,
    },
    events, rawResults, results,
    warning: run.config.mode === 'pair' && run.config.independent && !timingAttested
      ? 'Button-reaction times are provisional, not verified playing-transition times; this report cannot pass.'
      : '',
    confidenceInterpretation: 'Uncalibrated margin-based indicator; not a probability.',
    gatePassed: results?.passed === true && (control || timingAttested)
      && (!control || run.sourceAtStart === run.config.pair[0])
      && run.analysisSampleRate !== null && run.analysisSampleRate > 0,
    error: run.error,
    scope: 'One attempt only; not an overall 28-pair release gate or real-device accuracy claim.',
  };
  assertFinite(report);
  return JSON.stringify(report, null, 2);
}

function validateTimingReview(
  rawReferences: readonly Reference[],
  review: ReferenceTimingReview,
  elapsedMs: number,
): void {
  if (rawReferences.length === 0) {
    throw new Error('A starting reference is required before reviewing transition times.');
  }
  if (review.references.length !== rawReferences.length
    || review.references.some(({ chord }, index) => chord !== rawReferences[index].chord)) {
    throw new Error('Reviewed reference labels must preserve the original chord sequence.');
  }
  if (review.references[0].atMs !== 0) {
    throw new Error('The reviewed starting reference must remain at source time zero.');
  }
  evaluate(review.references, [], elapsedMs);
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
