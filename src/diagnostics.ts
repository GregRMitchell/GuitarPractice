import { serializeReport, type ReferenceTimingReview } from './report';
import type { SessionSnapshot } from './session';
import { evaluate, evaluateControl } from './validation';
import { element, text } from './screen';

const REPORT_URL_LIFETIME_MS = 1000;

/**
 * Read independently reviewed reference timing from the diagnostic editor.
 * @param run Finished or current session metadata.
 * @returns A review for independently labeled pair runs, otherwise undefined.
 */
export function timingReview(run: SessionSnapshot): ReferenceTimingReview | undefined {
  if (run.config.mode !== 'pair' || !run.config.independent || !run.references.length) return undefined;
  const raw = element<HTMLTextAreaElement>('reference-times').value;
  const times = raw.trim() ? raw.split(/\r?\n/) : [];
  if (times.length !== run.references.length - 1) {
    throw new Error('Enter exactly one independent time for each labeled transition.');
  }
  return {
    references: run.references.map((reference, index) => ({
      ...reference, atMs: index === 0 ? 0 : times[index - 1]?.trim() ? Number(times[index - 1]) : Number.NaN,
    })),
    evidence: element<HTMLInputElement>('reference-evidence').value,
    attested: element<HTMLInputElement>('reference-attested').checked,
  };
}

/**
 * Describe diagnostic evidence without conflating exploratory practice and accuracy.
 * @param run Current session snapshot.
 * @returns Diagnostic result text, or empty before finishing.
 */
export function resultText(run: SessionSnapshot): string {
  if (run.phase !== 'finished') return '';
  if (run.discarded) return 'Discarded — no gate result.';
  if (run.elapsedMs <= 0) return 'No timed evidence collected.';
  if (run.config.mode !== 'pair') {
    const result = evaluateControl(run.events, 0, run.elapsedMs);
    return `${result.passed && run.sourceAtStart ? 'Control passed' : 'Control not passed'}: `
      + `${result.countedEventCount} switches in ${(result.durationMs / 1000).toFixed(1)} s. Minimum 30 s, zero switches.`;
  }
  if (!run.config.independent) return `Exploratory only — ${run.events.length} detector switches; no independent accuracy metrics.`;
  if (!run.references.length) return 'No independent starting chord confirmed — no gate evidence.';
  try {
    const review = timingReview(run);
    const independentlyVerified = review?.attested && review.evidence.trim();
    const references = independentlyVerified ? review.references : run.references;
    const result = evaluate(references, run.events, run.elapsedMs);
    return `${independentlyVerified
      ? result.passed ? 'Reviewed pair metrics passed' : 'Reviewed pair metrics not passed'
      : `Provisional button-reaction metrics${result.passed ? ' meet thresholds' : ' do not meet thresholds'} — cannot pass`} · `
      + `${result.actualSwitchCount} actual / ${result.countedSwitchCount} detected · `
      + `precision ${result.precision === null ? 'undefined (no events)' : `${(result.precision * 100).toFixed(1)}%`} · `
      + `recall ${(result.recall * 100).toFixed(1)}%. Not an overall release gate.`
      + (independentlyVerified ? '' : ' Verify times with independent timing evidence to certify.');
  } catch {
    return 'Reference timing is invalid or incomplete. Cannot certify; check transition times before export.';
  }
}

/**
 * Download a metadata-only report using the reviewed diagnostic form.
 * @param run Frozen session snapshot to serialize.
 * @returns Nothing; errors are displayed beside the export control.
 */
export function downloadReport(run: SessionSnapshot): void {
  try {
    const json = serializeReport(run, {
      device: element<HTMLInputElement>('device').value,
      browser: element<HTMLInputElement>('browser').value,
      environment: element<HTMLTextAreaElement>('environment').value,
      reviewed: element<HTMLInputElement>('reviewed').checked,
    }, timingReview(run));
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `chord-validation-v2-${Date.now()}.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), REPORT_URL_LIFETIME_MS);
    text('export-status', 'Report download requested. No audio included; check your Downloads folder.');
  } catch (failure: unknown) {
    text('export-status', failure instanceof Error ? failure.message : 'Report export failed.');
  }
}
