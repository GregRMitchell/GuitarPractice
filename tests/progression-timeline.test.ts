import { expect, test } from 'vitest';
import { progressionDuration, progressionPosition } from '../src/progression/timeline';

test('duration follows the complete phrase at fractional and extreme tempos', () => {
  for (const bpm of [40, 80, 120.5, 160]) {
    expect(progressionDuration({ sequence: ['G', 'D', 'Em', 'C'], bpm, barsPerChord: 2, loops: 3 }))
      .toBe(4 * 2 * 3 * 4 * 60 / bpm);
  }
});

test('audio elapsed locates repeated chord prompts and clamps the final frame', () => {
  const plan = { sequence: ['G', 'G', 'D'] as const, bpm: 120, barsPerChord: 2, loops: 2 };
  expect(progressionPosition(plan, 0)).toMatchObject({ index: 0, current: 'G', next: 'G', beat: 1, bar: 1, loop: 1 });
  expect(progressionPosition(plan, 2)).toMatchObject({ index: 0, beat: 1, bar: 2 });
  expect(progressionPosition(plan, 4)).toMatchObject({ index: 1, current: 'G', next: 'D', beat: 1, bar: 1 });
  expect(progressionPosition(plan, 12)).toMatchObject({ index: 0, current: 'G', loop: 2 });
  expect(progressionPosition(plan, 24)).toMatchObject({ index: 2, current: 'D', next: null, loop: 2, finished: true });
  expect(progressionPosition(plan, 100)).toMatchObject({ index: 2, current: 'D', next: null, loop: 2, finished: true });
});

test('fractional tempo boundaries advance to the correct chord and loop', () => {
  const plan = { sequence: ['Em', 'Am'] as const, bpm: 120.5, barsPerChord: 1, loops: 2 };
  const bar = 4 * 60 / plan.bpm;
  expect(progressionPosition(plan, bar)).toMatchObject({ index: 1, bar: 1, beat: 1 });
  expect(progressionPosition(plan, 2 * bar)).toMatchObject({ index: 0, loop: 2, beat: 1 });
  const slow = { ...plan, bpm: 40.1 };
  expect(progressionPosition(slow, 60 / slow.bpm)).toMatchObject({ index: 0, beat: 2 });
});
