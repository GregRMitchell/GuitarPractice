import { expect, test } from 'vitest';
import { classify } from '../src/audio/classify';
import { extractFeatures } from '../src/audio/features';
import { CHORDS, type Chord } from '../src/chords';
import { synthesizeChord } from './audio-fixtures';

test.each([
  ['A', [45, 52, 57, 61, 64]],
  ['Am', [45, 52, 57, 60, 64]],
  ['C', [48, 52, 55, 60, 64]],
  ['D', [50, 57, 62, 66]],
  ['Dm', [50, 57, 62, 65]],
  ['E', [40, 47, 52, 56, 59, 64]],
  ['Em', [40, 47, 52, 55, 59, 64]],
  ['G', [43, 47, 50, 55, 59, 67]],
] as const)('defines the standard open-position %s voicing', (chord, midiNotes) => {
  expect(CHORDS[chord as Chord].midiNotes).toEqual(midiNotes);
  expect(CHORDS[chord as Chord].pitchClasses).toEqual(
    [...new Set(midiNotes.map((midi) => midi % 12))],
  );
});

test('silence cannot be labeled as either expected chord', () => {
  const features = extractFeatures(new Float32Array(8192), 48000);
  expect(classify(features, ['E', 'Em'], 0).chord).toBeNull();
});

test.each([
  ['C', ['C', 'Am'], 44100],
  ['Am', ['C', 'Am'], 44100],
  ['E', ['E', 'Em'], 44100],
  ['Em', ['E', 'Em'], 44100],
  ['C', ['C', 'Am'], 48000],
  ['Am', ['C', 'Am'], 48000],
  ['E', ['E', 'Em'], 48000],
  ['Em', ['E', 'Em'], 48000],
] as const)('recognizes harmonic evidence for %s', (chord, pair, sampleRate) => {
  const features = extractFeatures(synthesizeChord(chord, sampleRate), sampleRate);
  const observation = classify(features, pair, 123);
  expect(observation.chord).toBe(chord);
  expect(observation.atMs).toBe(123);
  expect(observation.confidence).toBeGreaterThanOrEqual(0.8);
});

test.each([0.12, 0.75])('preserves E/Em discrimination at gain %s', (gain) => {
  const features = extractFeatures(synthesizeChord('E', 48000, gain), 48000);
  expect(classify(features, ['E', 'Em'], 0).chord).toBe('E');
});

test.each(['A', 'Am', 'C', 'D', 'Dm', 'G'] as const)(
  'does not force unrelated %s evidence into the E/Em pair',
  (chord) => {
  const features = extractFeatures(synthesizeChord(chord, 48000), 48000);
  expect(classify(features, ['E', 'Em'], 0).chord).toBeNull();
  },
);

test('rejects ambiguous evidence from two overlapping chords', () => {
  const c = synthesizeChord('C', 48000);
  const am = synthesizeChord('Am', 48000);
  const mixture = Float32Array.from(c, (sample, index) => sample + am[index]);
  const features = extractFeatures(mixture, 48000);
  expect(classify(features, ['C', 'Am'], 0).chord).toBeNull();
});

test('rejects invalid pair and timestamp inputs', () => {
  const features = extractFeatures(synthesizeChord('D', 48000), 48000);
  expect(() => classify(features, ['D', 'D'], 0)).toThrow();
  expect(() => classify(features, ['D', 'Dm'], Number.NaN)).toThrow();
});
