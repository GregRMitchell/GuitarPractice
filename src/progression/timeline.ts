import type { Chord } from '../chords';

/** Complete, self-contained guided phrase configuration. */
export interface ProgressionPlan {
  readonly sequence: readonly Chord[];
  readonly bpm: number;
  readonly barsPerChord: number;
  readonly loops: number;
}

/** Calculate playing time in seconds, excluding the count-in. */
export function progressionDuration(plan: ProgressionPlan): number {
  return plan.sequence.length * plan.barsPerChord * plan.loops * 4 * 60 / plan.bpm;
}

/** Locate a phrase prompt using audio-clock elapsed seconds, clamped at the final prompt. */
export function progressionPosition(plan: ProgressionPlan, elapsedSeconds: number) {
  const duration = progressionDuration(plan);
  const finished = elapsedSeconds >= duration;
  const rawBeat = Math.max(0, elapsedSeconds) * plan.bpm / 60;
  const roundedBeat = Math.round(rawBeat);
  const normalizedBeat = Math.abs(rawBeat - roundedBeat) <= Number.EPSILON * Math.max(1, rawBeat) * 4
    ? roundedBeat : rawBeat;
  const beat = Math.min(plan.sequence.length * plan.barsPerChord * plan.loops * 4 - 1,
    Math.floor(normalizedBeat));
  const prompt = Math.floor(beat / (plan.barsPerChord * 4));
  const index = prompt % plan.sequence.length;
  return {
    index, current: plan.sequence[index],
    next: prompt + 1 < plan.sequence.length * plan.loops
      ? plan.sequence[(index + 1) % plan.sequence.length] : null,
    beat: beat % 4 + 1,
    bar: Math.floor(beat / 4) % plan.barsPerChord + 1,
    loop: Math.floor(prompt / plan.sequence.length) + 1,
    finished,
  };
}
