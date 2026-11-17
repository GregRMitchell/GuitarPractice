import { expect, test } from 'vitest';
import { extractFeatures } from '../src/audio/features';
import { estimatePitch } from '../src/coach/pitch';
import { assessOverall, assessString, stringTargets } from '../src/coach/assessment';

const rate = 48000;
const signal = (frequencies: number[], amplitude = 0.2): Float32Array =>
  Float32Array.from({ length: 8192 }, (_, index) =>
    frequencies.reduce((sum, frequency) => sum + amplitude * Math.sin(2 * Math.PI * frequency * index / rate), 0));
const frequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

test('overall coaching waits for silence and distinguishes expected, weak and extra pitches', () => {
  const evaluate = (notes: number[]) => assessOverall('E', extractFeatures(signal(notes.map(frequency)), rate), false);
  expect(evaluate([]).status).toBe('waiting');
  expect(evaluate([40, 47, 52, 56, 59, 64]).status).toBe('good');
  expect(evaluate([40, 47]).status).toBe('tip');
  expect(evaluate([40, 47, 52, 56, 59, 64, 65, 70]).status).toBe('tip');
});

test('single-note pitch estimator handles harmonic-rich tones, detuning and silence', () => {
  const fundamental = frequency(45);
  const harmonic = signal([fundamental, fundamental * 2], 0.15);
  const pitch = estimatePitch(harmonic, rate, 0.001);
  expect(pitch?.frequency).toBeCloseTo(fundamental, 0);
  expect(pitch?.confidence).toBeGreaterThan(0.9);
  expect(estimatePitch(new Float32Array(8192), rate, 0.001)).toBeNull();
  const detuned = estimatePitch(signal([fundamental * 2 ** (50 / 1200)]), rate, 0.001);
  expect(assessString('A', 1, detuned, false).status).toBe('tip');
  expect(assessString('A', 1, estimatePitch(signal([fundamental * 2]), rate, 0.001), false).status).toBe('tip');
  expect(assessString('A', 1, pitch, false).status).toBe('good');
});

test('physical strings retain duplicate pitch classes and muted strings are skipped', () => {
  const targets = stringTargets('D');
  expect(targets.map((target) => target.midi)).toEqual([null, null, 50, 57, 62, 66]);
  expect(assessString('D', 0, null, false).status).toBe('muted');
  expect(assessString('A', 1, { frequency: 110, confidence: 0.3 }, false).status).toBe('waiting');
});

test.each([
  ['F', [41, 48, 53, 57, 60, 65]],
  ['Bm', [null, 47, 54, 59, 62, 66]],
] as const)('%s isolated string targets match its barre voicing', (chord, notes) => {
  const targets = stringTargets(chord as 'F' | 'Bm');
  expect(targets.map((target) => target.midi)).toEqual(notes);
  notes.forEach((midi, index) => {
    if (midi !== null) expect(assessString(chord as 'F' | 'Bm', index,
      { frequency: frequency(midi), confidence: 1 }, false).status).toBe('good');
  });
});

test('clipped and broadband noisy signals produce signal warnings rather than chord claims', () => {
  let state = 42;
  const noise = Float32Array.from({ length: 8192 }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 0xffffffff - 0.5) * 0.2;
  });
  const features = extractFeatures(noise, rate);
  expect(assessOverall('E', features, false).status).toBe('warning');
  expect(assessOverall('E', features, true).status).toBe('warning');
  expect(estimatePitch(noise, rate, 0.001)).toBeNull();
});
