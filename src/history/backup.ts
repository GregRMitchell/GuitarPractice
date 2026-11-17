import {
  exactObject, HistoryError, mergeRecords, validateRecords, validateTimestamp,
  type HistoryMergeResult, type PracticeRecord,
} from './model';

/** Maximum UTF-8 transfer size, checked before parsing untrusted JSON. */
export const BACKUP_BYTE_LIMIT = 5 * 1024 * 1024;
/** Identifier for the only supported backup format. */
export const BACKUP_FORMAT = 'guitar-practice-history';
/** The exact backup schema version supported by this application. */
export const BACKUP_VERSION = 2;

/** Versioned portable summary data; contains no microphone recordings. */
export interface HistoryBackup {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
  readonly records: readonly PracticeRecord[];
}

/** Import selection retained for confirmation and rechecking inside the final transaction. */
export interface HistoryImportPreview extends HistoryMergeResult {
  readonly records: readonly PracticeRecord[];
}

function checkSize(json: string): void {
  if (json.length > BACKUP_BYTE_LIMIT || new TextEncoder().encode(json).byteLength > BACKUP_BYTE_LIMIT) {
    throw new HistoryError('limit', 'History backup exceeds the 5 MiB byte size limit.');
  }
}

/** Serializes only validated summary fields into a bounded version-2 JSON backup. */
export function exportHistory(records: readonly PracticeRecord[], exportedAt = new Date().toISOString()): string {
  const backup: HistoryBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: validateTimestamp(exportedAt),
    records: validateRecords(records),
  };
  const json = JSON.stringify(backup, null, 2);
  checkSize(json);
  return json;
}

/** Parses bounded JSON and validates the whole versioned backup before returning any records. */
export function parseHistoryBackup(json: string): HistoryBackup {
  if (typeof json !== 'string') throw new HistoryError('validation', 'Expected JSON text.');
  checkSize(json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new HistoryError('validation', 'Invalid history JSON.', { cause });
  }
  const input = exactObject(parsed, ['format', 'version', 'exportedAt', 'records']);
  if (input.format !== BACKUP_FORMAT || (input.version !== 1 && input.version !== BACKUP_VERSION)) {
    throw new HistoryError('validation', 'Unsupported history backup format or version.');
  }
  if (input.version === 1 && Array.isArray(input.records)
    && input.records.some((record: unknown) => typeof record === 'object' && record !== null && Object.hasOwn(record, 'mode'))) {
    throw new HistoryError('validation', 'Version 1 accepts only legacy chord-switch fields.');
  }
  const records = validateRecords(input.records);
  if (input.version === 1 && records.some((record) => record.mode !== undefined)) {
    throw new HistoryError('validation', 'Version 1 accepts only legacy chord-switch records.');
  }
  // Detect conflicts within the file even when no device history has been loaded yet.
  mergeRecords([], records);
  return Object.freeze({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: validateTimestamp(input.exportedAt),
    records,
  });
}

/** Previews a selection without mutation; final store.merge must recheck current persisted history. */
export function previewHistoryImport(existing: readonly PracticeRecord[], incoming: readonly PracticeRecord[]): HistoryImportPreview {
  const records = validateRecords(incoming);
  const { added, duplicates } = mergeRecords(existing, records);
  return Object.freeze({ records, added, duplicates });
}
