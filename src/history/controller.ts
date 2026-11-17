import type { SessionSnapshot } from '../session';
import { BACKUP_BYTE_LIMIT, exportHistory, parseHistoryBackup, previewHistoryImport,
  type HistoryImportPreview } from './backup';
import { HistoryError, validateRecord, type PracticeRecord, type PracticeResult } from './model';
import { openHistoryStore, type HistoryStore } from './store';

/** Observable local storage, retained-result and transfer state. */
export interface HistoryState {
  readonly opening: boolean;
  readonly storageError: string;
  readonly readError: string;
  readonly records: readonly PracticeRecord[] | null;
  readonly save: 'none' | 'saving' | 'saved' | 'error';
  readonly saveError: string;
  readonly busy: boolean;
  readonly selecting: boolean;
  readonly preview: HistoryImportPreview | null;
  readonly error: string;
  readonly message: string;
}

/** Injectable browser boundaries for device-only history coordination. */
export interface HistoryOptions {
  readonly open?: () => Promise<HistoryStore>;
  readonly uuid?: () => string;
  readonly now?: () => string;
  readonly changed: () => void;
}

/**
 * Convert known validation/storage failures to safe user-visible text.
 * @param error Untrusted operation failure.
 * @returns A categorized known message or a generic failure without internal details.
 */
export function historyError(error: unknown): string {
  return error instanceof HistoryError ? `${error.message} (${error.code})`
    : 'Local history operation failed. Your existing records were not replaced.';
}

/**
 * Coordinate autosave and explicitly confirmed transfers without fallback storage.
 * @param options Storage, identity, clock and state-notification boundaries.
 * @returns A controller whose safe() also protects retryable unsaved results.
 */
export function createHistoryController(options: HistoryOptions) {
  let state: HistoryState = {
    opening: true, storageError: '', readError: '', records: null, save: 'none',
    saveError: '', busy: false, selecting: false, preview: null, error: '', message: '',
  };
  let store: HistoryStore | null = null;
  let opening: Promise<HistoryStore | null>;
  let retained: PracticeRecord | null = null;
  let previous: SessionSnapshot['phase'] = 'idle';
  let selection = 0;
  let reading = 0;
  const notify = (): void => options.changed();
  const patch = (next: Partial<HistoryState>): void => { state = { ...state, ...next }; notify(); };
  const open = (): Promise<HistoryStore | null> => {
    state = { ...state, opening: true, storageError: '' };
    return (options.open ?? openHistoryStore)().then((value) => {
      store = value;
      patch({ opening: false, storageError: '' });
      return value;
    }).catch((error: unknown) => {
      patch({ opening: false, storageError: historyError(error) });
      return null;
    });
  };
  const connection = async (): Promise<HistoryStore> => {
    const value = store ?? await opening;
    if (!value) throw new HistoryError('open', 'History storage is unavailable. Retry local storage.');
    return value;
  };
  const refresh = async (): Promise<void> => {
    const token = ++reading;
    try {
      const records = await (await connection()).list();
      if (token === reading) patch({ records, readError: '' });
    } catch (error: unknown) {
      if (token === reading) patch({ readError: historyError(error) });
    }
  };
  const save = async (): Promise<void> => {
    if (!retained || state.save === 'saving') return;
    const record = retained;
    patch({ save: 'saving', saveError: '' });
    try {
      await (await connection()).save(record);
      patch({ save: 'saved' });
      await refresh();
    } catch (error: unknown) {
      patch({ save: 'error', saveError: historyError(error) });
    }
  };
  const safe = (): boolean => !state.busy && !state.selecting
    && state.save !== 'saving' && state.save !== 'error';
  opening = open();
  void refresh();
  return {
    /** Return the latest immutable-by-convention state snapshot. */
    state: (): HistoryState => state,
    /** Whether reload/new practice cannot lose an unfinished write or unsaved result. */
    safe,
    /** Refresh persisted records; stale reads never replace newer results. */
    refresh,
    /** Clear the prior saved result before starting a different practice mode. */
    beginRecord(): boolean {
      if (!safe()) return false;
      retained = null;
      state = { ...state, save: 'none', saveError: '' };
      return true;
    },
    /** Retain one finished mode summary with a stable identity; retry never creates duplicates. */
    retainRecord(result: PracticeResult): void {
      if (retained) return;
      try {
        retained = validateRecord({ ...result,
          id: (options.uuid ?? (() => crypto.randomUUID()))(),
          completedAt: (options.now ?? (() => new Date().toISOString()))(),
        });
        void save();
      } catch (error: unknown) {
        patch({ save: 'error', saveError: historyError(error) });
      }
    },
    /** Observe lifecycle changes; only one identity is allocated per retained round. */
    observe(run: SessionSnapshot): void {
      if (run.phase === 'starting' && previous !== 'starting' && safe()) {
        retained = null;
        state = { ...state, save: 'none', saveError: '' };
      }
      const finished = run.phase === 'finished' && previous !== 'finished';
      previous = run.phase;
      if (!finished || retained || run.discarded || run.elapsedMs <= 0
        || run.config.durationMs !== 60_000 || run.config.mode !== 'pair' || run.config.independent) return;
      try {
        retained = validateRecord({
          id: (options.uuid ?? (() => crypto.randomUUID()))(),
          completedAt: (options.now ?? (() => new Date().toISOString()))(),
          pair: run.config.pair, activeMs: run.elapsedMs, targetMs: run.config.durationMs,
          switches: run.events.length, completed: run.elapsedMs >= run.config.durationMs,
          tracking: 'microphone',
        });
        void save();
      } catch (error: unknown) {
        patch({ save: 'error', saveError: historyError(error) });
      }
    },
    /** Reopen unavailable storage and retry the exact retained result, if any. */
    async retry(): Promise<void> {
      if (state.opening || state.busy || state.selecting || state.save === 'saving') return;
      store?.close(); store = null;
      opening = open();
      notify();
      await opening;
      if (retained && state.save === 'error') await save();
      else await refresh();
    },
    /** Validate a bounded file and preview against a fresh persisted list without writing. */
    async select(file: Pick<File, 'size' | 'text'>): Promise<void> {
      if (state.busy || state.save === 'saving' || state.save === 'error') return;
      const token = ++selection;
      patch({ selecting: true, preview: null, error: '', message: '' });
      try {
        if (file.size > BACKUP_BYTE_LIMIT) throw new HistoryError('limit', 'History backup exceeds 5 MiB.');
        const json = await file.text();
        if (token !== selection) return;
        const backup = parseHistoryBackup(json);
        const existing = await (await connection()).list();
        if (token !== selection) return;
        patch({ preview: previewHistoryImport(existing, backup.records), records: existing, readError: '' });
      } catch (error: unknown) {
        if (token === selection) patch({ error: historyError(error) });
      } finally {
        if (token === selection) patch({ selecting: false });
      }
    },
    /** Cancel a preview or outstanding file read; never changes stored data. */
    cancel(): void {
      if (state.busy) return;
      selection++;
      patch({ selecting: false, preview: null, error: '', message: 'Import canceled. No records changed.' });
    },
    /** Atomically revalidate and merge only the confirmed incoming records. */
    async confirm(): Promise<void> {
      if (!state.preview || !safe()) return;
      const incoming = state.preview.records;
      patch({ busy: true, error: '' });
      try {
        const result = await (await connection()).merge(incoming);
        patch({ preview: null, message: `${result.added} added · ${result.duplicates} duplicates skipped.` });
        await refresh();
      } catch (error: unknown) {
        patch({ preview: null, error: historyError(error) });
      } finally { patch({ busy: false }); }
    },
    /** Export a fresh persisted snapshot using the strict bounded version-2 serializer. */
    async export(): Promise<string> {
      if (!safe()) throw new HistoryError('transaction', 'Wait for the current history operation.');
      patch({ busy: true, error: '', message: '' });
      try {
        return exportHistory(await (await connection()).list());
      } catch (error: unknown) {
        patch({ error: historyError(error) });
        throw error;
      } finally { patch({ busy: false }); }
    },
  };
}

/** Public controller surface shared by the UI and deterministic lifecycle tests. */
export type HistoryController = ReturnType<typeof createHistoryController>;
