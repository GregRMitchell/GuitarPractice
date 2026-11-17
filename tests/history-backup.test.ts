import { expect, test } from 'vitest';
import { BACKUP_BYTE_LIMIT, exportHistory, parseHistoryBackup, previewHistoryImport } from '../src/history/backup';
import { validateRecord, type SwitchRecord } from '../src/history/model';

const record = validateRecord({
  id: '36a35dcc-e806-4fb9-96dc-a650bd21c010', completedAt: '2026-11-16T12:00:00Z',
  pair: ['A', 'D'], activeMs: 12_000, targetMs: 60_000, switches: 8,
  completed: false, tracking: 'microphone',
}) as SwitchRecord;

test('round-trips an explicit portable versioned backup without audio', () => {
  const json = exportHistory([record], '2026-11-16T12:00:00Z');
  expect(JSON.parse(json)).toEqual({
    format: 'guitar-practice-history', version: 2,
    exportedAt: '2026-11-16T12:00:00.000Z', records: [record],
  });
  expect(parseHistoryBackup(json).records).toEqual([record]);
});

test.each([
  { version: 3 }, { version: '1' }, { format: 'other' }, { exportedAt: 'invalid' },
  { records: [record, { ...record, switches: -1 }] }, { rawAudio: [] },
  { records: [{ ...record, completed: true }] },
  { records: [{ ...record, completed: false, activeMs: 60_000 }] },
  { records: [{ ...record, activeMs: 60_001 }] },
])('rejects an invalid backup as a whole: %j', (override) => {
  const backup = { format: 'guitar-practice-history', version: 1, exportedAt: record.completedAt, records: [record] };
  expect(() => parseHistoryBackup(JSON.stringify({ ...backup, ...override }))).toThrow();
});

test('checks UTF-8 bytes before parsing, including multibyte input', () => {
  expect(() => parseHistoryBackup('é'.repeat(BACKUP_BYTE_LIMIT / 2 + 1))).toThrow(/size|byte/i);
  expect(() => parseHistoryBackup('{')).toThrow(/JSON/i);
});

test('previews without mutation and includes file duplicates in the summary', () => {
  const next = { ...record, id: '36a35dcc-e806-4fb9-96dc-a650bd21c011' };
  const existing = Object.freeze([record]);
  const preview = previewHistoryImport(existing, [record, next, next]);
  expect(preview).toMatchObject({ added: 1, duplicates: 2 });
  expect(preview.records).toHaveLength(3);
  expect(existing).toEqual([record]);
  expect(Object.isFrozen(preview.records)).toBe(true);
  expect(() => previewHistoryImport(existing, [{ ...record, switches: 99 }])).toThrow(/conflict/i);
});

test('rejects conflicting duplicate ids inside a backup before preview or persistence', () => {
  const json = JSON.stringify({
    format: 'guitar-practice-history', version: 1, exportedAt: record.completedAt,
    records: [record, { ...record, switches: 10 }],
  });
  expect(() => parseHistoryBackup(json)).toThrow(/conflict/i);
});
