import type { RhythmPattern } from './patterns';

/** Upper bound for an audio-clock exercise, including long guided phrases. */
export const MAX_RHYTHM_SECONDS = 1800;

/** Uncalibrated onset estimates; no chord or stroke-direction inference. */
export interface TimingSummary {
  readonly timingMeasured: boolean;
  readonly estimatedStrums: number | null;
  readonly expected: number;
  readonly matched: number | null;
  readonly inTime: number | null;
  readonly missed: number | null;
  readonly extra: number | null;
  readonly meanAbsoluteOffsetMs: number | null;
}

/** Build expected strokes in seconds, excluding the session's right endpoint. */
export function expectedStrokes(pattern: RhythmPattern, bpm: number, elapsed: number): number[] {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 160
    || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_RHYTHM_SECONDS) {
    throw new Error('Expected strokes require a valid tempo and an elapsed time up to 30 minutes.');
  }
  const slot = 30 / bpm;
  const result: number[] = [];
  for (let index = 0; index * slot < elapsed - 1e-8; index += 1) {
    if (pattern.slots[index % 8] !== null) result.push(index * slot);
  }
  return result;
}

/**
 * Match each onset to at most one nearest expected stroke within half a slot.
 * The window is capped at 100ms so adjacent eighths cannot overlap.
 * Null onsets explicitly means guided practice, not a successful timing score.
 */
export function summarizeTiming(
  expected: readonly number[], onsets: readonly number[] | null, bpm: number,
): TimingSummary {
  if (onsets === null) return {
    timingMeasured: false, estimatedStrums: null, expected: expected.length,
    matched: null, inTime: null, missed: null, extra: null, meanAbsoluteOffsetMs: null,
  };
  const window = Math.min(0.1, 15 / bpm);
  const used = new Set<number>();
  const offsets: number[] = [];
  const sorted = onsets.map((time, index) => ({ time, index })).sort((a, b) => a.time - b.time || a.index - b.index);
  for (const stroke of expected) {
    let best = -1;
    let distance = window + 1e-9;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sorted[middle].time <= stroke - distance) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < sorted.length && sorted[index].time < stroke + window + 1e-9; index++) {
      const onset = sorted[index];
      const candidate = Math.abs(stroke - onset.time);
      if (!used.has(onset.index) && (candidate < distance || candidate === distance && onset.index < best)) {
        best = onset.index; distance = candidate;
      }
    }
    if (best >= 0) { used.add(best); offsets.push(distance * 1000); }
  }
  return {
    timingMeasured: true, estimatedStrums: onsets.length, expected: expected.length,
    matched: used.size, inTime: used.size, missed: expected.length - used.size,
    extra: onsets.length - used.size,
    meanAbsoluteOffsetMs: offsets.length ? offsets.reduce((sum, value) => sum + value, 0) / offsets.length : null,
  };
}
