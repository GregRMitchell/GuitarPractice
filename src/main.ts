import './style.css';
import { startCapture } from './audio/capture';
import { CHORDS, type Chord, type Pair } from './chords';
import { DETECTOR_PARAMETERS, effectiveSettings, serializeReport } from './report';
import { createSession, type RunConfig, type RunMode, type SessionSnapshot } from './session';
import { evaluate, evaluateControl } from './validation';

const TIMER_REFRESH_MS = 100;
const REPORT_URL_LIFETIME_MS = 1000;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing screen element: ${id}`);
  return found as T;
}
function text(id: string, value: string): void {
  const target = element(id);
  if (target.textContent !== value) target.textContent = value;
}
function button(id: string, disabled: boolean): void {
  element<HTMLButtonElement>(id).disabled = disabled;
}

const first = element<HTMLSelectElement>('first');
const second = element<HTMLSelectElement>('second');
const mode = element<HTMLSelectElement>('mode');
const independent = element<HTMLInputElement>('independent');
const reviewed = element<HTMLInputElement>('reviewed');
const device = element<HTMLInputElement>('device');
const browser = element<HTMLInputElement>('browser');
const environment = element<HTMLTextAreaElement>('environment');
for (const select of [first, second]) {
  for (const chord of Object.keys(CHORDS)) {
    const option = document.createElement('option');
    option.value = chord; option.textContent = chord; select.append(option);
  }
}
first.value = 'A'; second.value = 'D';
browser.value = navigator.userAgent;
text('parameters', JSON.stringify(DETECTOR_PARAMETERS, null, 2));
const session = createSession({ now: () => performance.now(), startCapture, changed: render });

function configuration(): RunConfig {
  return {
    pair: [first.value as Chord, second.value as Chord],
    mode: mode.value as RunMode, independent: independent.checked,
  };
}
function statusMessage(run: SessionSnapshot): string {
  switch (run.phase) {
    case 'idle': return 'Ready. Stay quiet for calibration, then tap Start.';
    case 'starting': return 'Requesting microphone. Allow access in the browser prompt.';
    case 'calibrating': return run.discarded
      ? 'Capture gap: previous evidence discarded. Recalibrating; stay quiet.'
      : 'Calibrating. Stay quiet for 2 seconds of uninterrupted capture.';
    case 'ready': return 'Calibrated. Set the observation origin explicitly below.';
    case 'running': return 'Observation running. Do not hide this page.';
    case 'paused': return 'Paused. Attempt discarded, not partial gate evidence.';
    case 'finished': return run.discarded
      ? 'Finished: discarded attempt. Export only as an interruption record.'
      : 'Finished. Microphone released. Review context and export your report.';
  }
}
function resultText(run: SessionSnapshot): string {
  if (run.phase !== 'finished') return '';
  if (run.discarded) return 'Discarded — no gate result.';
  if (run.elapsedMs <= 0) return 'No timed evidence collected.';
  if (run.config.mode !== 'pair') {
    const result = evaluateControl(run.events, 0, run.elapsedMs);
    return `${result.passed && run.sourceAtStart ? 'Control passed' : 'Control not passed'}: `
      + `${result.countedEventCount} switches in ${(result.durationMs / 1000).toFixed(1)} s. Minimum 30 s, zero switches.`;
  }
  if (!run.config.independent) return `Exploratory only — ${run.events.length} detector switches; no independent accuracy metrics.`;
  if (!run.references.length) return 'No independent starting chord confirmed — no gate evidence.';
  try {
    const result = evaluate(run.references, run.events, run.elapsedMs);
    return `${result.passed ? 'Pair metrics passed' : 'Pair metrics not passed'} · `
      + `${result.actualSwitchCount} actual / ${result.countedSwitchCount} detected · `
      + `precision ${result.precision === null ? 'undefined (no events)' : `${(result.precision * 100).toFixed(1)}%`} · `
      + `recall ${(result.recall * 100).toFixed(1)}%. Not an overall release gate.`;
  } catch {
    return 'Timing is incomplete. No valid pair gate result; inspect the run before export.';
  }
}

function render(): void {
  const run = session.snapshot();
  const locked = !['idle', 'finished'].includes(run.phase);
  const config = run.phase === 'idle' ? configuration() : run.config;
  const pair: Pair = config.pair;
  const labeling = run.config.mode === 'pair' && run.config.independent;
  const hidePredictions = labeling && !['idle', 'finished', 'paused'].includes(run.phase);
  const active = ['starting', 'calibrating', 'ready', 'running'].includes(run.phase);
  const last = run.references.at(-1)?.chord ?? pair[0];
  const current = hidePredictions ? last : run.source ?? last;
  const control = config.mode !== 'pair';
  element<HTMLFieldSetElement>('configuration').disabled = locked;
  text('status', statusMessage(run));
  text('error', run.error); element('error').hidden = !run.error;
  text('evidence', control ? 'Zero-switch control' : config.independent ? 'Independent observer' : 'Exploratory · not gate evidence');
  text('current', current); text('next', control ? pair[0] : current === pair[0] ? pair[1] : pair[0]);
  text('count', String(hidePredictions ? Math.max(0, run.references.length - 1) : run.events.length));
  text('count-label', hidePredictions ? 'actual switches labeled' : 'detector switches');
  text('elapsed', `${(run.elapsedMs / 1000).toFixed(1)} s`);
  text('duration-label', control ? 'of 30 s minimum' : 'uninterrupted timing');
  text('instructions', control && run.phase === 'running'
    ? (config.mode === 'same-chord' ? `Keep strumming only ${pair[0]}.`
      : config.mode === 'speech' ? 'Speak normally. Do not play the guitar.'
        : 'Stay silent. Do not speak or play the guitar.')
      + ' Finish after at least 30 seconds; any detector switch fails this control.'
    : control
    ? `First strum ${pair[0]} until recognized as a stable source. `
      + (config.mode === 'same-chord'
        ? `Keep strumming only ${pair[0]}. `
        : 'Then let the chord decay. ')
      + `Tap Begin to start timing ${config.mode === 'speech' ? 'ordinary speech' : config.mode === 'silence' ? 'silence' : 'repeated strums'}. No switches allowed for at least 30 seconds.`
    : config.independent
      ? 'Observer: confirm the starting chord actually heard, then label every real change. Prompts never create labels.'
      : 'Exploratory practice only. Tap Begin, establish the starting chord, then alternate. No accuracy or gate claim.');
  element('observer').hidden = !config.independent || control;
  for (const [index, id] of ['confirm-first', 'confirm-second'].entries()) {
    text(id, `Actual ${pair[index]} · key ${index + 1}`);
    button(id, !['ready', 'running'].includes(run.phase)
      || (run.phase === 'running' && run.references.at(-1)?.chord === pair[index]));
  }
  element('begin').hidden = !control && config.independent;
  text('begin', control
    ? run.source === pair[0] ? `Begin ${config.mode} · source ${pair[0]} recognized`
      : `Establish ${pair[0]} before beginning`
    : 'Begin exploratory observation');
  button('begin', run.phase !== 'ready' || (control && run.source !== pair[0]));
  text('prediction', hidePredictions ? 'Detector predictions and confidence hidden during independent labeling.'
    : run.prediction ? `Detector: ${run.prediction.chord ?? 'uncertain / rejected'} · confidence ${(run.prediction.confidence * 100).toFixed(0)}%`
      : `Detector: ${run.source ? `stable source ${run.source}` : 'waiting for a stable source'}.`);
  element<HTMLMeterElement>('level').value = run.level;
  text('level-text', `${run.level.toFixed(4)} RMS`);
  text('calibration', run.calibration
    ? `Calibration: ${run.calibration.status} · ${(run.calibration.remainingMs / 1000).toFixed(1)} s remaining`
      + (run.calibration.noiseFloorRms === undefined ? '' : ` · measured floor ${run.calibration.noiseFloorRms.toFixed(5)} RMS`)
    : 'Calibration: not started.');
  if (run.analysisSampleRate !== null) text('settings', JSON.stringify({
    analysisSampleRate: run.analysisSampleRate, track: effectiveSettings(run.settings),
  }, null, 2));
  else text('settings', 'Not available until capture startup completes. Requested: echo cancellation, noise suppression and automatic gain off; devices may ignore preferences.');
  text('results', resultText(run));
  button('start', locked || first.value === second.value);
  button('pause', !active);
  button('resume', run.phase !== 'paused');
  button('finish', !active && run.phase !== 'paused');
  button('export', run.phase !== 'finished' || !reviewed.checked || !device.value.trim() || !browser.value.trim());
}

element('start').addEventListener('click', () => {
  text('export-status', '');
  void session.start(configuration());
});
element('resume').addEventListener('click', () => { void session.start(session.snapshot().config); });
element('pause').addEventListener('click', () => session.pause('manual pause'));
element('finish').addEventListener('click', () => session.finish());
element('begin').addEventListener('click', () => session.begin());
element('confirm-first').addEventListener('click', () => session.confirm(session.snapshot().config.pair[0]));
element('confirm-second').addEventListener('click', () => session.confirm(session.snapshot().config.pair[1]));
document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey
    || target?.closest('input, textarea, select, button, [contenteditable]')) return;
  if (event.key === '1' || event.key === '2') {
    event.preventDefault();
    session.confirm(session.snapshot().config.pair[event.key === '1' ? 0 : 1]);
  }
});
for (const input of [first, second, mode, independent, reviewed]) input.addEventListener('change', render);
for (const input of [device, browser, environment]) input.addEventListener('input', () => {
  reviewed.checked = false; render();
});
element('export').addEventListener('click', () => {
  try {
    const json = serializeReport(session.snapshot(), {
      device: device.value, browser: browser.value, environment: environment.value, reviewed: reviewed.checked,
    });
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `chord-validation-v1-${Date.now()}.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), REPORT_URL_LIFETIME_MS);
    text('export-status', 'Report download requested. No audio included; check your Downloads folder.');
  } catch (failure: unknown) {
    text('export-status', failure instanceof Error ? failure.message : 'Report export failed.');
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) session.pause('hidden page'); });
window.addEventListener('pagehide', () => session.pause('leaving page'));
window.addEventListener('beforeunload', () => session.pause('unloading page'));
window.setInterval(() => {
  const run = session.snapshot();
  if (run.phase === 'running') text('elapsed', `${(run.elapsedMs / 1000).toFixed(1)} s`);
}, TIMER_REFRESH_MS);
render();
