import type { Pair } from '../chords';
import { validateRecords, type PracticeRecord, type SwitchRecord } from './model';

/** Aggregate practice totals, with days counted by the canonical UTC completion date. */
export interface HistoryTotals {
  readonly rounds: number;
  readonly activeMs: number;
  readonly switches: number;
  readonly days: number;
  readonly coachRounds: number;
  readonly coachConfirmations: number;
  readonly coachActiveMs: number;
  readonly rhythmRounds: number;
  readonly rhythmActiveMs: number;
  readonly progressionRounds: number;
  readonly progressionActiveMs: number;
}

/** Pair totals; best and trend use only completed actual-and-target 60-second rounds. */
export interface PairStats {
  readonly pair: Pair;
  readonly rounds: number;
  readonly activeMs: number;
  readonly switches: number;
  readonly best60s: number | null;
  readonly recentChange: number | null;
}

/** Summary of all history and newest-first records with deterministic ordering. */
export interface HistorySummary {
  readonly totals: HistoryTotals;
  readonly pairs: readonly PairStats[];
  readonly recent: readonly PracticeRecord[];
}

const ONE_MINUTE_MS = 60_000;

function newestFirst(left: PracticeRecord, right: PracticeRecord): number {
  return Date.parse(right.completedAt) - Date.parse(left.completedAt) || left.id.localeCompare(right.id);
}

/** Summarizes validated copies without mutating input or normalizing early finishes into records. */
export function summarize(records: readonly PracticeRecord[]): HistorySummary {
  const recent = [...validateRecords(records)].sort(newestFirst);
  const days = new Set<string>();
  let activeMs = 0;
  let switches = 0;
  let coachRounds = 0;
  let coachConfirmations = 0;
  let coachActiveMs = 0;
  let rhythmRounds = 0;
  let rhythmActiveMs = 0;
  let progressionRounds = 0;
  let progressionActiveMs = 0;
  const byPair = new Map<string, SwitchRecord[]>();
  for (const record of recent) {
    days.add(record.completedAt.split('T')[0]);
    activeMs += record.activeMs;
    if (record.mode === 'coach') {
      coachRounds++; coachConfirmations += record.confirmations; coachActiveMs += record.activeMs; continue;
    }
    if (record.mode === 'rhythm') { rhythmRounds++; rhythmActiveMs += record.activeMs; continue; }
    if (record.mode === 'progression') { progressionRounds++; progressionActiveMs += record.activeMs; continue; }
    switches += record.switches;
    const key = record.pair.join('-');
    const rounds = byPair.get(key) ?? [];
    rounds.push(record);
    byPair.set(key, rounds);
  }
  const pairs: PairStats[] = [...byPair.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, rounds]) => {
      const comparable = rounds.filter((record) =>
        record.completed && record.activeMs === ONE_MINUTE_MS && record.targetMs === ONE_MINUTE_MS);
      return Object.freeze({
        pair: rounds[0].pair,
        rounds: rounds.length,
        activeMs: rounds.reduce((sum, record) => sum + record.activeMs, 0),
        switches: rounds.reduce((sum, record) => sum + record.switches, 0),
        best60s: comparable.length ? Math.max(...comparable.map((record) => record.switches)) : null,
        recentChange: comparable.length > 1 ? comparable[0].switches - comparable[1].switches : null,
      });
    });
  return Object.freeze({
    totals: Object.freeze({ rounds: recent.length, activeMs, switches, days: days.size,
      coachRounds, coachConfirmations, coachActiveMs, rhythmRounds, rhythmActiveMs, progressionRounds, progressionActiveMs }),
    pairs: Object.freeze(pairs),
    recent: Object.freeze(recent),
  });
}
