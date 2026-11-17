import { CHORDS, type Chord, type Pair } from '../chords';
import { chordFrets } from '../diagrams';
import { RHYTHM_PATTERNS, rhythmPattern, type PatternId } from '../rhythm/patterns';
import { expectedStrokes } from '../rhythm/scoring';
import { progressionDuration } from '../progression/timeline';

/** Maximum number of records retained or accepted in a single transfer. */
export const HISTORY_RECORD_LIMIT = 10_000;
/** Maximum supported active or target round duration (24 hours). */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
/** Upper bound on a round's switch count. */
export const MAX_SWITCHES = 1_000_000;

/** Portable, immutable device-only summary; never contains audio or observations. */
export interface SwitchRecord {
  readonly mode?: 'switches';
  readonly id: string;
  readonly completedAt: string;
  readonly pair: Pair;
  readonly activeMs: number;
  readonly targetMs: number;
  readonly switches: number;
  readonly completed: boolean;
  readonly tracking: 'microphone';
}

/** Common portable duration and identity, never audio or observations. */
export interface RecordBase {
  readonly id: string;
  readonly completedAt: string;
  readonly activeMs: number;
  readonly targetMs: number;
  readonly completed: boolean;
}

/** Stable coaching confirmations and unique selected pitch matches, not quality certification. */
export interface CoachRecord extends RecordBase {
  readonly mode: 'coach';
  readonly targetChord: Chord;
  readonly confirmations: number;
  readonly successfulStrings: readonly number[];
  readonly tracking: 'microphone';
}

/** Guided rhythm or optional uncalibrated microphone timing estimates. */
export interface RhythmRecord extends RecordBase {
  readonly mode: 'rhythm';
  readonly heldChord: Chord;
  readonly bpm: number;
  readonly patternId: PatternId;
  readonly audible: boolean;
  readonly soundMode: 'beat' | 'strums';
  readonly timingMeasured: boolean;
  readonly expected: number;
  readonly estimatedStrums: number | null;
  readonly matched: number | null;
  readonly missed: number | null;
  readonly extra: number | null;
  readonly meanAbsoluteOffsetMs: number | null;
  readonly tracking: 'microphone' | 'guided';
}

/** Guided chord prompts with optional timing estimates; chord changes are not detected. */
export interface ProgressionRecord extends Omit<RhythmRecord, 'mode' | 'heldChord'> {
  readonly mode: 'progression';
  readonly sequence: readonly Chord[];
  readonly barsPerChord: number;
  readonly loops: number;
}

/** Backward-compatible discriminated local-only round summary. Missing mode means switches. */
export type PracticeRecord = SwitchRecord | CoachRecord | RhythmRecord | ProgressionRecord;
/** A completed mode result before the history coordinator assigns its stable identity. */
export type PracticeResult = Omit<CoachRecord, 'id' | 'completedAt'> | Omit<RhythmRecord, 'id' | 'completedAt'>
  | Omit<ProgressionRecord, 'id' | 'completedAt'>;

/** Categorized failures that callers can surface without treating lost storage as success. */
export type HistoryErrorCode =
  | 'validation' | 'limit' | 'conflict' | 'unsupported' | 'blocked'
  | 'open' | 'migration' | 'transaction' | 'quota' | 'corrupt' | 'closed';

/** History operation failure with a stable machine-readable code and optional cause. */
export class HistoryError extends Error {
  /** Constructs an error describing the failed operation and its underlying cause. */
  constructor(
    public readonly code: HistoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HistoryError';
  }
}

const RECORD_FIELDS = [
  'id', 'completedAt', 'pair', 'activeMs', 'targetMs', 'switches', 'completed', 'tracking',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TIMING_OFFSET_MS = 100 + 1e-6;
const ISO_DATE = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function invalid(message: string): never {
  throw new HistoryError('validation', message);
}

/** Validates exact own data fields on a plain object; rejects foreign or inherited data. */
export function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('Expected a history object.');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid('Expected a plain history object.');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    return invalid('History object has missing or unsupported fields.');
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) {
      return invalid('History fields must be own data fields.');
    }
  }
  return value as Record<string, unknown>;
}

/** Validates an ISO timestamp including calendar dates and returns canonical UTC form. */
export function validateTimestamp(value: unknown): string {
  if (typeof value !== 'string') return invalid('Expected an ISO timestamp.');
  const match = ISO_DATE.exec(value);
  if (!match) return invalid('Expected an ISO timestamp including a timezone.');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    month < 1 || month > 12 || day < 1 || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCFullYear() !== year
    || hour > 23 || minute > 59 || second > 59
  ) return invalid('Invalid ISO calendar timestamp.');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return invalid('Invalid ISO timestamp.');
  return new Date(time).toISOString();
}

function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_DURATION_MS) {
    return invalid('Round duration must be positive and no longer than 24 hours.');
  }
  return value;
}

/** Validates untrusted input, canonicalizes its pair/time/id, and returns a frozen copy. */
export function validateRecord(value: unknown): PracticeRecord {
  const descriptor = typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, 'mode') : undefined;
  const mode: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (mode === 'coach' || mode === 'rhythm' || mode === 'progression') return validateModeRecord(value, mode);
  const input = exactObject(value, mode === 'switches' ? [...RECORD_FIELDS, 'mode'] : RECORD_FIELDS);
  if (typeof input.id !== 'string' || !UUID.test(input.id)) return invalid('Invalid record UUID.');
  const pair = input.pair;
  if (
    !Array.isArray(pair) || pair.length !== 2 || Reflect.ownKeys(pair).length !== 3
    || !Object.hasOwn(pair, 0) || !Object.hasOwn(pair, 1)
    || !pair.every((chord: unknown) => typeof chord === 'string' && Object.hasOwn(CHORDS, chord))
    || pair[0] === pair[1]
  ) return invalid('Expected two distinct supported chords.');
  if (
    typeof input.switches !== 'number' || !Number.isSafeInteger(input.switches)
    || input.switches < 0 || input.switches > MAX_SWITCHES
  ) return invalid('Invalid switch count.');
  if (typeof input.completed !== 'boolean' || input.tracking !== 'microphone') {
    return invalid('Invalid round completion or tracking type.');
  }
  const activeMs = duration(input.activeMs);
  const targetMs = duration(input.targetMs);
  if (activeMs > targetMs || input.completed !== (activeMs === targetMs)) {
    return invalid('Round completion must match its duration.');
  }
  const canonicalPair = [...pair].sort() as [Chord, Chord];
  return Object.freeze({
    id: input.id.toLowerCase(),
    completedAt: validateTimestamp(input.completedAt),
    pair: Object.freeze(canonicalPair),
    activeMs,
    targetMs,
    switches: input.switches,
    completed: input.completed,
    tracking: 'microphone',
  });
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SWITCHES) {
    return invalid('Invalid practice count.');
  }
  return value;
}

function chord(value: unknown): Chord {
  if (typeof value !== 'string' || !Object.hasOwn(CHORDS, value)) return invalid('Unsupported chord.');
  return value as Chord;
}

function progressionExpectedMatches(
  expected: number, patternId: PatternId, bpm: number, activeMs: number, completedSeconds: number | null,
): boolean {
  const pattern = rhythmPattern(patternId);
  const seconds = completedSeconds ?? activeMs / 1000;
  if (expectedStrokes(pattern, bpm, seconds).length === expected) return true;
  if (completedSeconds !== null) return false;
  // The recorded milliseconds can round two adjacent audio-clock values to the same number.
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, seconds);
  const value = bits.getBigUint64(0);
  for (const neighbor of value === 0n ? [value + 1n] : [value - 1n, value + 1n]) {
    bits.setBigUint64(0, neighbor);
    const candidate = bits.getFloat64(0);
    if (candidate * 1000 === activeMs && expectedStrokes(pattern, bpm, candidate).length === expected) return true;
  }
  return false;
}

function validateModeRecord(value: unknown, mode: 'coach' | 'rhythm' | 'progression'): PracticeRecord {
  const fields = ['id', 'completedAt', 'mode', 'activeMs', 'targetMs', 'completed', 'tracking'];
  const input = exactObject(value, [...fields, ...(mode === 'coach'
    ? ['targetChord', 'confirmations', 'successfulStrings']
    : [...(mode === 'rhythm' ? ['heldChord'] : ['sequence', 'barsPerChord', 'loops']),
      'bpm', 'patternId', 'audible', 'soundMode', 'timingMeasured', 'expected',
      'estimatedStrums', 'matched', 'missed', 'extra', 'meanAbsoluteOffsetMs'])]);
  if (typeof input.id !== 'string' || !UUID.test(input.id)) return invalid('Invalid record UUID.');
  const activeMs = duration(input.activeMs);
  const targetMs = duration(input.targetMs);
  if (activeMs > targetMs || input.completed !== (activeMs === targetMs)) {
    return invalid('Round completion must match its duration.');
  }
  const base: RecordBase = { id: input.id.toLowerCase(), completedAt: validateTimestamp(input.completedAt),
    activeMs, targetMs, completed: input.completed as boolean };
  if (mode === 'coach') {
    const targetChord = chord(input.targetChord);
    const strings = input.successfulStrings;
    if (input.tracking !== 'microphone' || !Array.isArray(strings)
      || strings.length > 6 || new Set(strings).size !== strings.length
      || Reflect.ownKeys(strings).length !== strings.length + 1
      || !strings.every((index: unknown) => typeof index === 'number' && Number.isInteger(index)
        && index >= 0 && index < 6 && chordFrets(targetChord)[index] !== null)) {
      return invalid('Invalid selected physical string matches.');
    }
    return Object.freeze({ ...base, mode, targetChord, confirmations: count(input.confirmations),
      successfulStrings: Object.freeze([...strings].sort((a: number, b: number) => a - b)), tracking: 'microphone' });
  }
  if (typeof input.bpm !== 'number' || !Number.isFinite(input.bpm) || input.bpm < 40 || input.bpm > 160
    || !RHYTHM_PATTERNS.some((pattern) => pattern.id === input.patternId)
    || typeof input.audible !== 'boolean' || typeof input.timingMeasured !== 'boolean'
    || !['beat', 'strums'].includes(input.soundMode as string)
    || input.tracking !== (input.timingMeasured ? 'microphone' : 'guided')) {
    return invalid('Invalid rhythm settings.');
  }
  const expected = count(input.expected);
  const measured = input.timingMeasured;
  for (const key of ['estimatedStrums', 'matched', 'missed', 'extra']) {
    if (measured) count(input[key]);
    else if (input[key] !== null) return invalid('Guided practice must not contain measured timing.');
  }
  const offset = input.meanAbsoluteOffsetMs;
  if (offset !== null && (!measured || typeof offset !== 'number' || !Number.isFinite(offset)
    || offset < 0 || offset > MAX_TIMING_OFFSET_MS)) return invalid('Invalid estimated timing offset.');
  if (measured && ((input.matched as number) + (input.missed as number) !== expected
    || (input.matched as number) + (input.extra as number) !== input.estimatedStrums
    || ((input.matched === 0) !== (offset === null)))) return invalid('Inconsistent estimated timing counts.');
  const timing = { bpm: input.bpm, patternId: input.patternId as RhythmRecord['patternId'],
    audible: input.audible, soundMode: input.soundMode as RhythmRecord['soundMode'], timingMeasured: measured, expected,
    estimatedStrums: input.estimatedStrums as number | null, matched: input.matched as number | null,
    missed: input.missed as number | null, extra: input.extra as number | null,
    meanAbsoluteOffsetMs: offset as number | null, tracking: measured ? 'microphone' as const : 'guided' as const };
  if (mode === 'rhythm') return Object.freeze({ ...base, mode, heldChord: chord(input.heldChord), ...timing });
  const sequence = input.sequence;
  if (!Array.isArray(sequence) || sequence.length < 2 || sequence.length > 8
    || Reflect.ownKeys(sequence).length !== sequence.length + 1
    || !Array.from({ length: sequence.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(sequence, String(index));
      return property && 'value' in property && typeof property.value === 'string'
        && Object.hasOwn(CHORDS, property.value);
    }).every(Boolean)
    || typeof input.barsPerChord !== 'number' || !Number.isInteger(input.barsPerChord)
    || input.barsPerChord < 1 || input.barsPerChord > 4
    || typeof input.loops !== 'number' || !Number.isInteger(input.loops) || input.loops < 1 || input.loops > 8) {
    return invalid('Invalid progression sequence or settings.');
  }
  const plan = { sequence: sequence as Chord[], bpm: input.bpm,
    barsPerChord: input.barsPerChord, loops: input.loops };
  const canonicalTarget = progressionDuration(plan) * 1000;
  if (Math.abs(targetMs - canonicalTarget) > 1e-6) return invalid('Progression target does not match its settings.');
  const canonicalActive = base.completed ? canonicalTarget : activeMs;
  if (canonicalActive > canonicalTarget || (!base.completed && canonicalActive === canonicalTarget)) {
    return invalid('Progression completion must match its duration.');
  }
  if (!progressionExpectedMatches(expected, timing.patternId, timing.bpm, canonicalActive,
    base.completed ? progressionDuration(plan) : null)) {
    return invalid('Progression expected strokes do not match its playing time and pattern.');
  }
  return Object.freeze({ ...base, activeMs: canonicalActive, targetMs: canonicalTarget, mode,
    sequence: Object.freeze([...plan.sequence]), barsPerChord: plan.barsPerChord, loops: plan.loops, ...timing });
}

/** Validates a bounded record array completely before any persistence is attempted. */
export function validateRecords(values: unknown): readonly PracticeRecord[] {
  if (!Array.isArray(values)) return invalid('Expected a history record array.');
  if (values.length > HISTORY_RECORD_LIMIT) throw new HistoryError('limit', 'History record limit exceeded.');
  return Object.freeze(Array.from(values, validateRecord));
}

/** A pure merge result, including new unique records and duplicate input counts. */
export interface HistoryMergeResult {
  readonly added: number;
  readonly duplicates: number;
}

/** The complete validated record set produced by a pure merge. */
export interface HistoryMergePlan extends HistoryMergeResult {
  readonly records: readonly PracticeRecord[];
}

/** Merges validated copies by UUID, rejecting all conflicting ids without modifying either input. */
export function mergeRecords(existing: unknown, incoming: unknown): HistoryMergePlan {
  const current = validateRecords(existing);
  const selected = validateRecords(incoming);
  const byId = new Map<string, PracticeRecord>();
  const insert = (record: PracticeRecord): boolean => {
    const previous = byId.get(record.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
      throw new HistoryError('conflict', `History record conflict for id ${record.id}.`);
    }
    if (previous) return false;
    byId.set(record.id, record);
    if (byId.size > HISTORY_RECORD_LIMIT) throw new HistoryError('limit', 'History record limit exceeded.');
    return true;
  };
  current.forEach(insert);
  let added = 0;
  let duplicates = 0;
  for (const record of selected) {
    if (insert(record)) added++;
    else duplicates++;
  }
  return Object.freeze({ records: Object.freeze([...byId.values()]), added, duplicates });
}
