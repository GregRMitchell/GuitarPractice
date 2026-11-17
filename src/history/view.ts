import { element, text } from '../screen';
import { summarize, type HistorySummary } from './stats';
import type { PracticeRecord } from './model';

const PAGE_SIZE = 20;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, content = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = content;
  return result;
}

/**
 * Format active duration without presenting a normalized early-round rate.
 * @param ms Validated positive active duration in milliseconds.
 * @returns Human-readable minutes and seconds.
 */
export function historyDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s`
    : `${Math.floor(ms / 60_000)} min ${((ms % 60_000) / 1000).toFixed(1)} s`;
}

function field(list: HTMLElement, label: string, value: string): void {
  list.append(node('dt', label));
  list.append(node('dd', value));
}

function round(record: PracticeRecord): HTMLDetailsElement {
  const details = node('details');
  const fullMinute = record.completed && record.activeMs === 60_000 && record.targetMs === 60_000;
  const completion = fullMinute ? 'Full 60-second round' : record.completed ? 'Full target round' : 'Ended early';
  const label = record.mode === 'coach' ? `Learn ${record.targetChord} · ${record.confirmations} stable confirmations`
    : record.mode === 'rhythm' ? `Strumming ${record.heldChord} · ${record.bpm} BPM · ${record.timingMeasured ? 'estimated timing' : 'guided'}`
      : record.mode === 'progression' ? `Play along · ${record.sequence.join(' – ')} · ${record.bpm} BPM`
      : `Chord switches · ${record.pair.join(' ↔ ')} · ${record.switches} switches`;
  details.append(node('summary', `${label} · ${new Date(record.completedAt).toLocaleString()}`));
  const list = node('dl');
  field(list, 'Completed (UTC)', record.completedAt);
  if (record.mode === 'coach') {
    field(list, 'Mode', 'Learn a chord');
    field(list, 'Chord', record.targetChord);
    field(list, 'Stable overall confirmations', String(record.confirmations));
    field(list, 'Unique selected string pitch matches', String(record.successfulStrings.length));
    field(list, 'What this means', 'Pitch matches, not certified clean strings or a fret-buzz assessment.');
  } else if (record.mode === 'rhythm' || record.mode === 'progression') {
    field(list, 'Mode', record.mode === 'rhythm' ? 'Strumming' : 'Play along');
    if (record.mode === 'rhythm') field(list, 'Held chord', record.heldChord);
    else {
      field(list, 'Prompted sequence', record.sequence.join(' – '));
      field(list, 'Bars per chord / loops', `${record.barsPerChord} / ${record.loops}`);
      field(list, 'What this means', 'Prompted chords, not detected chord changes.');
    }
    field(list, 'Tempo / pattern', `${record.bpm} BPM · ${record.patternId}`);
    field(list, 'Clicks', record.audible ? 'Audible' : 'Muted');
    field(list, 'Sound', record.soundMode === 'strums' ? 'Strum cues · down low / up high' : 'Beat clicks');
    field(list, 'Timing', record.timingMeasured ? 'Estimated timing (uncalibrated)' : 'Guided practice · timing not measured');
    if (record.timingMeasured) {
      field(list, 'Estimated matched / missed / extra', `${record.matched} / ${record.missed} / ${record.extra}`);
      field(list, 'Mean absolute offset', record.meanAbsoluteOffsetMs === null ? 'No matched strokes'
        : `${record.meanAbsoluteOffsetMs.toFixed(0)} ms`);
    }
  } else {
    field(list, 'Chords', record.pair.join(' ↔ '));
    field(list, 'Confirmed switches', String(record.switches));
  }
  field(list, 'Active time', historyDuration(record.activeMs));
  field(list, 'Target time', historyDuration(record.targetMs));
  field(list, 'Round', completion);
  field(list, 'Tracking', record.tracking === 'guided' ? 'Metronome only · no microphone'
    : 'Microphone estimate · not an accuracy score');
  details.append(list);
  return details;
}

/**
 * Create a bounded history renderer; unchanged records do not recreate open details.
 * @returns Actions to replace persisted data or reveal twenty additional records.
 */
export function createHistoryView() {
  let source: readonly PracticeRecord[] | null = null;
  let summary: HistorySummary | null = null;
  let shown = 0;
  const more = (): void => {
    if (!summary) return;
    const end = Math.min(shown + PAGE_SIZE, summary.recent.length);
    for (const record of summary.recent.slice(shown, end)) element('history-rounds').append(round(record));
    shown = end;
    element('history-more').hidden = shown >= summary.recent.length;
    text('history-page-count', `Showing ${shown} of ${summary.recent.length} rounds`);
  };
  return {
    /** Render totals, pair progress and the first page when records change. */
    render(records: readonly PracticeRecord[] | null): void {
      if (records === source) return;
      source = records;
      if (!records) return;
      summary = summarize(records);
      const { totals } = summary;
      text('history-total-rounds', String(totals.rounds));
      text('history-total-time', historyDuration(totals.activeMs));
      text('history-total-switches', String(totals.switches));
      text('history-total-days', String(totals.days));
      text('history-mode-totals', `Learn a chord: ${totals.coachRounds} rounds · ${historyDuration(totals.coachActiveMs)} · ${totals.coachConfirmations} stable confirmations. Strumming: ${totals.rhythmRounds} rounds · ${historyDuration(totals.rhythmActiveMs)}. Play along: ${totals.progressionRounds} rounds · ${historyDuration(totals.progressionActiveMs)}. Switch totals and pair bests below include chord-switch rounds only.`);
      element('history-empty').hidden = totals.rounds > 0;
      const pairs = element('history-pairs');
      pairs.replaceChildren();
      for (const pair of summary.pairs) {
        const card = node('article');
        card.className = 'pair-progress';
        card.append(node('h3', pair.pair.join(' ↔ ')));
        card.append(node('p', `${pair.rounds} rounds · ${historyDuration(pair.activeMs)} · ${pair.switches} switches`));
        const list = node('dl');
        field(list, 'Best full minute', pair.best60s === null ? 'No full minute yet' : `${pair.best60s} switches`);
        field(list, 'Latest change', pair.recentChange === null ? 'Needs two full minutes'
          : `${pair.recentChange > 0 ? '+' : ''}${pair.recentChange} switches vs previous full minute`);
        card.append(list);
        pairs.append(card);
      }
      element('history-rounds').replaceChildren();
      shown = 0;
      more();
    },
    /** Append no more than twenty additional expandable summaries. */
    more,
  };
}
