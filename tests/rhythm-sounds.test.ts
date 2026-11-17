import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startRhythm } from '../src/rhythm/controller';
import type { RhythmOptions } from '../src/rhythm/controller';
import { browser, FakeContext } from './capture-fakes';
import { RHYTHM_PATTERNS } from '../src/rhythm/patterns';

interface Note {
  frequency: { value: number };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

let notes: Note[];
beforeEach(() => {
  vi.useFakeTimers();
  browser();
  notes = [];
  class SoundContext extends FakeContext {
    override createGain(): typeof this.sink {
      const gain = super.createGain();
      Object.assign(gain.gain, { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
      return gain;
    }
    createOscillator(): Note {
      const note: Note = {
        frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(),
        connect: vi.fn(), disconnect: vi.fn(), onended: null,
      };
      notes.push(note);
      return note;
    }
  }
  vi.stubGlobal('AudioContext', SoundContext);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function exercise(options: RhythmOptions): Promise<Awaited<ReturnType<typeof startRhythm>>> {
  const session = await startRhythm({ bpm: 120, ...options }, {
    onChanged: vi.fn(), onPause: vi.fn(), onError: vi.fn(),
  });
  return session;
}

function advanceTo(audioTime: number): void {
  const context = FakeContext.instances[0];
  while (context.currentTime + 0.0125 < audioTime) {
    context.currentTime = Math.min(audioTime, context.currentTime + 0.025);
    vi.advanceTimersByTime(25);
  }
}

function scheduled(): { at: number; hz: number }[] {
  return notes.map((note) => ({ at: note.start.mock.calls[0][0] as number, hz: note.frequency.value }));
}

test('all patterns are playable eighth-slot bars with alternating hand direction', () => {
  for (const pattern of RHYTHM_PATTERNS) {
    expect(pattern.slots).toHaveLength(8);
    pattern.slots.forEach((stroke, index) => {
      expect([null, index % 2 === 0 ? 'down' : 'up']).toContain(stroke);
    });
  }
});

test('strum sound common pattern keeps quarter count-in and sounds only instructed strokes', async () => {
  const session = await exercise({ soundMode: 'strums', patternId: 'common' });
  advanceTo(14.1);
  expect(session.snapshot.soundMode).toBe('strums');
  const result = scheduled();
  expect(result.slice(0, 4).map((note) => note.hz)).toEqual([1200, 800, 800, 800]);
  expect(result.slice(0, 4).map((note) => note.at)).toEqual([10.05, 10.55, 11.05, 11.55]);
  expect(result.slice(4).map((note) => note.hz)).toEqual([440, 440, 880, 880, 440, 880, 440]);
  const expectedOffsets = [0, 0.5, 0.75, 1.25, 1.5, 1.75, 2];
  result.slice(4).forEach((note, index) => expect(note.at - 12.05).toBeCloseTo(expectedOffsets[index]));
  expect(new Set(result.map((note) => note.at)).size).toBe(result.length);
  await session.stop();
});

test('eighth sound alternates low down and high up without a second beat sound', async () => {
  const session = await exercise({ soundMode: 'strums', patternId: 'eighths' });
  advanceTo(13.9);
  expect(scheduled().slice(4).map((note) => note.hz)).toEqual([440, 880, 440, 880, 440, 880, 440, 880]);
  scheduled().slice(4).forEach((note, index) => expect(note.at).toBeCloseTo(12.05 + index * 0.25));
  await session.stop();
});

test.each([
  ['down-up-pairs', ['down', 'up', 'down', null, 'down', 'up', 'down', null]],
  ['backbeat', ['down', null, null, 'up', 'down', null, null, 'up']],
  ['offbeat-ups', [null, 'up', null, 'up', null, 'up', null, 'up']],
  ['pop-drive', ['down', null, 'down', 'up', 'down', null, 'down', 'up']],
  ['sparse', ['down', null, null, null, 'down', null, null, null]],
] as const)('%s schedules cues only for its intended eighth slots', async (id, slots) => {
  const session = await exercise({ soundMode: 'strums', patternId: id as RhythmOptions['patternId'] });
  advanceTo(13.9);
  const expected = slots.flatMap((stroke, index) => stroke
    ? [{ at: 12.05 + index * 0.25, hz: stroke === 'down' ? 440 : 880 }] : []);
  const actual = scheduled().slice(4);
  expect(actual).toHaveLength(expected.length);
  actual.forEach((note, index) => {
    expect(note.hz).toBe(expected[index].hz);
    expect(note.at).toBeCloseTo(expected[index].at);
  });
  await session.stop();
});

test('default beat sounds remain quarter-note clicks regardless of pattern', async () => {
  const session = await exercise({ patternId: 'eighths' });
  advanceTo(13.9);
  expect(session.snapshot.soundMode).toBe('beat');
  expect(scheduled().map((note) => note.hz)).toEqual([1200, 800, 800, 800, 1200, 800, 800, 800]);
  await session.stop();
});

test('muting strum sound schedules no oscillators while visuals continue', async () => {
  const session = await exercise({ audible: false, soundMode: 'strums' });
  advanceTo(13);
  expect(notes).toHaveLength(0);
  expect(session.snapshot.phase).toBe('playing');
  await session.stop();
});

test('strum sounds stop at the exercise deadline and invalid mode never allocates audio', async () => {
  await expect(exercise({ soundMode: 'invalid' as RhythmOptions['soundMode'] })).rejects.toThrow('sound mode');
  await expect(exercise({ soundMode: null as unknown as RhythmOptions['soundMode'] })).rejects.toThrow('sound mode');
  expect(FakeContext.instances).toHaveLength(0);
  const session = await exercise({ soundMode: 'strums', patternId: 'eighths' });
  advanceTo(72.1);
  expect(session.snapshot.phase).toBe('finished');
  expect(notes).toHaveLength(244);
  expect(notes.every((note) => (note.start.mock.calls[0][0] as number) < 72.05)).toBe(true);
  expect(notes.every((note) => (note.stop.mock.calls[0][0] as number) <= 72.05)).toBe(true);
  expect(new Set(scheduled().map((note) => note.at)).size).toBe(notes.length);
  await session.stop();
});
