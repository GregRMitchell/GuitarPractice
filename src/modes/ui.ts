import { CHORDS, type Chord } from '../chords';
import { chordDiagram } from '../diagrams';
import { stringTargets } from '../coach/assessment';
import { RHYTHM_PATTERNS, rhythmPattern } from '../rhythm/patterns';
import type { RhythmOptions } from '../rhythm/controller';
import type { PracticeResult } from '../history/model';
import { button, element } from '../screen';
import { createModesController } from './controller';
import { setupProgression } from '../progression/ui';

type PracticeMode = 'switches' | 'coach' | 'rhythm' | 'progression';

function text(id: string, value: string): void {
  const target = element(id);
  if (target.textContent !== value) target.textContent = value;
}

/** Navigation/storage boundaries shared with the existing switching screen. */
export interface ModesUiOptions {
  readonly changed: () => void;
  readonly safe: () => boolean;
  readonly begin: () => boolean;
  readonly completed: (record: PracticeResult) => void;
}

/**
 * Wire the mode picker and two focused practice screens without starting audio on navigation.
 * @param options Existing history and render coordination.
 * @returns Mode and resource-safety controls used by main and PWA.
 */
export function setupModes(options: ModesUiOptions) {
  let selected: PracticeMode = 'switches';
  let locked = false;
  let externalActive = false;
  let diagramChord: Chord | null = null;
  let displayedPattern = '';
  let error = '';
  const chord = element<HTMLSelectElement>('extra-chord');
  const bpm = element<HTMLInputElement>('rhythm-bpm');
  const pattern = element<HTMLSelectElement>('rhythm-pattern');
  const audible = element<HTMLInputElement>('rhythm-audible');
  const sound = element<HTMLSelectElement>('rhythm-sound');
  const microphone = element<HTMLInputElement>('rhythm-microphone');
  const headphones = element<HTMLInputElement>('rhythm-headphones');
  chord.value = 'A'; bpm.value = '80'; audible.checked = true; sound.value = 'beat';
  pattern.value = 'quarters';
  for (const name of Object.keys(CHORDS)) {
    const option = document.createElement('option');
    option.value = name; option.textContent = name; chord.append(option);
  }
  chord.value = 'A';
  for (const item of RHYTHM_PATTERNS) {
    const option = document.createElement('option');
    option.value = item.id; option.textContent = item.name; pattern.append(option);
  }
  pattern.value = 'quarters';
  const strings = stringTargets('A').map((target) => {
    const control = document.createElement('button');
    control.type = 'button'; control.textContent = target.name;
    control.addEventListener('click', () => controller.selectString(target.index));
    element('coach-strings').append(control);
    return control;
  });
  const slots = Array.from({ length: 8 }, () => {
    const slot = document.createElement('div');
    element('rhythm-slots').append(slot);
    return slot;
  });
  const controller = createModesController({ changed: options.changed, completed: options.completed });
  const progression = setupProgression(options);
  function draw(): void {
    const state = controller.state();
    const active = controller.active();
    const blocked = locked || externalActive || active || progression.active() || !options.safe();
    const isCoach = selected === 'coach';
    const currentChord = (active || state.phase === 'finished') ? state.chord : chord.value as Chord;
    element('switch-practice').hidden = selected !== 'switches';
    element('extra-practice').hidden = selected === 'switches' || selected === 'progression';
    element('progression-practice').hidden = selected !== 'progression';
    for (const name of ['switches', 'coach', 'rhythm', 'progression'] as const) {
      button(`practice-${name}`, blocked);
      element(`practice-${name}`).setAttribute('aria-pressed', String(name === selected));
    }
    if (selected === 'progression') { progression.render(locked || externalActive || active); return; }
    if (selected === 'switches') return;
    text('extra-title', isCoach ? 'Learn a chord' : 'Find your groove');
    text('extra-start', isCoach ? 'Start learning · 60 seconds' : 'Start strumming · 60 seconds');
    element<HTMLFieldSetElement>('extra-configuration').disabled = blocked;
    button('extra-start', blocked);
    button('extra-reset', !active || state.phase === 'stopping');
    button('extra-finish', !active || state.phase === 'stopping' || state.phase === 'finalizing');
    element('rhythm-configuration').hidden = isCoach;
    element('coach-controls').hidden = !isCoach;
    element('rhythm-controls').hidden = isCoach;
    element('rhythm-consent').hidden = !microphone.checked;
    text('extra-chord-name', currentChord);
    if (diagramChord !== currentChord) {
      element('extra-diagram').replaceChildren(chordDiagram(currentChord));
      diagramChord = currentChord;
    }
    const calibration = state.calibration;
    const message = state.message || (isCoach
      ? 'Choose a chord. We’ll listen and offer gentle, pitch-based tips.'
      : 'One bar to count in, then a minute to settle into the groove.');
    text('extra-status', message + (isCoach && state.phase === 'calibrating' && calibration
      ? ` ${(calibration.remainingMs / 1000).toFixed(1)} s quiet time remaining.` : ''));
    text('extra-error', error || (state.phase === 'error' ? state.message : ''));
    element('extra-error').hidden = !error && state.phase !== 'error';
    text('extra-countdown', String(Math.ceil((60_000 - state.elapsedMs) / 1000)));
    element<HTMLProgressElement>('extra-progress').value = state.elapsedMs;
    const snapshot = state.coach;
    const selection = snapshot?.stringIndex ?? null;
    const targets = stringTargets(currentChord);
    for (const [index, control] of strings.entries()) {
      control.disabled = !isCoach || !active || state.phase !== 'running' || targets[index].fret === null;
      control.textContent = `${targets[index].name}${targets[index].fret === null ? ' · skip' : ''}`;
      control.setAttribute('aria-pressed', String(selection === index));
    }
    button('coach-overall', !active || state.phase !== 'running');
    element('coach-overall').setAttribute('aria-pressed', String(selection === null));
    const target = selection === null ? null : targets[selection];
    const note = target?.midi === null || target?.midi === undefined ? ''
      : `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][target.midi % 12]}${Math.floor(target.midi / 12) - 1}`;
    text('coach-target', target
      ? `${target.name} · ${target.fret === 0 ? 'open' : `fret ${target.fret}`} · target ${note}. Pluck this string alone.`
      : 'Overall chord · strum the indicated strings together.');
    text('coach-quality', state.phase === 'calibrating' ? 'Quiet for calibration…'
      : snapshot?.assessment.title ?? 'Ready for your first strum?');
    text('coach-tip', state.phase === 'calibrating' ? 'Hold off playing until calibration finishes.'
      : (snapshot?.assessment.tip ?? (currentChord === 'F'
        ? 'Barre all six strings at fret 1; keep fingers close behind the frets.'
        : currentChord === 'Bm'
          ? 'Barre from the A string to high E at fret 2; mute low E.'
          : 'Keep fingers close behind the frets and shoulders relaxed.'))
        + (snapshot?.assessment.cents === undefined ? '' : ` Estimated offset: ${snapshot.assessment.cents > 0 ? '+' : ''}${snapshot.assessment.cents.toFixed(0)} cents.`));
    text('coach-counts', `${snapshot?.overallConfirmations ?? 0} stable overall confirmations · ${snapshot?.successfulStrings.length ?? 0} unique selected string pitch matches`);
    const value = state.rhythm;
    const patternId = active || state.phase === 'finished' ? value?.patternId ?? pattern.value : pattern.value;
    if (displayedPattern !== patternId) {
      displayedPattern = patternId;
      rhythmPattern(patternId).slots.forEach((stroke, index) => {
        slots[index].textContent = `${index % 2 === 0 ? index / 2 + 1 : '&'}\n${stroke === 'down' ? '↓ D' : stroke === 'up' ? '↑ U' : '—'}`;
      });
    }
    slots.forEach((slot, index) => {
      const current = active && value?.activeSlot === index;
      slot.className = `rhythm-slot${current ? ' playing' : ''}`;
      slot.setAttribute('aria-current', current ? 'step' : 'false');
    });
    text('rhythm-position', state.phase === 'count-in' ? `Count in: ${value?.countInRemaining ?? 4}`
      : state.phase === 'running' ? `Bar ${value?.bar ?? 1} · beat ${value?.beat ?? 1}`
        : state.phase === 'finalizing' ? 'Finishing timing estimates…'
          : state.phase === 'finished' ? 'Round complete · audio off' : 'Ready when you are');
    const summary = value?.summary;
    text('rhythm-timing', !summary?.timingMeasured ? 'Guided practice · timing not measured'
      : `Estimated timing (uncalibrated): ${summary.matched} matched · ${summary.missed} missed · ${summary.extra} extra`
        + (summary.meanAbsoluteOffsetMs === null ? ' · no matched strokes yet'
          : ` · mean absolute offset ${summary.meanAbsoluteOffsetMs.toFixed(0)} ms`));
  }
  for (const name of ['switches', 'coach', 'rhythm', 'progression'] as const) {
    element(`practice-${name}`).addEventListener('click', () => {
      if (locked || externalActive || controller.active() || progression.active() || !options.safe()) return;
      if (name !== selected) { controller.clear(); progression.clear(); }
      selected = name; error = ''; options.changed();
    });
  }
  for (const control of [chord, bpm, pattern, audible, sound, microphone, headphones]) {
    control.addEventListener('change', () => { controller.clear(); error = ''; options.changed(); });
  }
  element('extra-start').addEventListener('click', () => {
    if (locked || externalActive || controller.active() || !options.safe()) return;
    error = '';
    const config: RhythmOptions = { bpm: Number(bpm.value), patternId: pattern.value as RhythmOptions['patternId'],
      audible: audible.checked, soundMode: sound.value as RhythmOptions['soundMode'],
      microphone: microphone.checked, headphonesAcknowledged: headphones.checked };
    if (selected === 'rhythm' && (!Number.isFinite(config.bpm) || config.bpm! < 40 || config.bpm! > 160)) {
      error = 'Choose a tempo between 40 and 160 BPM.'; draw(); return;
    }
    if (selected === 'rhythm' && microphone.checked && audible.checked && !headphones.checked) {
      error = 'Confirm you are wearing headphones, or turn off audio clicks, before microphone timing.'; draw(); return;
    }
    if (!options.begin()) return;
    if (selected === 'coach') void controller.startCoach(chord.value as Chord);
    else void controller.startRhythm(chord.value as Chord, config);
  });
  element('extra-reset').addEventListener('click', () => { void controller.reset(); });
  element('extra-finish').addEventListener('click', () => { void controller.finish(); });
  element('coach-overall').addEventListener('click', () => controller.selectOverall());
  document.addEventListener('visibilitychange', () => { if (document.hidden) void controller.reset(); });
  window.addEventListener('pagehide', () => { void controller.reset(); });
  window.addEventListener('beforeunload', () => { void controller.reset(); });
  return {
    /** Return the user's current practice choice. */
    selected: (): PracticeMode => selected,
    /** Guard every unfinished audio/setup/cleanup phase. */
    active: (): boolean => controller.active() || progression.active(),
    /** Share switching, save and PWA locks with this screen. */
    render(updateLocked: boolean, switchActive: boolean): void {
      locked = updateLocked; externalActive = switchActive; draw();
    },
    /** Advance only the coach timer; rhythm uses its engine audio clock. */
    tick: controller.tick,
  };
}
