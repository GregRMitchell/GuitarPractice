import { expect, test, vi } from 'vitest';
import { createHistoryController } from '../src/history/controller';
import { createSession, type SessionSnapshot } from '../src/session';
import { exportHistory } from '../src/history/backup';
import { HistoryError, mergeRecords, type PracticeRecord } from '../src/history/model';
import type { HistoryStore } from '../src/history/store';

const id = '12345678-1234-4234-8234-123456789abc';
const record: PracticeRecord = {
  id, pair: ['A', 'D'], completedAt: '2026-11-16T20:00:00.000Z',
  activeMs: 60_000, targetMs: 60_000, switches: 9, completed: true, tracking: 'microphone',
};
const base = createSession({
  now: () => 0, changed: () => {}, startCapture: () => new Promise(() => {}),
}).snapshot();
const run = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  ...base, config: { pair: ['A', 'D'], mode: 'pair', independent: false, durationMs: 60_000 },
  phase: 'finished', elapsedMs: 60_000, ...overrides,
});
const flush = async (): Promise<void> => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(open?: () => Promise<HistoryStore>) {
  let records: readonly PracticeRecord[] = [];
  const store: HistoryStore = {
    list: vi.fn(async () => [...records]),
    save: vi.fn(async (value) => { records = mergeRecords(records, [value]).records; }),
    merge: vi.fn(async (values) => {
      const merged = mergeRecords(records, values); records = merged.records; return merged;
    }),
    close: vi.fn(),
  };
  const uuid = vi.fn(() => id);
  const controller = createHistoryController({
    open: open ?? (async () => store), changed: vi.fn(), uuid,
    now: () => record.completedAt,
  });
  return { controller, store, uuid, records: () => records };
}
const file = (json: string): Pick<File, 'size' | 'text'> => ({
  size: new TextEncoder().encode(json).length, text: async () => json,
});

test('finished round waits for storage, saves once after transaction resolves, with stable id and completion time', async () => {
  const opened = deferred<HistoryStore>();
  const { controller, store, uuid } = fixture(() => opened.promise);
  const committed = deferred<void>();
  vi.mocked(store.save).mockReturnValue(committed.promise);
  controller.observe(run({ phase: 'starting' }));
  controller.observe(run());
  controller.observe(run());
  expect(controller.state().save).toBe('saving');
  expect(controller.safe()).toBe(false);
  expect(store.save).not.toHaveBeenCalled();
  opened.resolve(store);
  await flush();
  expect(store.save).toHaveBeenCalledOnce();
  expect(uuid).toHaveBeenCalledOnce();
  expect(store.save).toHaveBeenCalledWith({ ...record, switches: 0 });
  expect(controller.state().save).toBe('saving');
  committed.resolve();
  await flush();
  expect(controller.state().save).toBe('saved');
  expect(controller.safe()).toBe(true);
});

test('early retained rounds are not full minutes; discard, diagnostic, control, empty and intermediate attempts are excluded', async () => {
  const { controller, store } = fixture();
  await flush();
  for (const snapshot of [
    run({ phase: 'running' }), run({ discarded: true }), run({ elapsedMs: 0 }),
    run({ config: { ...base.config, mode: 'silence' } }),
    run({ config: { ...base.config, independent: false } }),
    run({ config: { ...run().config, independent: true } }),
  ]) {
    controller.observe(run({ phase: 'starting' }));
    controller.observe(snapshot);
  }
  await flush();
  expect(store.save).not.toHaveBeenCalled();
  controller.observe(run({ phase: 'starting' }));
  controller.observe(run({ elapsedMs: 1234.5 }));
  await flush();
  expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ activeMs: 1234.5, completed: false }));
});

test('open failure is nonfatal, finished result stays unsaved and retry reuses exact record identity', async () => {
  let store!: HistoryStore;
  const open = vi.fn(async () => {
    if (open.mock.calls.length === 1) throw new HistoryError('open', 'Cannot open history.');
    return store;
  });
  const fixtureValue = fixture(open);
  store = fixtureValue.store;
  const { controller, uuid } = fixtureValue;
  await flush();
  expect(controller.state().storageError).toContain('Cannot open');
  expect(controller.safe()).toBe(true);
  controller.observe(run({ phase: 'starting' }));
  controller.observe(run());
  await flush();
  expect(controller.state().save).toBe('error');
  expect(controller.safe()).toBe(false);
  await controller.retry();
  expect(controller.state().save).toBe('saved');
  expect(uuid).toHaveBeenCalledOnce();
  expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ id, completedAt: record.completedAt }));
});

test('write failure is visible and retry is idempotent even if a transaction already committed', async () => {
  const { controller, store, records } = fixture();
  const save = vi.mocked(store.save).getMockImplementation()!;
  vi.mocked(store.save).mockImplementationOnce(async (value) => {
    await save(value);
    throw new HistoryError('transaction', 'Transaction completion lost.');
  });
  controller.observe(run({ phase: 'starting' }));
  controller.observe(run());
  await flush();
  expect(controller.state().save).toBe('error');
  await controller.retry();
  expect(controller.state().save).toBe('saved');
  expect(records()).toHaveLength(1);
});

test('generic mode retention shares stable identity, retry and pending-save locks', async () => {
  const { controller, store, uuid, records } = fixture();
  vi.mocked(store.save).mockRejectedValueOnce(new HistoryError('quota', 'Storage is full.'));
  expect(controller.beginRecord()).toBe(true);
  const result = { mode: 'coach' as const, targetChord: 'Am' as const, activeMs: 1250,
    targetMs: 60_000, completed: false, confirmations: 2, successfulStrings: [1, 2],
    tracking: 'microphone' as const };
  controller.retainRecord(result);
  controller.retainRecord(result);
  await flush();
  expect(controller.state().save).toBe('error');
  expect(controller.beginRecord()).toBe(false);
  expect(controller.safe()).toBe(false);
  await controller.retry();
  expect(controller.state().save).toBe('saved');
  expect(uuid).toHaveBeenCalledOnce();
  expect(records()).toEqual([{ ...result, id, completedAt: record.completedAt }]);
  expect(controller.beginRecord()).toBe(true);
});

test('import requires confirmation, cancel does not mutate, duplicates skip and export uses persisted records', async () => {
  const { controller, records } = fixture();
  await flush();
  const selected = file(exportHistory([record, record]));
  await controller.select(selected);
  expect(controller.state().preview).toMatchObject({ added: 1, duplicates: 1 });
  expect(records()).toHaveLength(0);
  controller.cancel();
  await controller.confirm();
  expect(records()).toHaveLength(0);
  await controller.select(selected);
  await controller.confirm();
  expect(records()).toHaveLength(1);
  expect(controller.state().message).toMatch(/1 added.*1 duplicate/);
  await controller.select(selected);
  expect(controller.state().preview).toMatchObject({ added: 0, duplicates: 2 });
  controller.cancel();
  expect(JSON.parse(await controller.export()).records).toEqual([record]);
});

test('confirm rechecks against concurrent writes, rejects conflicts atomically, malformed/oversize input preserves data', async () => {
  const { controller, store, records } = fixture();
  await flush();
  await controller.select(file(exportHistory([record])));
  await store.save({ ...record, switches: 17 });
  await controller.confirm();
  expect(controller.state().error).toMatch(/conflict/i);
  expect(records()[0]).toMatchObject({ switches: 17 });
  await controller.select(file('{"records":['));
  expect(controller.state().preview).toBeNull();
  expect(controller.state().error).toMatch(/JSON/i);
  const text = vi.fn(async () => '');
  await controller.select({ size: 5 * 1024 * 1024 + 1, text });
  expect(text).not.toHaveBeenCalled();
  expect(records()).toHaveLength(1);
});

test('stale file reads and canceled previews cannot replace a newer selection or mutate data', async () => {
  const { controller, records } = fixture();
  await flush();
  const pending = deferred<string>();
  const first = controller.select({ size: 1, text: () => pending.promise });
  await controller.select(file(exportHistory([record])));
  pending.resolve('not JSON');
  await first;
  expect(controller.state().preview?.added).toBe(1);
  expect(controller.state().error).toBe('');
  controller.cancel();
  expect(controller.state().preview).toBeNull();
  expect(records()).toHaveLength(0);
});

test('newer refresh wins over a stale read and failed reads are visible without fabricating empty history', async () => {
  const { controller, store } = fixture();
  await flush();
  const stale = deferred<PracticeRecord[]>();
  vi.mocked(store.list).mockReturnValueOnce(stale.promise).mockResolvedValueOnce([record]);
  const olderRefresh = controller.refresh();
  await flush();
  await controller.refresh();
  stale.resolve([]);
  await olderRefresh;
  expect(controller.state().records).toEqual([record]);
  vi.mocked(store.list).mockRejectedValueOnce(new HistoryError('corrupt', 'Stored history is invalid.'));
  await controller.refresh();
  expect(controller.state().readError).toMatch(/invalid.*corrupt/);
  expect(controller.state().records).toEqual([record]);
});
