import { CHORDS, type Chord } from '../chords';
import { chordDiagram } from '../diagrams';
import { button, element, text } from '../screen';
import { RHYTHM_PATTERNS, rhythmPattern } from '../rhythm/patterns';
import type { RhythmOptions } from '../rhythm/controller';
import type { PracticeResult } from '../history/model';
import { createProgressionController } from './controller';
import { progressionDuration, progressionPosition, type ProgressionPlan } from './timeline';

const PRESETS: Readonly<Record<string, readonly Chord[]>> = {
  first: ['Em', 'Am'], three: ['G', 'C', 'D'], four: ['G', 'D', 'Em', 'C'], minor: ['Am', 'F', 'C', 'G'],
};

/** Navigation and persistence coordination supplied by the main practice UI. */
export interface ProgressionUiOptions {
  readonly changed: () => void;
  readonly safe: () => boolean;
  readonly begin: () => boolean;
  readonly completed: (record: PracticeResult) => void;
}

/** Wire a guided play-along without allocating audio until Start is pressed. */
export function setupProgression(options: ProgressionUiOptions) {
  let sequence: Chord[] = [...PRESETS.first];
  let locked = false;
  let error = '';
  let editorKey = '';
  let sequenceKey = '';
  let patternKey = '';
  let currentDiagram = '';
  let nextDiagram = '';
  const controller = createProgressionController({ changed: options.changed, completed: options.completed });
  const preset = element<HTMLSelectElement>('progression-preset');
  const bpm = element<HTMLInputElement>('progression-bpm');
  const bars = element<HTMLInputElement>('progression-bars');
  const loops = element<HTMLInputElement>('progression-loops');
  const pattern = element<HTMLSelectElement>('progression-pattern');
  const audible = element<HTMLInputElement>('progression-audible');
  const sound = element<HTMLSelectElement>('progression-sound');
  const microphone = element<HTMLInputElement>('progression-microphone');
  const headphones = element<HTMLInputElement>('progression-headphones');
  for (const item of RHYTHM_PATTERNS) {
    const option = document.createElement('option');
    option.value = item.id; option.textContent = item.name; pattern.append(option);
  }
  pattern.value = 'quarters';
  const slots = Array.from({ length: 8 }, () => {
    const slot = document.createElement('div'); element('progression-slots').append(slot); return slot;
  });
  const plan = (): ProgressionPlan => ({ sequence, bpm: Number(bpm.value),
    barsPerChord: Number(bars.value), loops: Number(loops.value) });
  const valid = (value: ProgressionPlan): boolean => Number.isFinite(value.bpm)
    && value.bpm >= 40 && value.bpm <= 160 && Number.isInteger(value.barsPerChord)
    && value.barsPerChord >= 1 && value.barsPerChord <= 4 && Number.isInteger(value.loops)
    && value.loops >= 1 && value.loops <= 8 && value.sequence.length >= 2 && value.sequence.length <= 8;
  const changed = (): void => { controller.clear(); error = ''; options.changed(); };
  function drawEditor(): void {
    const key = sequence.join('|');
    if (editorKey === key) return;
    editorKey = key;
    const editor = element('progression-editor');
    editor.replaceChildren();
    sequence.forEach((value, index) => {
      const row = document.createElement('div');
      row.className = 'progression-row';
      const label = document.createElement('label');
      label.textContent = `Chord ${index + 1}`;
      const select = document.createElement('select');
      for (const name of Object.keys(CHORDS)) {
        const option = document.createElement('option');
        option.value = name; option.textContent = name; select.append(option);
      }
      select.value = value;
      select.addEventListener('change', () => {
        sequence[index] = select.value as Chord; preset.value = 'custom'; changed();
      });
      label.append(select);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove chord ${index + 1}`);
      remove.disabled = sequence.length <= 2;
      remove.addEventListener('click', () => {
        if (sequence.length <= 2) return;
        sequence.splice(index, 1); preset.value = 'custom'; changed();
      });
      row.append(label, remove); editor.append(row);
    });
  }
  function draw(): void {
    const state = controller.state();
    const running = controller.active();
    const value = state.plan && (running || state.phase === 'finished') ? state.plan : plan();
    const snapshot = state.snapshot;
    const seconds = valid(value) ? progressionDuration(value) : 0;
    const elapsed = snapshot?.elapsedSeconds ?? 0;
    const position = progressionPosition(valid(value) ? value : { ...value, bpm: 80, barsPerChord: 1, loops: 1 }, elapsed);
    const finishedNaturally = state.phase === 'finished' && elapsed >= seconds;
    const chordSeconds = value.bpm > 0 ? value.barsPerChord * 4 * 60 / value.bpm : 0;
    const promptsVisited = chordSeconds > 0 ? Math.min(value.sequence.length * value.loops, Math.ceil(elapsed / chordSeconds)) : 0;
    const loopsPlayed = finishedNaturally ? value.loops : chordSeconds > 0
      ? Math.floor(elapsed / (chordSeconds * value.sequence.length)) : 0;
    const blocked = locked || running || !options.safe();
    drawEditor();
    element<HTMLFieldSetElement>('progression-configuration').disabled = blocked;
    button('progression-add', blocked || sequence.length >= 8);
    button('progression-start', blocked);
    button('progression-reset', !running || state.phase === 'stopping');
    button('progression-finish', !running || state.phase === 'stopping' || state.phase === 'finalizing');
    element('progression-consent').hidden = !microphone.checked;
    text('progression-preview', `${sequence.join(' – ')} · ${valid(plan()) ? `${progressionDuration(plan()).toFixed(1)} seconds playing time` : 'Enter valid options'} · plus one count-in bar`);
    text('progression-error', error || (state.phase === 'error' ? state.message : ''));
    element('progression-error').hidden = !error && state.phase !== 'error';
    const status = state.phase === 'count-in' ? `Get ready ${value.sequence[0]} · ${snapshot?.countInRemaining ?? 4}`
      : state.phase === 'playing' ? `Play ${position.current} · loop ${position.loop} of ${value.loops}`
        : state.message || 'Choose a sequence and start when ready.';
    text('progression-status', status);
    text('progression-current', position.current);
    text('progression-next', position.next ?? 'End');
    if (currentDiagram !== position.current) {
      currentDiagram = position.current;
      element('progression-current-diagram').replaceChildren(chordDiagram(position.current));
    }
    if (nextDiagram !== position.next) {
      nextDiagram = position.next ?? '';
      element('progression-next-diagram').replaceChildren(...(position.next ? [chordDiagram(position.next)] : []));
    }
    const stripKey = `${value.sequence.join('|')}:${position.index}`;
    if (sequenceKey !== stripKey) {
      sequenceKey = stripKey;
      const strip = element('progression-sequence');
      strip.replaceChildren(...value.sequence.map((name, index) => {
        const chip = document.createElement('span');
        chip.textContent = name;
        if (index === position.index) { chip.className = 'active'; chip.setAttribute('aria-current', 'step'); }
        return chip;
      }));
    }
    text('progression-position', state.phase === 'playing'
      ? `Loop ${position.loop} of ${value.loops} · bar ${position.bar} of ${value.barsPerChord} · beat ${position.beat}`
      : state.phase === 'finished' ? `Played ${elapsed.toFixed(1)} seconds · ${loopsPlayed} full loops · ${promptsVisited} prompts visited, not verified changes`
        : state.phase === 'count-in' ? `Count in: ${snapshot?.countInRemaining ?? 4}` : 'One bar count-in before playing.');
    const patternId = snapshot?.patternId ?? pattern.value;
    if (patternKey !== patternId) {
      patternKey = patternId;
      rhythmPattern(patternId).slots.forEach((stroke, index) => {
        slots[index].textContent = `${index % 2 === 0 ? index / 2 + 1 : '&'}\n${stroke === 'down' ? '↓ D' : stroke === 'up' ? '↑ U' : '—'}`;
      });
    }
    slots.forEach((slot, index) => {
      const current = running && snapshot?.activeSlot === index;
      slot.className = `rhythm-slot${current ? ' playing' : ''}`;
      slot.setAttribute('aria-current', current ? 'step' : 'false');
    });
    const summary = snapshot?.summary;
    text('progression-timing', !summary?.timingMeasured ? 'Guided practice · timing not measured'
      : `Estimated timing (uncalibrated): ${summary.matched} matched · ${summary.missed} missed · ${summary.extra} extra`);
    text('progression-countdown', String(Math.ceil(Math.max(0, seconds - elapsed))));
    const progress = element<HTMLProgressElement>('progression-progress');
    progress.max = seconds || 1; progress.value = Math.min(seconds, elapsed);
  }
  preset.addEventListener('change', () => {
    if (PRESETS[preset.value]) sequence = [...PRESETS[preset.value]];
    changed();
  });
  element('progression-add').addEventListener('click', () => {
    if (sequence.length >= 8) return;
    sequence.push(sequence[sequence.length - 1]); preset.value = 'custom'; changed();
  });
  for (const control of [bpm, bars, loops, pattern, audible, sound, microphone, headphones]) control.addEventListener('change', changed);
  element('progression-start').addEventListener('click', () => {
    if (locked || controller.active() || !options.safe()) return;
    const settings = plan();
    if (!valid(settings)) { error = 'Choose a valid tempo, 1–4 bars, 1–8 loops and 2–8 chords.'; draw(); return; }
    if (microphone.checked && audible.checked && !headphones.checked) {
      error = 'Confirm you are wearing headphones, or mute clicks, before microphone timing.'; draw(); return;
    }
    if (!options.begin()) return;
    error = '';
    void controller.start(settings, { patternId: pattern.value as RhythmOptions['patternId'],
      audible: audible.checked, soundMode: sound.value as RhythmOptions['soundMode'],
      microphone: microphone.checked, headphonesAcknowledged: headphones.checked });
  });
  element('progression-reset').addEventListener('click', () => { void controller.reset(); });
  element('progression-finish').addEventListener('click', () => { void controller.finish(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void controller.reset(); });
  window.addEventListener('pagehide', () => { void controller.reset(); });
  window.addEventListener('beforeunload', () => { void controller.reset(); });
  return {
    /** Whether any play-along resource or setup is active. */
    active: controller.active,
    /** Clear an inactive preview when leaving the mode. */
    clear: controller.clear,
    /** Apply shared practice/navigation locks and refresh the view. */
    render(isLocked: boolean): void { locked = isLocked; draw(); },
  };
}
