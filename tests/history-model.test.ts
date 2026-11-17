import { expect, test } from 'vitest';
import {
  HISTORY_RECORD_LIMIT, MAX_DURATION_MS, MAX_SWITCHES, mergeRecords, validateRecord, type SwitchRecord,
} from '../src/history/model';

export const recordInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '36a35dcc-e806-4fb9-96dc-a650bd21c010',
  completedAt: '2026-11-16T12:00:00.000Z',
  pair: ['D', 'A'],
  activeMs: 60_000,
  targetMs: 60_000,
  switches: 24,
  completed: true,
  tracking: 'microphone',
  ...overrides,
});

test('validates, canonicalizes, copies, and deeply freezes a record', () => {
  const input = recordInput({ completedAt: '2026-11-16T06:00:00-06:00' });
  const record = validateRecord(input) as SwitchRecord;
  expect(record.pair).toEqual(['A', 'D']);
  expect(record.completedAt).toBe('2026-11-16T12:00:00.000Z');
  (input.pair as string[])[0] = 'G';
  expect(record.pair).toEqual(['A', 'D']);
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(record.pair)).toBe(true);
  expect(validateRecord(recordInput({ completed: false, activeMs: 1.5 })).completed).toBe(false);
});

test.each([
  { id: 'not-a-uuid' }, { pair: ['A', 'A'] }, { pair: ['A', 'B'] },
  { pair: ['A', 'D', 'G'] }, { activeMs: 0 }, { activeMs: Infinity },
  { completed: true, activeMs: 12_000, targetMs: 60_000 },
  { completed: false, activeMs: 60_000, targetMs: 60_000 },
  { completed: false, activeMs: 60_001, targetMs: 60_000 },
  { targetMs: NaN }, { targetMs: MAX_DURATION_MS + 1 },
  { activeMs: MAX_DURATION_MS + 1 }, { switches: -1 }, { switches: 1.1 },
  { switches: MAX_SWITCHES + 1 }, { completed: 'true' }, { tracking: 'manual' },
  { completedAt: '2026-02-30T00:00:00Z' }, { completedAt: '2026-11-16' },
  { completedAt: '2026-11-16T24:00:00Z' }, { audio: [1, 2] }, { version: 2 },
])('rejects invalid or foreign data: %j', (overrides) => {
  expect(() => validateRecord(recordInput(overrides))).toThrow();
});

test('rejects inherited record fields and missing fields', () => {
  expect(() => validateRecord(Object.create(recordInput()))).toThrow();
  const input = recordInput();
  delete input.completed;
  expect(() => validateRecord(input)).toThrow();
  expect(() => validateRecord(Object.defineProperty(recordInput(), 'pair', {
    get: () => ['A', 'D'],
  }))).toThrow();
});

test('accepts finite ISO dates outside current time and preserves revalidation across year boundaries', () => {
  const record = validateRecord(recordInput({ completedAt: '0000-01-01T00:00:00+01:00' }));
  expect(record.completedAt).toBe('-000001-12-31T23:00:00.000Z');
  expect(validateRecord(record)).toEqual(record);
  expect(validateRecord(recordInput({ completedAt: '9999-12-31T23:00:00-01:00' })).completedAt)
    .toBe('+010000-01-01T00:00:00.000Z');
});

test('rejects sparse or decorated chord arrays instead of accepting unsupported values', () => {
  const pair = new Array(2);
  pair[1] = 'D';
  expect(() => validateRecord(recordInput({ pair }))).toThrow();
  const decorated = Object.assign(['A', 'D'], { audio: [] });
  expect(() => validateRecord(recordInput({ pair: decorated }))).toThrow();
});

test('merges by canonical identity, skips exact duplicates, and rejects conflicts', () => {
  const a = validateRecord(recordInput());
  const b = validateRecord(recordInput({ id: '36a35dcc-e806-4fb9-96dc-a650bd21c011' }));
  expect(mergeRecords([a], [b, a, b])).toMatchObject({ added: 1, duplicates: 2, records: [a, b] });
  expect(() => mergeRecords([a], [recordInput({ switches: 99 })])).toThrow(/conflict/i);
  expect(() => mergeRecords([], [a, recordInput({ switches: 99 })])).toThrow(/conflict/i);
  expect(a.mode === undefined && a.switches).toBe(24);
});

test('enforces input and merged record limits without truncating', () => {
  expect(() => mergeRecords([], Array(HISTORY_RECORD_LIMIT + 1).fill(recordInput()))).toThrow(/limit/i);
  const full = Array.from({ length: HISTORY_RECORD_LIMIT }, (_, index) => recordInput({
    id: `36a35dcc-e806-4fb9-96dc-${index.toString(16).padStart(12, '0')}`,
  }));
  expect(() => mergeRecords(full, [recordInput()])).toThrow(/limit/i);
});
