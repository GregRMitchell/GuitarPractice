import { expect, test } from 'vitest';
import { summarize } from '../src/history/stats';
import { validateRecord, type PracticeRecord } from '../src/history/model';

function record(index: number, overrides: Record<string, unknown> = {}): PracticeRecord {
  return validateRecord({
    id: `36a35dcc-e806-4fb9-96dc-${index.toString(16).padStart(12, '0')}`,
    completedAt: `2026-11-${String(index).padStart(2, '0')}T12:00:00Z`,
    pair: ['D', 'A'], activeMs: 60_000, targetMs: 60_000, switches: 20,
    completed: true, tracking: 'microphone', ...overrides,
  });
}

test('summarizes empty history', () => {
  expect(summarize([])).toEqual({
    totals: { rounds: 0, activeMs: 0, switches: 0, days: 0,
      coachRounds: 0, coachConfirmations: 0, coachActiveMs: 0, rhythmRounds: 0, rhythmActiveMs: 0,
      progressionRounds: 0, progressionActiveMs: 0 }, pairs: [], recent: [],
  });
});

test('counts early rounds but only compares actual completed one-minute rounds', () => {
  const records = [
    record(1), record(2, { switches: 30 }), record(3, { completed: false, activeMs: 1_000, switches: 50 }),
    record(4, { activeMs: 30_000, targetMs: 30_000, switches: 40 }),
    record(5, { activeMs: 59_999, completed: false, switches: 99 }),
    record(6, { pair: ['G', 'C'], switches: 8 }),
  ];
  const result = summarize(records);
  expect(result.totals).toEqual({ rounds: 6, activeMs: 270_999, switches: 247, days: 6,
    coachRounds: 0, coachConfirmations: 0, coachActiveMs: 0, rhythmRounds: 0, rhythmActiveMs: 0,
    progressionRounds: 0, progressionActiveMs: 0 });
  expect(result.pairs.map((pair) => pair.pair)).toEqual([['A', 'D'], ['C', 'G']]);
  expect(result.pairs[0]).toMatchObject({ rounds: 5, activeMs: 210_999, best60s: 30, recentChange: 10 });
  expect(result.pairs[1]).toMatchObject({ best60s: 8, recentChange: null });
  expect(result.recent.map((round) => round.id)).toEqual([...records].reverse().map((round) => round.id));
});

test('uses canonical UTC days and stable newest ordering without mutating input', () => {
  const records = [record(1), record(2, { completedAt: '2026-11-01T14:00:00+02:00' })];
  const before = [...records];
  expect(summarize(records).totals.days).toBe(1);
  expect(summarize(records).recent[0].id).toBe(records[0].id);
  expect(records).toEqual(before);
});
