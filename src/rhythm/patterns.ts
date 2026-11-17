/** A visual stroke instruction, not a microphone classification. */
export type Stroke = 'down' | 'up' | null;
/** Identifier of a built-in pattern. */
export type PatternId = typeof PATTERN_DEFINITIONS[number]['id'];
/** One repeating 4/4 bar, represented by eight eighth-note slots. */
export interface RhythmPattern {
  readonly id: PatternId;
  readonly name: string;
  readonly slots: readonly Stroke[];
}

/** Beginner patterns; arrows describe the exercise, not detected hand direction. */
const PATTERN_DEFINITIONS = [
  { id: 'quarters', name: 'Down on each beat', slots: ['down', null, 'down', null, 'down', null, 'down', null] },
  { id: 'eighths', name: 'Alternating eighths', slots: ['down', 'up', 'down', 'up', 'down', 'up', 'down', 'up'] },
  { id: 'common', name: 'Down down up up down up', slots: ['down', null, 'down', 'up', null, 'up', 'down', 'up'] },
  { id: 'down-up-pairs', name: 'Down-up, down', slots: ['down', 'up', 'down', null, 'down', 'up', 'down', null] },
  { id: 'backbeat', name: 'Backbeat lift', slots: ['down', null, null, 'up', 'down', null, null, 'up'] },
  { id: 'offbeat-ups', name: 'Offbeat upstrokes', slots: [null, 'up', null, 'up', null, 'up', null, 'up'] },
  { id: 'pop-drive', name: 'Driving eighths', slots: ['down', null, 'down', 'up', 'down', null, 'down', 'up'] },
  { id: 'sparse', name: 'Half-note downstrokes', slots: ['down', null, null, null, 'down', null, null, null] },
] as const satisfies readonly { readonly id: string; readonly name: string; readonly slots: readonly Stroke[] }[];

/** Beginner patterns; arrows describe the exercise, not detected hand direction. */
export const RHYTHM_PATTERNS: readonly RhythmPattern[] = Object.freeze(
  PATTERN_DEFINITIONS.map((pattern) => Object.freeze({ ...pattern, slots: Object.freeze(pattern.slots) })),
);

/** Find a built-in pattern; reject unknown persisted or UI input. */
export function rhythmPattern(id: string): RhythmPattern {
  const pattern = RHYTHM_PATTERNS.find((candidate) => candidate.id === id);
  if (!pattern) throw new Error('Choose a supported strumming pattern.');
  return pattern;
}
