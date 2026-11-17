import {
  HISTORY_RECORD_LIMIT, HistoryError, mergeRecords, validateRecords,
  type HistoryMergeResult, type PracticeRecord,
} from './model';

/** Persistent device-local IndexedDB database name. */
export const HISTORY_DB_NAME = 'guitar-practice';
/** Only supported IndexedDB schema version; existing databases are never reset. */
export const HISTORY_DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';

/** Transactional device-only storage of validated practice summaries. */
export interface HistoryStore {
  /** Returns immutable validated records in newest-first order; rejects corrupt storage. */
  list(): Promise<PracticeRecord[]>;
  /** Saves a summary, skipping an identical UUID and rejecting conflicting content. */
  save(record: PracticeRecord): Promise<void>;
  /** Rechecks and atomically merges a selection against current persisted records. */
  merge(records: readonly PracticeRecord[]): Promise<HistoryMergeResult>;
  /** Closes this connection; subsequent operations reject explicitly. */
  close(): void;
}

function storageError(cause: unknown): HistoryError {
  if (cause instanceof HistoryError) return cause;
  const quota = cause instanceof DOMException && cause.name === 'QuotaExceededError';
  return new HistoryError(
    quota ? 'quota' : 'transaction',
    quota ? 'Device storage quota exceeded; no history changes were saved.' : 'History storage transaction failed.',
    { cause },
  );
}

function storedRecords(value: unknown): readonly PracticeRecord[] {
  try {
    const records = validateRecords(value);
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      throw new HistoryError('validation', 'Duplicate stored history UUID.');
    }
    return records;
  } catch (cause) {
    throw new HistoryError('corrupt', 'Stored history is invalid; existing data has not been changed.', { cause });
  }
}

function createStore(db: IDBDatabase): HistoryStore {
  let closed = false;
  const close = (): void => {
    closed = true;
    db.close();
  };
  db.onversionchange = close;

  function transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, records: readonly PracticeRecord[]) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new HistoryError('closed', 'History storage connection is closed.'));
        return;
      }
      let tx: IDBTransaction;
      try {
        tx = db.transaction(SESSIONS_STORE, mode);
      } catch (cause) {
        reject(storageError(cause));
        return;
      }
      let failure: HistoryError | undefined;
      let result: T;
      const abort = (cause: unknown): void => {
        failure = storageError(cause);
        try {
          tx.abort();
        } catch {
          reject(failure);
        }
      };
      tx.oncomplete = (): void => { resolve(result); };
      tx.onabort = (): void => { reject(failure ?? storageError(tx.error)); };
      tx.onerror = (event): void => {
        const requestError = (event.target as IDBRequest | null)?.error;
        failure ??= storageError(requestError ?? tx.error);
      };
      try {
        const store = tx.objectStore(SESSIONS_STORE);
        const request = store.getAll(undefined, HISTORY_RECORD_LIMIT + 1);
        request.onerror = (): void => { failure = storageError(request.error); };
        request.onsuccess = (): void => {
          try {
            result = operation(store, storedRecords(request.result));
          } catch (cause) {
            abort(cause);
          }
        };
      } catch (cause) {
        abort(cause);
      }
    });
  }

  const merge = async (records: readonly PracticeRecord[]): Promise<HistoryMergeResult> => {
    const incoming = validateRecords(records);
    return transact('readwrite', (store, existing) => {
      const plan = mergeRecords(existing, incoming);
      const ids = new Set(existing.map((record) => record.id));
      for (const record of plan.records) {
        if (!ids.has(record.id)) store.add(record);
      }
      return Object.freeze({ added: plan.added, duplicates: plan.duplicates });
    });
  };

  return {
    list: () => transact('readonly', (_store, records) =>
      [...records].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || a.id.localeCompare(b.id))),
    save: async (record) => { await merge([record]); },
    merge,
    close,
  };
}

/** Opens persistent IndexedDB storage, rejecting unavailable or incompatible storage without fallback. */
export function openHistoryStore(): Promise<HistoryStore> {
  return new Promise<HistoryStore>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      if (!globalThis.indexedDB) {
        reject(new HistoryError('unsupported', 'IndexedDB is unavailable; history cannot be saved on this device.'));
        return;
      }
      request = globalThis.indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    } catch (cause) {
      reject(new HistoryError('open', 'Unable to open device history storage.', { cause }));
      return;
    }
    let failed = false;
    const fail = (error: HistoryError): void => {
      failed = true;
      reject(error);
    };
    request.onblocked = (): void => {
      fail(new HistoryError('blocked', 'History storage is blocked by another open tab. Close that tab and retry.'));
    };
    request.onupgradeneeded = (event): void => {
      if (failed) {
        request.transaction?.abort();
        return;
      }
      try {
        if (event.oldVersion !== 0) throw new Error('Unsupported history schema migration.');
        request.result.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
      } catch (cause) {
        fail(new HistoryError('migration', 'History storage schema could not be initialized.', { cause }));
        request.transaction?.abort();
      }
    };
    request.onerror = (): void => {
      if (failed) return;
      const cause = request.error;
      const versionError = cause?.name === 'VersionError';
      fail(new HistoryError(
        versionError ? 'migration' : 'open',
        versionError ? 'History storage was created by a newer application version.' : 'Unable to open device history storage.',
        { cause },
      ));
    };
    request.onsuccess = (): void => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      try {
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) throw new Error('Missing sessions store.');
        const store = db.transaction(SESSIONS_STORE, 'readonly').objectStore(SESSIONS_STORE);
        if (store.keyPath !== 'id' || store.autoIncrement) throw new Error('Incompatible sessions key schema.');
        resolve(createStore(db));
      } catch (cause) {
        db.close();
        fail(new HistoryError('migration', 'History storage schema is incompatible; existing data has not been changed.', { cause }));
      }
    };
  });
}
