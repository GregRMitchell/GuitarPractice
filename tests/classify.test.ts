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

test('requires a minimum strength for the third instead of accepting leakage', () => {
  const noteEnergies = Array<number>(49).fill(0);
  for (const note of [41, 48, 53, 60, 65]) noteEnergies[note - 36] = 1;
  const features = { rms: 0.1, noiseFloorRms: 0.001, midiMin: 36,
    noteEnergies, pitchClassEnergies: Array<number>(12).fill(0) };
  noteEnergies[57 - 36] = 0.139;
  expect(classify(features, ['F', 'Bm'], 0).chord).toBeNull();
  noteEnergies[57 - 36] = 0.14;
  expect(classify(features, ['F', 'Bm'], 0).chord).toBe('F');
});

test('an octave harmonic alone cannot supply an expected chord tone', () => {
  const noteEnergies = Array<number>(49).fill(0);
  for (const note of [41, 48, 53, 60, 65]) noteEnergies[note - 36] = 1;
  noteEnergies[45 - 36] = 0.8;
  noteEnergies[57 - 36] = 0.8;
  expect(classify({ rms: 0.1, noiseFloorRms: 0.001, midiMin: 36,
    noteEnergies, pitchClassEnergies: Array<number>(12).fill(0) }, ['F', 'Bm'], 0).chord).toBeNull();
});

test('silence cannot be labeled as either expected chord', () => {
  const features = extractFeatures(new Float32Array(8192), 48000);
  expect(classify(features, ['E', 'Em'], 0).chord).toBeNull();
});

test.each([
  ['C', ['C', 'Am'], 44100],
  ['Am', ['C', 'Am'], 44100],
  ['C', ['C', 'Am'], 48000],
  ['Am', ['C', 'Am'], 48000],
  ['E', ['E', 'Em'], 44100],
  ['Em', ['E', 'Em'], 44100],
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

test.each([
  ['A', ['A', 'D']], ['D', ['A', 'D']],
  ['Dm', ['D', 'Dm']], ['G', ['A', 'G']],
] as const)('retains recognition of legacy %s voicing', (chord, pair) => {
  for (const sampleRate of [44100, 48000]) {
    expect(classify(extractFeatures(synthesizeChord(chord, sampleRate), sampleRate), pair, 0).chord).toBe(chord);
  }
});

test.each([
  ['E7', ['E', 'Em']], ['Em7', ['E', 'Em']], ['Am7', ['C', 'Am']],
] as const)('does not certify ambiguous %s evidence as an active-pair chord', (chord, pair) => {
  for (const sampleRate of [44100, 48000]) {
    const features = extractFeatures(synthesizeChord(chord, sampleRate), sampleRate);
    expect(classify(features, pair, 0).chord).toBeNull();
  }
});

test.each([
  ['E7', ['E7', 'E']], ['Em7', ['Em7', 'Em']], ['Am7', ['Am7', 'Am']],
  ['F', ['F', 'Bm']], ['Bm', ['F', 'Bm']],
  ['Asus2', ['Asus2', 'Dsus2']], ['Dsus2', ['Asus2', 'Dsus2']],
] as const)('recognizes %s distinctive voicing at both sample rates', (chord, pair) => {
  for (const sampleRate of [44100, 48000]) {
    const features = extractFeatures(synthesizeChord(chord, sampleRate), sampleRate);
    expect(classify(features, pair, 0).chord, `${chord} at ${sampleRate}`).toBe(chord);
  }
});

test('rejects E/Em when the distinguishing third is absent', () => {
  const samples = synthesizeChord('E', 48000);
  const third = synthesizeChord('E', 48000, 0.5, 8192 / 48000, [56]);
  const missing = Float32Array.from(samples, (sample, index) => sample - third[index]);
  expect(classify(extractFeatures(missing, 48000), ['E', 'Em'], 0).chord).toBeNull();
});

test('rejects F note evidence without the defining major third', () => {
  const noteEnergies = Array<number>(49).fill(0);
  for (const note of [41, 48, 53, 60, 65]) noteEnergies[note - 36] = 1;
  const pitchClassEnergies = Array<number>(12).fill(0);
  for (const note of [41, 48, 53, 60, 65]) pitchClassEnergies[note % 12] = 1;
  expect(classify({ rms: 0.1, noiseFloorRms: 0.001, midiMin: 36,
    noteEnergies, pitchClassEnergies }, ['F', 'Bm'], 0).chord).toBeNull();
});

test.each([44100, 48000])('rejects synthetic F without its third at %i Hz', (sampleRate) => {
  const duration = 8192 / sampleRate;
  const samples = synthesizeChord('F', sampleRate);
  const third = synthesizeChord('F', sampleRate, 0.5, duration, [57]);
  const missing = Float32Array.from(samples, (sample, index) => sample - third[index]);
  expect(classify(extractFeatures(missing, sampleRate), ['F', 'Bm'], 0).chord).toBeNull();
});

test.each([
  ['F', [41, 48, 53, 57, 65], 'F'],
  ['Bm', [47, 54, 59, 66], null],
  ['E7', [40, 47, 56, 59, 64], null],
  ['Asus4', [45, 52, 57, 64], null],
] as const)('checks chord-tone coverage for %s without requiring duplicate octaves', (chord, notes, expected) => {
  const noteEnergies = Array<number>(49).fill(0);
  for (const note of notes) noteEnergies[note - 36] = 1;
  const pitchClassEnergies = Array<number>(12).fill(0);
  for (const note of notes) pitchClassEnergies[note % 12] = 1;
  const competitor = chord === 'F' ? 'Bm' : chord === 'Bm' ? 'F' : chord === 'E7' ? 'Em' : 'C';
  expect(classify({ rms: 0.1, noiseFloorRms: 0.001, midiMin: 36,
    noteEnergies, pitchClassEnergies }, [chord, competitor], 0).chord).toBe(expected);
});

test.each([0.5, 1])('rejects incomplete seventh when octave harmonic strength is %s', (harmonic) => {
  for (const sampleRate of [44100, 48000]) {
    const duration = 8192 / sampleRate;
    const samples = synthesizeChord('E7', sampleRate, 0.5, duration, undefined, harmonic);
    const seventh = synthesizeChord('E7', sampleRate, 0.5, duration, [50], harmonic);
    const missing = Float32Array.from(samples, (sample, index) => sample - seventh[index]);
    expect(classify(extractFeatures(missing, sampleRate), ['E7', 'E'], 0).chord).toBeNull();
  }
});

test('rejects combined E and Em evidence instead of forcing either chord', () => {
  const major = synthesizeChord('E', 48000);
  const minor = synthesizeChord('Em', 48000);
  const mixture = Float32Array.from(major, (sample, index) => sample + minor[index]);
  expect(classify(extractFeatures(mixture, 48000), ['E', 'Em'], 0).chord).toBeNull();
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
