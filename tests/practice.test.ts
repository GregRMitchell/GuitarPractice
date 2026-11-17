import { expect, test } from 'vitest';
import { milestone } from '../src/practice';
import { chordFrets } from '../src/diagrams';
import { CHORDS, type Chord } from '../src/chords';

test('encouragement follows confirmed counts, without claiming accuracy', () => {
  expect(milestone(0)).toMatch(/first/i);
  expect(milestone(1)).toMatch(/first/i);
  expect(milestone(5)).toMatch(/5/);
  expect(milestone(10)).toMatch(/10/);
  expect(milestone(20)).toMatch(/20/);
});

test('every open diagram produces exactly the detector reference voicing', () => {
  const tuning = [40, 45, 50, 55, 59, 64];
  for (const chord of Object.keys(CHORDS) as Chord[]) {
    expect(chordFrets(chord).flatMap((fret, index) => fret === null ? [] : [tuning[index]! + fret]))
      .toEqual(CHORDS[chord].midiNotes);
  }
  expect(chordFrets('G')).toEqual([3, 2, 0, 0, 0, 3]);
});

test.each([
  ['A7', [null, 0, 2, 0, 2, 0], [45, 52, 55, 61, 64]],
  ['Am7', [null, 0, 2, 0, 1, 0], [45, 52, 55, 60, 64]],
  ['C7', [null, 3, 2, 3, 1, 0], [48, 52, 58, 60, 64]],
  ['D7', [null, null, 0, 2, 1, 2], [50, 57, 60, 66]],
  ['E7', [0, 2, 0, 1, 0, 0], [40, 47, 50, 56, 59, 64]],
  ['Em7', [0, 2, 0, 0, 0, 0], [40, 47, 50, 55, 59, 64]],
  ['G7', [3, 2, 0, 0, 0, 1], [43, 47, 50, 55, 59, 65]],
  ['Asus2', [null, 0, 2, 2, 0, 0], [45, 52, 57, 59, 64]],
  ['Asus4', [null, 0, 2, 2, 3, 0], [45, 52, 57, 62, 64]],
  ['Dsus2', [null, null, 0, 2, 3, 0], [50, 57, 62, 64]],
  ['Dsus4', [null, null, 0, 2, 3, 3], [50, 57, 62, 67]],
  ['F', [1, 3, 3, 2, 1, 1], [41, 48, 53, 57, 60, 65]],
  ['Bm', [null, 2, 4, 4, 3, 2], [47, 54, 59, 62, 66]],
] as const)('maps %s reference voicing to physical strings', (name, frets, notes) => {
  const chord = name as Chord;
  expect(CHORDS[chord]?.midiNotes).toEqual(notes);
  expect(chordFrets(chord)).toEqual(frets);
});
