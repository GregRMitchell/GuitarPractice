import { CHORDS, type Chord } from '../chords';
import { chordFrets } from '../diagrams';
import type { Features } from '../audio/features';
import type { PitchEstimate } from './pitch';

const OPEN_MIDI = [40, 45, 50, 55, 59, 64] as const;
const STRING_NAMES = ['low E', 'A', 'D', 'G', 'B', 'high E'] as const;
const NOTE_THRESHOLD = 0.19;
const EXTRA_THRESHOLD = 0.72;
const CENT_TOLERANCE = 35;
const MIN_PITCH_CONFIDENCE = 0.8;

/** Result of one evidence frame; this is not a diagnosis of a physical string. */
export interface Assessment {
  /** Waiting, plausible match, cautious suggestion, signal warning, or muted string. */
  readonly status: 'waiting' | 'good' | 'tip' | 'warning' | 'muted';
  /** Short user-facing summary. */
  readonly title: string;
  /** Actionable, non-diagnostic guidance. */
  readonly tip: string;
  /** Difference from selected note in cents, when a confident pitch is available. */
  readonly cents?: number;
}

/** One physical string in the reference voicing, ordered low to high. */
export interface StringTarget {
  /** Zero-based physical string index, low E first. */
  readonly index: number;
  /** Human-readable standard-tuning string name. */
  readonly name: string;
  /** Reference fret, or null when the string is not played. */
  readonly fret: number | null;
  /** Target MIDI note, or null when the string is not played. */
  readonly midi: number | null;
}

/**
 * Return all six physical string targets in standard tuning.
 * @param chord Supported reference voicing.
 * @returns String targets, including muted strings.
 */
export function stringTargets(chord: Chord): readonly StringTarget[] {
  return chordFrets(chord).map((fret, index) => ({
    index, name: STRING_NAMES[index], fret, midi: fret === null ? null : OPEN_MIDI[index] + fret,
  }));
}

/**
 * Compare pitch-class evidence to the chord without competitor classification.
 * @param chord Desired chord.
 * @param features Local spectral summary.
 * @param clipped Whether samples reached the clipping threshold.
 * @returns Cautious frame assessment.
 */
export function assessOverall(chord: Chord, features: Features, clipped: boolean): Assessment {
  if (clipped) return { status: 'warning', title: 'Signal may be clipping', tip: 'Move away from the microphone or lower its input level.' };
  if (features.rms <= Math.max(0.003, features.noiseFloorRms * 2)) {
    if (features.noiseFloorRms > 0.01 && features.rms > 0.003) {
      return { status: 'warning', title: 'Signal is close to background level', tip: 'Try a quieter room and recalibrate.' };
    }
    return { status: 'waiting', title: 'Waiting for a strum', tip: 'Strum the chord when ready.' };
  }
  if (features.pitchClassEnergies.filter((energy) => energy >= 0.65).length >= 8) {
    return { status: 'warning', title: 'Signal may be noisy or complex', tip: 'Try a quieter room and strum again.' };
  }
  const expected = new Set(CHORDS[chord].pitchClasses);
  const energies = features.pitchClassEnergies;
  const missing = [...expected].some((pitchClass) => (energies[pitchClass] ?? 0) < NOTE_THRESHOLD);
  const extra = energies.some((energy, pitchClass) => !expected.has(pitchClass) && energy >= EXTRA_THRESHOLD);
  const avoid = stringTargets(chord).filter((target) => target.fret === null).map((target) => target.name);
  if (missing || extra) return {
    status: 'tip', title: 'Some notes need another listen',
    tip: `Some expected notes may be weak or other notes may be present. Check your ${chord} fingering and press close to the frets.${avoid.length ? ` Avoid the ${avoid.join(' and ')} string${avoid.length > 1 ? 's' : ''}.` : ''}`,
  };
  return { status: 'good', title: 'Chord sounds close', tip: 'The expected notes are present; this does not certify every string is clean.' };
}

/**
 * Compare a confidently pitched isolated note to a selected physical string.
 * @param chord Desired reference chord.
 * @param index Physical string index, zero for low E.
 * @param pitch Worker-estimated pitch or null for quiet/unpitched input.
 * @param clipped Whether input may have clipped.
 * @returns Cautious frame assessment, never an identity claim.
 */
export function assessString(chord: Chord, index: number, pitch: PitchEstimate | null, clipped: boolean): Assessment {
  const target = stringTargets(chord)[index];
  if (!target) throw new RangeError('Select a string from 0 to 5.');
  if (target.midi === null) return { status: 'muted', title: 'Skip this string', tip: `Do not play the ${target.name} string in this voicing.` };
  if (clipped) return { status: 'warning', title: 'Signal may be clipping', tip: 'Move away from the microphone or lower its input level.' };
  if (!pitch || pitch.confidence < MIN_PITCH_CONFIDENCE || !Number.isFinite(pitch.frequency) || pitch.frequency <= 0) {
    return { status: 'waiting', title: 'Waiting for a clear note', tip: `Pluck the ${target.name} string alone.` };
  }
  const expectedHz = 440 * 2 ** ((target.midi - 69) / 12);
  const cents = 1200 * Math.log2(pitch.frequency / expectedHz);
  if (Math.abs(cents) <= CENT_TOLERANCE) return {
    status: 'good', title: 'Note sounds close', tip: `The note is near the expected pitch. Pluck the next string when ready.`, cents,
  };
  return { status: 'tip', title: `Note sounds ${cents > 0 ? 'sharp' : 'flat'}`,
    tip: `Check the selected ${target.name} string, fingering, tuning and finger pressure; pluck it alone again.`, cents };
}
