import { expect, test } from 'vitest';
import { createDrill } from '../src/drill';
import type { Observation } from '../src/audio/classify';

function observeAt(
  drill: ReturnType<typeof createDrill>,
  chord: Observation['chord'],
  times: readonly number[],
  confidence = 1,
): (ReturnType<typeof drill.observe>)[] {
  return times.map((atMs) => drill.observe({ atMs, chord, confidence }));
}

test('establishes A without counting repeated A strums', () => {
  const drill = createDrill(['A', 'D']);
  drill.resume();
  for (const atMs of [0, 100, 200, 300, 500, 700]) {
    expect(drill.observe({ atMs, chord: 'A', confidence: 1 })).toBeNull();
  }
});

test('counts one stable A to D switch and no repeated D strums', () => {
  const drill = createDrill(['A', 'D']);
  drill.resume();
  expect(observeAt(drill, 'A', [0, 90, 180])).toEqual([null, null, null]);
  expect(observeAt(drill, 'D', [270, 360, 450, 540, 630, 720])).toEqual([
    null, null, { atMs: 450, chord: 'D' }, null, null, null,
  ]);
  expect(observeAt(drill, 'A', [810, 900, 990])).toEqual([
    null, null, { atMs: 990, chord: 'A' },
  ]);
});

test('pause and resume discard pending switch and require re-establishment', () => {
  const drill = createDrill(['A', 'D']);
  expect(observeAt(drill, 'A', [0, 90, 180])).toEqual([null, null, null]);
  drill.resume();
  observeAt(drill, 'A', [200, 290, 380]);
  observeAt(drill, 'D', [470, 560]);
  drill.pause();
  expect(drill.observe({ atMs: 650, chord: 'D', confidence: 1 })).toBeNull();
  drill.resume();
  expect(observeAt(drill, 'D', [740, 830, 920])).toEqual([null, null, null]);
  expect(observeAt(drill, 'A', [1010, 1100, 1190])).toEqual([
    null, null, { atMs: 1190, chord: 'A' },
  ]);
});

test.each([
  ['null chord', { atMs: 370, chord: null, confidence: 1 }],
  ['wrong chord', { atMs: 370, chord: 'E', confidence: 1 }],
  ['low confidence', { atMs: 370, chord: 'D', confidence: 0.79 }],
  ['non-finite confidence', { atMs: 370, chord: 'D', confidence: NaN }],
  ['confidence above one', { atMs: 370, chord: 'D', confidence: 1.01 }],
  ['non-finite time', { atMs: NaN, chord: 'D', confidence: 1 }],
  ['negative time', { atMs: -1, chord: 'D', confidence: 1 }],
  ['out-of-order time', { atMs: 269, chord: 'D', confidence: 1 }],
  ['duplicate time', { atMs: 270, chord: 'D', confidence: 1 }],
] satisfies readonly (readonly [string, Observation])[])(
  '%s resets pending evidence',
  (_label, invalid) => {
    const drill = createDrill(['A', 'D']);
    drill.resume();
    observeAt(drill, 'A', [0, 90, 180]);
    observeAt(drill, 'D', [270]);
    expect(drill.observe(invalid)).toBeNull();
    expect(observeAt(drill, 'D', [380, 470, 560])).toEqual([
      null, null, { atMs: 560, chord: 'D' },
    ]);
  },
);

test('a gap exceeding the maximum restarts stability evidence', () => {
  const drill = createDrill(['A', 'D']);
  drill.resume();
  observeAt(drill, 'A', [0, 90, 180]);
  expect(observeAt(drill, 'D', [270, 391, 481, 571])).toEqual([
    null, null, null, { atMs: 571, chord: 'D' },
  ]);
});

test('accepts evidence at the confidence and maximum-gap boundaries', () => {
  const drill = createDrill(['A', 'D']);
  drill.resume();
  observeAt(drill, 'A', [0, 90, 180], 0.8);
  expect(observeAt(drill, 'D', [300, 420, 480], 0.8)).toEqual([
    null, null, { atMs: 480, chord: 'D' },
  ]);
});
