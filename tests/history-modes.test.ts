import { expect, test } from 'vitest';
import { mergeRecords, validateRecord } from '../src/history/model';
import { exportHistory, parseHistoryBackup } from '../src/history/backup';
import { summarize } from '../src/history/stats';
import { rhythmPattern } from '../src/rhythm/patterns';
import { expectedStrokes } from '../src/rhythm/scoring';

const common = {
  id: 'a0b1c2d3-1111-4111-8111-111111111111', completedAt: '2026-11-16T12:00:00Z',
  activeMs: 30_000, targetMs: 60_000, completed: false,
};
const switches = { ...common, pair: ['D', 'A'], switches: 7, tracking: 'microphone' };
const coach = { ...common, id: 'a0b1c2d3-1111-4111-8111-222222222222',
  mode: 'coach', targetChord: 'Am', confirmations: 3, successfulStrings: [1, 3],
  tracking: 'microphone' };
const rhythm = { ...common, id: 'a0b1c2d3-1111-4111-8111-333333333333',
  mode: 'rhythm', heldChord: 'E', bpm: 80, patternId: 'quarters', audible: true,
  soundMode: 'beat',
  timingMeasured: false, expected: 40, estimatedStrums: null, matched: null,
  missed: null, extra: null, meanAbsoluteOffsetMs: null, tracking: 'guided' };
const progression = { ...common, id: 'a0b1c2d3-1111-4111-8111-444444444444',
  mode: 'progression', sequence: ['G', 'D', 'Em', 'C'], bpm: 80, barsPerChord: 1, loops: 2,
  activeMs: 24_000, targetMs: 24_000, completed: true, patternId: 'quarters', audible: true,
  soundMode: 'beat', timingMeasured: false, expected: 32, estimatedStrums: null, matched: null,
  missed: null, extra: null, meanAbsoluteOffsetMs: null, tracking: 'guided' };

test('progressions round-trip as self-contained records without counting chord switches', () => {
  const records = [switches, progression].map(validateRecord);
  expect(parseHistoryBackup(exportHistory(records)).records).toEqual(records);
  expect(summarize(records).totals).toMatchObject({ rounds: 2, switches: 7, progressionRounds: 1, progressionActiveMs: 24_000 });
  expect(summarize(records).pairs).toHaveLength(1);
  expect(mergeRecords(records, records)).toMatchObject({ duplicates: 2 });
  expect(() => mergeRecords(records, [{ ...progression, sequence: ['G', 'C', 'Em', 'C'] }])).toThrow(/conflict/i);
});

test('progressions reject invalid sequence, target, measured counts and extra fields', () => {
  const hole = ['G', 'D'];
  delete hole[1];
  for (const value of [
    { ...progression, sequence: ['G'] }, { ...progression, sequence: ['G', 'bogus'] },
    { ...progression, sequence: hole },
    { ...progression, sequence: Object.assign(['G', 'D'], { audio: [] }) },
    { ...progression, targetMs: 25_000 }, { ...progression, loops: 9 },
    { ...progression, matched: 1 }, { ...progression, pcm: [] },
  ]) expect(() => validateRecord(value)).toThrow();
});

test('fractional tempo targets are canonicalized without converting an early finish into completion', () => {
  const targetMs = 2 * 4 * 60 / 120.5 * 1000;
  const record = { ...progression, sequence: ['G', 'D'], bpm: 120.5, loops: 1,
    targetMs, activeMs: targetMs, completed: true, expected: 8 };
  expect(validateRecord({ ...record, targetMs: targetMs + 1e-8, activeMs: targetMs + 1e-8 }))
    .toMatchObject({ targetMs, activeMs: targetMs, completed: true });
  expect(validateRecord({ ...record, activeMs: targetMs - 0.001, completed: false }))
    .toMatchObject({ targetMs, activeMs: targetMs - 0.001, completed: false });
  expect(() => validateRecord({ ...record, targetMs: targetMs + 1 })).toThrow();
});

test('progression expected strokes must match its actual duration, tempo and pattern', () => {
  const measured = { ...progression, timingMeasured: true, tracking: 'microphone',
    expected: 32, estimatedStrums: 12, matched: 10, missed: 22, extra: 2, meanAbsoluteOffsetMs: 20 };
  for (const record of [progression, measured]) {
    expect(validateRecord(record)).toMatchObject({ expected: 32 });
    const forged = record.timingMeasured
      ? { ...record, expected: 999, missed: 989 }
      : { ...record, expected: 999 };
    expect(() => validateRecord(forged)).toThrow(/expected/i);
    expect(() => parseHistoryBackup(JSON.stringify({ format: 'guitar-practice-history', version: 2,
      exportedAt: common.completedAt, records: [forged] }))).toThrow(/expected/i);
  }
});

test('progression expected count follows early boundaries and fractional-tempo scorer semantics', () => {
  const cases = [
    { ...progression, activeMs: 1, completed: false, expected: 1 },
    { ...progression, activeMs: 750, completed: false, expected: 1 },
    { ...progression, activeMs: 751, completed: false, expected: 2 },
    { ...progression, patternId: 'offbeat-ups', activeMs: 375, completed: false, expected: 0 },
    { ...progression, patternId: 'offbeat-ups', activeMs: 376, completed: false, expected: 1 },
    { ...progression, sequence: ['G', 'D'], bpm: 120.5, loops: 1,
      targetMs: 8 * 60 / 120.5 * 1000, activeMs: 4 * 60 / 120.5 * 1000,
      completed: false, expected: 4 },
  ];
  for (const record of cases) {
    expect(validateRecord(record)).toMatchObject({ expected: record.expected });
    expect(() => validateRecord({ ...record, expected: record.expected + 1 })).toThrow(/expected/i);
    const measured = { ...record, timingMeasured: true, tracking: 'microphone',
      estimatedStrums: 0, matched: 0, missed: record.expected, extra: 0, meanAbsoluteOffsetMs: null };
    expect(validateRecord(measured)).toMatchObject({ expected: record.expected });
    expect(() => validateRecord({ ...measured, expected: record.expected + 1, missed: record.expected + 1 }))
      .toThrow(/expected/i);
  }
});

test('a valid scorer result survives a lossy seconds-to-milliseconds history round trip', () => {
  const bpm = 40.1;
  const seconds = 23.94014963593516;
  const expected = expectedStrokes(rhythmPattern('eighths'), bpm, seconds).length;
  const record = { ...progression, bpm, patternId: 'eighths', activeMs: seconds * 1000,
    targetMs: 4 * 1 * 2 * 4 * 60 / bpm * 1000, completed: false, expected };
  expect(expectedStrokes(rhythmPattern('eighths'), bpm, record.activeMs / 1000)).toHaveLength(expected + 1);
  expect(validateRecord(record)).toMatchObject({ expected });
  expect(() => validateRecord({ ...record, expected: expected + 2 })).toThrow(/expected/i);
  expect(() => validateRecord({ ...progression, activeMs: Number.MIN_VALUE, completed: false, expected: 1 }))
    .toThrow(/expected/i);
});

test('mixed history retains honest metrics and pair records only for switches', () => {
  const records = [switches, coach, rhythm].map(validateRecord);
  const summary = summarize(records);
  expect(summary.totals).toMatchObject({ rounds: 3, activeMs: 90_000, switches: 7,
    coachRounds: 1, coachConfirmations: 3, rhythmRounds: 1 });
  expect(summary.pairs).toHaveLength(1);
  expect(summary.pairs[0]).toMatchObject({ rounds: 1, switches: 7, best60s: null });
  expect(parseHistoryBackup(exportHistory(records)).records).toEqual(records);
});

test('v1 remains readable and canonical duplicate is identical in v2', () => {
  const legacy = parseHistoryBackup(JSON.stringify({ format: 'guitar-practice-history',
    version: 1, exportedAt: common.completedAt, records: [switches] }));
  const modern = parseHistoryBackup(exportHistory(legacy.records));
  expect(JSON.parse(exportHistory(legacy.records)).version).toBe(2);
  expect(mergeRecords(legacy.records, modern.records)).toMatchObject({ added: 0, duplicates: 1 });
  expect(mergeRecords([switches], [{ ...switches, mode: 'switches' }])).toMatchObject({ duplicates: 1 });
});

test('mode codecs reject extra audio data, false measured scores, invalid strings and completion', () => {
  for (const record of [
    { ...coach, pcm: [] }, { ...coach, successfulStrings: [1, 1] },
    { ...coach, successfulStrings: [0] }, { ...coach, completed: true },
    { ...rhythm, matched: 4 }, { ...rhythm, bpm: 161 },
    { ...rhythm, timingMeasured: true, tracking: 'microphone' },
    { ...rhythm, patternId: 'unknown' },
    { ...rhythm, soundMode: 'unknown' },
  ]) expect(() => validateRecord(record)).toThrow();
  expect(() => parseHistoryBackup(JSON.stringify({ format: 'guitar-practice-history',
    version: 1, exportedAt: common.completedAt, records: [coach] }))).toThrow();
});

test('mixed conflicting transfers reject atomically', () => {
  const before = [validateRecord(coach)];
  expect(() => mergeRecords(before, [rhythm, { ...coach, confirmations: 9 }])).toThrow(/conflict/i);
  expect(before).toEqual([validateRecord(coach)]);
});

test('expanded chords and patterns survive portable transfers and duplicate import', () => {
  const values = [
    { ...switches, pair: ['F', 'Bm'] },
    { ...coach, targetChord: 'Bm', successfulStrings: [1, 5] },
    { ...rhythm, heldChord: 'F', patternId: 'offbeat-ups', soundMode: 'strums' },
  ];
  const records = values.map(validateRecord);
  const imported = parseHistoryBackup(exportHistory(records)).records;
  expect(imported).toEqual(records);
  expect(mergeRecords(records, imported)).toMatchObject({ added: 0, duplicates: 3 });
});
