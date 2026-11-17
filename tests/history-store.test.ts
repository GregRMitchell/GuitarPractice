import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HISTORY_DB_NAME, HISTORY_DB_VERSION, openHistoryStore, type HistoryStore } from '../src/history/store';
import { HISTORY_RECORD_LIMIT, validateRecord, type PracticeRecord } from '../src/history/model';
import { HistoryIDBFake } from './history-idb-fake';

let fake: HistoryIDBFake;
const stores: HistoryStore[] = [];

beforeEach(() => {
  fake = new HistoryIDBFake();
  vi.stubGlobal('indexedDB', fake.factory);
});
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.unstubAllGlobals();
});

function record(index = 0, overrides: Record<string, unknown> = {}): PracticeRecord {
  return validateRecord({
    id: `36a35dcc-e806-4fb9-96dc-${index.toString(16).padStart(12, '0')}`,
    completedAt: '2026-11-16T12:00:00Z', pair: ['D', 'A'], activeMs: 60_000,
    targetMs: 60_000, switches: 24, completed: true, tracking: 'microphone', ...overrides,
  });
}

async function open(): Promise<HistoryStore> {
  const store = await openHistoryStore();
  stores.push(store);
  return store;
}

test('persists summaries across connections, returns immutable copies, and saves idempotently', async () => {
  const store = await open();
  expect(fake.openedName).toBe(HISTORY_DB_NAME);
  expect(fake.openedVersion).toBe(HISTORY_DB_VERSION);
  await store.save(record());
  await store.save(record());
  const reopened = await open();
  const rows = await reopened.list();
  expect(rows).toEqual([record()]);
  expect(Object.isFrozen(rows[0])).toBe(true);
  expect(fake.writes).toBe(1);
});

test('merges atomically, rejects conflicts, and leaves original records intact', async () => {
  const store = await open();
  await store.save(record());
  expect(await store.merge([record(), record(1), record(1)])).toEqual({ added: 1, duplicates: 2 });
  await expect(store.merge([record(2), record(0, { switches: 99 })])).rejects.toMatchObject({ code: 'conflict' });
  expect(await store.list()).toEqual([record(), record(1)]);
  await expect(store.save(record(0, { switches: 50 }))).rejects.toMatchObject({ code: 'conflict' });
});

test('rechecks concurrent writers within the transaction instead of overwriting stale snapshots', async () => {
  const first = await open();
  const second = await open();
  expect(await Promise.all([first.merge([record()]), second.merge([record()])])).toEqual([
    { added: 1, duplicates: 0 }, { added: 0, duplicates: 1 },
  ]);
  expect(await first.list()).toHaveLength(1);
});

test('a concurrent id conflict rejects the later writer without overwriting the first', async () => {
  const first = await open();
  const second = await open();
  const results = await Promise.allSettled([
    first.save(record()), second.save(record(0, { switches: 30 })),
  ]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
  expect(await first.list()).toEqual([record()]);
});

test('rolls back a partially attempted batch on quota failure and reports an explicit error', async () => {
  const store = await open();
  await store.save(record());
  fake.failWriteAt = fake.writes + 2;
  await expect(store.merge([record(1), record(2)])).rejects.toMatchObject({ code: 'quota' });
  expect(await store.list()).toEqual([record()]);
});

test('validates every incoming record before opening a write transaction', async () => {
  const store = await open();
  await expect(store.merge([record(), { ...record(1), tracking: 'other' } as unknown as PracticeRecord]))
    .rejects.toMatchObject({ code: 'validation' });
  expect(fake.writes).toBe(0);
  expect(await store.list()).toEqual([]);
});

test.each([
  { completed: true, activeMs: 12_000, targetMs: 60_000 },
  { completed: false, activeMs: 60_000, targetMs: 60_000 },
  { completed: false, activeMs: 60_001, targetMs: 60_000 },
])('rejects inconsistent imported durations without mutating stored history: %j', async (overrides) => {
  const store = await open();
  await store.save(record());
  const writesBeforeImport = fake.writes;

  await expect(store.merge([record(1), { ...record(2), ...overrides } as PracticeRecord]))
    .rejects.toMatchObject({ code: 'validation' });

  expect(fake.writes).toBe(writesBeforeImport);
  expect(await store.list()).toEqual([record()]);
});

test('rejects corrupt stored data rather than silently deleting or filtering it', async () => {
  const store = await open();
  fake.records.set(record().id, { ...record(), rawAudio: [] });
  await expect(store.list()).rejects.toMatchObject({ code: 'corrupt' });
  await expect(store.merge([record(1)])).rejects.toMatchObject({ code: 'corrupt' });
  expect(fake.records.size).toBe(1);
});

test('allows an exact duplicate at capacity but rejects any new record without eviction', async () => {
  const store = await open();
  for (let index = 0; index < HISTORY_RECORD_LIMIT; index++) {
    const row = record(index);
    fake.records.set(row.id, row);
  }
  await store.save(record());
  await expect(store.save(record(HISTORY_RECORD_LIMIT))).rejects.toMatchObject({ code: 'limit' });
  expect(fake.records.size).toBe(HISTORY_RECORD_LIMIT);
  expect(fake.writes).toBe(0);
});

test('reports unsupported, blocked, opening and future-version errors without fallback', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(openHistoryStore()).rejects.toMatchObject({ code: 'unsupported' });
  vi.stubGlobal('indexedDB', fake.factory);
  fake.blocked = true;
  await expect(openHistoryStore()).rejects.toMatchObject({ code: 'blocked' });
  fake.blocked = false;
  fake.openError = new DOMException('Newer DB', 'VersionError');
  await expect(openHistoryStore()).rejects.toMatchObject({ code: 'migration' });
  fake.openError = new DOMException('Not allowed', 'SecurityError');
  await expect(openHistoryStore()).rejects.toMatchObject({ code: 'open' });
});

test('rejects incompatible existing schema without resetting any records', async () => {
  fake.version = 1;
  fake.keyPath = 'wrong';
  fake.records.set(record().id, record());
  await expect(openHistoryStore()).rejects.toMatchObject({ code: 'migration' });
  expect(fake.records.size).toBe(1);
});

test('reports transaction failures and closed-store use explicitly', async () => {
  const store = await open();
  fake.failTransaction = true;
  await expect(store.list()).rejects.toMatchObject({ code: 'transaction' });
  await expect(store.save(record())).rejects.toMatchObject({ code: 'transaction' });
  fake.failTransaction = false;
  store.close();
  await expect(store.list()).rejects.toMatchObject({ code: 'closed' });
  await expect(store.save(record())).rejects.toMatchObject({ code: 'closed' });
});
