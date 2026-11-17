import { expect, test } from 'vitest';
import { rhythmPattern } from '../src/rhythm/patterns';
import { expectedStrokes, summarizeTiming } from '../src/rhythm/scoring';

test('patterns repeat on eighth slots and exclude the deadline', () => {
  expect(expectedStrokes(rhythmPattern('common'), 60, 4)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
  expect(expectedStrokes(rhythmPattern('eighths'), 160, 60)).toHaveLength(320);
  expect(() => expectedStrokes(rhythmPattern('quarters'), Infinity, 60)).toThrow('valid tempo');
  expect(() => expectedStrokes(rhythmPattern('quarters'), 80, Infinity)).toThrow('valid tempo');
});

test('long play-alongs retain expected strokes beyond the legacy minute', () => {
  expect(expectedStrokes(rhythmPattern('quarters'), 80, 120)).toHaveLength(160);
  expect(expectedStrokes(rhythmPattern('eighths'), 40, 1536)).toHaveLength(2048);
});

test('matching is one-to-one with explicit misses, extras and uncalibrated offsets', () => {
  expect(summarizeTiming([0, 0.5, 1], [0.02, 0.04, 0.95, 1.3], 120)).toMatchObject({
    matched: 2, inTime: 2, missed: 1, extra: 2, estimatedStrums: 4,
  });

  expect(summarizeTiming([0], [0.025], 120).meanAbsoluteOffsetMs).toBeCloseTo(25);
  expect(summarizeTiming([0.5], [0.42, 0.5], 120)).toMatchObject({ matched: 1, extra: 1, meanAbsoluteOffsetMs: 0 });
  expect(summarizeTiming([0], [], 120).meanAbsoluteOffsetMs).toBeNull();
  expect(summarizeTiming([0], null, 120)).toMatchObject({ timingMeasured: false, matched: null, missed: null });
});

test('timing matching tolerates unsorted and repeated onsets without double counting', () => {
  expect(summarizeTiming([0, 0.5, 1], [1.01, 0.04, 0.02, 0.49, 1.01], 120)).toMatchObject({
    matched: 3, missed: 0, extra: 2, estimatedStrums: 5,
  });
  expect(summarizeTiming([0, 0.5, 1], [1.01, 0.04, 0.02, 0.49, 1.01], 120).meanAbsoluteOffsetMs)
    .toBeCloseTo((20 + 10 + 10) / 3);
});
