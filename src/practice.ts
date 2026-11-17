import type { Pair } from './chords';
import type { SessionSnapshot } from './session';
import { chordDiagram } from './diagrams';
import { element, text } from './screen';

/** The quick-play challenge lasts one uninterrupted minute after calibration. */
export const ROUND_MS = 60_000;

/**
 * Choose encouragement from real detector-confirmed switch milestones.
 * @param count Number of confirmed switches in the current round.
 * @returns Honest, non-accuracy-scored feedback.
 */
export function milestone(count: number): string {
  if (count >= 20) return '20+ switches! Keep that rhythm rolling.';
  if (count >= 10) return '10 switches! You’re finding your flow.';
  if (count >= 5) return '5 switches! Nice momentum.';
  if (count >= 1) return 'First switch! Now bring it back.';
  return 'Find your first switch. Clean changes, easy pace.';
}

/**
 * Render practice guidance, diagrams and a bounded accessible countdown.
 * @param run Current session snapshot.
 * @param pair Pair selected for the next round, or locked for this round.
 * @param practice Whether this is quick play rather than a diagnostic attempt.
 * @returns Nothing.
 */
export function renderPractice(run: SessionSnapshot, pair: Pair, practice: boolean): void {
  for (const id of ['challenge', 'practice-feedback', 'practice-result', 'diagram-key']) element(id).hidden = !practice;
  const practiceRun = run.config.durationMs !== undefined;
  const elapsed = practiceRun ? Math.min(ROUND_MS, run.elapsedMs) : 0;
  const count = practiceRun ? run.events.length : 0;
  text('countdown', String(Math.ceil((ROUND_MS - elapsed) / 1000)));
  element<HTMLProgressElement>('round-progress').value = elapsed / ROUND_MS;
  text('practice-feedback', milestone(count));
  element('practice-feedback').setAttribute('data-milestone',
    String(count >= 20 ? 20 : count >= 10 ? 10 : count >= 5 ? 5 : 0));
  let summary = '';
  if (practiceRun && run.phase === 'finished' && !run.discarded) {
    summary = elapsed >= ROUND_MS
      ? `One minute, well played! ${run.events.length} confirmed switches · ${run.events.length} switches per minute. Try another round?`
      : `Round ended early · ${run.events.length} confirmed switches in ${(elapsed / 1000).toFixed(1)} seconds. Ready for a fresh minute?`;
  }
  if (practiceRun && run.discarded) summary = 'Round reset. Your microphone is off. Restart when you’re ready for a fresh minute.';
  text('practice-result', summary);
  const preview = ['idle', 'finished'].includes(run.phase);
  const current = preview ? pair[0] : run.source ?? pair[0];
  const next = current === pair[0] ? pair[1] : pair[0];
  for (const [id, chord] of [['current-diagram', current], ['next-diagram', next]] as const) {
    const container = element(id);
    container.hidden = !practice;
    if (container.getAttribute('data-chord') === chord) continue;
    container.setAttribute('data-chord', chord);
    container.replaceChildren(chordDiagram(chord));
  }
}
