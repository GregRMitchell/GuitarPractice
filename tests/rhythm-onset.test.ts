import { expect, test } from 'vitest';
import { OnsetDetector } from '../src/rhythm/onset';

const RATE = 48000;
function detect(signal: (time: number, index: number) => number, seconds = 3): number[] {
  const detector = new OnsetDetector(RATE, 1);
  const hits: number[] = [];
  for (let index = 0; index < RATE * seconds; index += 128) {
    const block = Float32Array.from({ length: 128 }, (_, offset) => signal((index + offset) / RATE, index + offset));
    detector.process(block, index / RATE, (onset) => hits.push(onset.atAudioTime));
  }
  return hits;
}

test('silence, invalid samples, quiet noise and a sustained calibrated tone do not produce hits', () => {
  expect(detect(() => 0)).toEqual([]);
  expect(detect(() => NaN)).toEqual([]);
  expect(detect((_, index) => 0.002 * Math.sin(index * 17.31))).toEqual([]);
  expect(detect((time) => 0.15 * Math.sin(2 * Math.PI * 110 * time))).toEqual([]);
});

test('two ringing guitar-like attacks produce two onsets, not repeated tone crossings', () => {
  const hits = detect((time) => [1.2, 1.7].reduce((sum, at) => {
    const age = time - at;
    return sum + (age >= 0 ? 0.4 * Math.exp(-age * 5)
      * (Math.sin(2 * Math.PI * 110 * age) + 0.3 * Math.sin(2 * Math.PI * 220 * age)) : 0);
  }, 0));
  expect(hits).toHaveLength(2);
  expect(hits[0]).toBeCloseTo(1.2, 1);
  expect(hits[1]).toBeCloseTo(1.7, 1);
});

test('a newly struck sustained tone produces one onset and closely spaced impulses respect cooldown', () => {
  expect(detect((time) => time < 1.2 ? 0 : 0.3 * Math.sin(2 * Math.PI * 110 * time))).toHaveLength(1);
  const hits = detect((time) => [1.2, 1.24, 1.4].some((at) => time >= at && time < at + 0.008)
    ? 0.4 * Math.sin(2 * Math.PI * 220 * time) : 0);
  expect(hits).toHaveLength(2);
  expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(0.08);
});
