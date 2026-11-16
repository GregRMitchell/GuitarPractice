import { expect, test } from 'vitest';
import { extractFeatures } from '../src/audio/features';
import { synthesizeChord } from './audio-fixtures';

test.each([44100, 48000])(
  'extracts stable pitch-class evidence at %i Hz',
  (sampleRate) => {
    const features = extractFeatures(synthesizeChord('C', sampleRate), sampleRate);
    expect(features.rms).toBeGreaterThan(0);
    expect(features.pitchClassEnergies).toHaveLength(12);
    expect(features.pitchClassEnergies[0]).toBeGreaterThan(0.3);
    expect(features.pitchClassEnergies[4]).toBeGreaterThan(0.3);
  },
);

test('normalizes pitch evidence across gain changes', () => {
  const quiet = extractFeatures(synthesizeChord('E', 48000, 0.12), 48000);
  const loud = extractFeatures(synthesizeChord('E', 48000, 0.75), 48000);
  quiet.pitchClassEnergies.forEach((energy, index) => {
    expect(energy).toBeCloseTo(loud.pitchClassEnergies[index], 6);
  });
});

test('exposes an explicit calibration noise-floor input', () => {
  const quietChord = synthesizeChord('D', 48000, 0.001);
  const features = extractFeatures(quietChord, 48000, { noiseFloorRms: 0.01 });
  expect(features.pitchClassEnergies.every((energy) => energy === 0)).toBe(true);
});

test.each([
  [new Float32Array(0), 48000],
  [new Float32Array(16), 0],
  [new Float32Array(16), Number.NaN],
])('rejects invalid signal inputs', (samples, sampleRate) => {
  expect(() => extractFeatures(samples, sampleRate)).toThrow();
});
