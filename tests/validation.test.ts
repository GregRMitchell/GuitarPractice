import { expect, test } from 'vitest';
import { evaluate, evaluateControl, ValidationError } from '../src/validation';
import type { AcceptedSwitch, Reference } from '../src/validation';

test('a duplicate event is a false positive, not another correct switch', () => {
  const report = evaluate(
    [{ atMs: 0, chord: 'A' }, { atMs: 1000, chord: 'D' }],
    [{ atMs: 1200, chord: 'D' }, { atMs: 1400, chord: 'D' }],
    2000,
  );

  expect(report.truePositives).toBe(1);
  expect(report.falsePositives).toBe(1);
  expect(report.recall).toBe(1);
  expect(report.precision).toBe(0.5);
  expect(report.passed).toBe(false);
});

test('events before establishment and events with the wrong target are false positives', () => {
  const report = evaluate(
    [{ atMs: 100, chord: 'A' }, { atMs: 500, chord: 'D' }],
    [{ atMs: 50, chord: 'D' }, { atMs: 200, chord: 'A' }, { atMs: 300, chord: 'G' }],
    1000,
  );

  expect(report.truePositives).toBe(0);
  expect(report.falsePositives).toBe(3);
  expect(report.misses).toBe(1);
});

test('a missing reference transition is a miss', () => {
  const report = evaluate(
    [{ atMs: 0, chord: 'A' }, { atMs: 500, chord: 'D' }, { atMs: 1000, chord: 'A' }],
    [{ atMs: 600, chord: 'D' }],
    1500,
  );

  expect(report.actualSwitchCount).toBe(2);
  expect(report.countedSwitchCount).toBe(1);
  expect(report.misses).toBe(1);
});

test('an empty event list has null precision and cannot pass', () => {
  const report = evaluate(
    [{ atMs: 0, chord: 'A' }, { atMs: 500, chord: 'D' }],
    [],
    1000,
  );

  expect(report.precision).toBeNull();
  expect(report.recall).toBe(0);
  expect(report.passed).toBe(false);
});

test('a pair run with twenty transitions and no events cannot pass', () => {
  const report = evaluate(makeReferences(20), [], 1000);

  expect(report.actualSwitchCount).toBe(20);
  expect(report.countedSwitchCount).toBe(0);
  expect(report.passed).toBe(false);
});

test('a control run with exactly thirty seconds and no events passes', () => {
  const report = evaluateControl([], 1000, 31_000);

  expect(report.durationMs).toBe(30_000);
  expect(report.countedEventCount).toBe(0);
  expect(report.passed).toBe(true);
});

test('a control run shorter than thirty seconds fails', () => {
  const report = evaluateControl([], 1000, 30_999);

  expect(report.durationMs).toBe(29_999);
  expect(report.passed).toBe(false);
});

test('any detector event fails a control run', () => {
  const report = evaluateControl([{ atMs: 2000, chord: 'A' }], 1000, 31_000);

  expect(report.countedEventCount).toBe(1);
  expect(report.passed).toBe(false);
});

const invalidControlInputs: readonly (readonly [
  string,
  readonly AcceptedSwitch[],
  number,
  number,
])[] = [
  ['non-finite start time', [], Number.NaN, 30_000],
  ['non-finite end time', [], 0, Number.POSITIVE_INFINITY],
  ['end before start', [], 30_000, 0],
  ['event before observation range', [{ atMs: 999, chord: 'A' }], 1000, 31_000],
  ['event after observation range', [{ atMs: 31_001, chord: 'A' }], 1000, 31_000],
  ['non-finite event time', [{ atMs: Number.NaN, chord: 'A' }], 1000, 31_000],
  ['unsorted event times', [
    { atMs: 2000, chord: 'A' }, { atMs: 1500, chord: 'D' },
  ], 1000, 31_000],
];

test.each(invalidControlInputs)(
  'control run with %s throws an explicit validation error',
  (_label, events, startedAtMs, endedAtMs) => {
    expect(() => evaluateControl(events, startedAtMs, endedAtMs))
      .toThrow(ValidationError);
  },
);

test('fewer than twenty actual switches cannot pass', () => {
  const references = makeReferences(19);
  const events = references.slice(1).map(({ atMs, chord }) => ({ atMs: atMs + 1, chord }));
  const report = evaluate(references, events, 1000);

  expect(report.actualSwitchCount).toBe(19);
  expect(report.precision).toBe(1);
  expect(report.recall).toBe(1);
  expect(report.passed).toBe(false);
});

test('passes when precision and recall exactly meet their thresholds', () => {
  const references = makeReferences(45);
  const events: AcceptedSwitch[] = [];

  references.slice(1, 37).forEach(({ atMs, chord }, index) => {
    events.push({ atMs: atMs + 1, chord });
    if (index < 4) {
      events.push({ atMs: atMs + 2, chord });
    }
  });

  const report = evaluate(references, events, 500);

  expect(report.truePositives).toBe(36);
  expect(report.falsePositives).toBe(4);
  expect(report.misses).toBe(9);
  expect(report.precision).toBe(0.9);
  expect(report.recall).toBe(0.8);
  expect(report.passed).toBe(true);
});

test('a switch at the next transition belongs only to the next interval', () => {
  const report = evaluate(
    [{ atMs: 0, chord: 'A' }, { atMs: 500, chord: 'D' }, { atMs: 1000, chord: 'A' }],
    [{ atMs: 1000, chord: 'A' }],
    1500,
  );

  expect(report.truePositives).toBe(1);
  expect(report.misses).toBe(1);
});

test('events at the exclusive run end are not counted', () => {
  const report = evaluate(
    [{ atMs: 0, chord: 'A' }, { atMs: 500, chord: 'D' }],
    [{ atMs: 1000, chord: 'D' }],
    1000,
  );

  expect(report.countedSwitchCount).toBe(0);
  expect(report.falsePositives).toBe(0);
  expect(report.misses).toBe(1);
});

const invalidReferences: readonly (readonly [string, readonly Reference[]])[] = [
  ['empty references', [] as Reference[]],
  ['repeated reference chord', [{ atMs: 0, chord: 'A' }, { atMs: 1, chord: 'A' }]],
  ['third reference chord', [
    { atMs: 0, chord: 'A' }, { atMs: 1, chord: 'D' }, { atMs: 2, chord: 'G' },
  ]],
  ['unsorted references', [{ atMs: 0, chord: 'A' }, { atMs: 2, chord: 'D' }, { atMs: 1, chord: 'A' }]],
  ['invalid reference label', [{ atMs: 0, chord: 'X' } as unknown as Reference]],
  ['non-finite reference time', [{ atMs: Number.NaN, chord: 'A' }]],
  ['negative reference time', [{ atMs: -1, chord: 'A' }]],
  ['reference at exclusive run end', [{ atMs: 10, chord: 'A' }]],
  ['duplicate reference time', [{ atMs: 0, chord: 'A' }, { atMs: 0, chord: 'D' }]],
];

test.each(invalidReferences)('%s is rejected as invalid reference data', (_label, references) => {
  expect(() => evaluate(references, [], 10)).toThrow(ValidationError);
});

const invalidEvents: readonly (readonly [string, readonly AcceptedSwitch[]])[] = [
  ['unsorted events', [{ atMs: 3, chord: 'D' }, { atMs: 2, chord: 'D' }]],
  ['negative event time', [{ atMs: -1, chord: 'D' }]],
  ['non-finite event time', [{ atMs: Number.NaN, chord: 'D' }]],
  ['event past run end', [{ atMs: 11, chord: 'D' }]],
];

test.each(invalidEvents)('%s is rejected as invalid event data', (_label, events) => {
  expect(() => evaluate(
    [{ atMs: 0, chord: 'A' }, { atMs: 5, chord: 'D' }],
    events,
    10,
  )).toThrow(ValidationError);
});

function makeReferences(switchCount: number): Reference[] {
  return Array.from({ length: switchCount + 1 }, (_, index) => ({
    atMs: index * 10,
    chord: index % 2 === 0 ? 'A' : 'D',
  }));
}
