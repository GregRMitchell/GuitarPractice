import './style.css';
import { startCapture } from './audio/capture';
import { CHORDS, type Chord, type Pair } from './chords';
import { DETECTOR_PARAMETERS, effectiveSettings } from './report';
import { createSession, type RunConfig, type RunMode, type SessionSnapshot } from './session';
import { evaluate } from './validation';
import { setupPwa, type Pwa } from './pwa';
import { element, text, button } from './screen';
import { resultText, timingReview, downloadReport } from './diagnostics';
import { ROUND_MS, renderPractice } from './practice';
import { setupHistory } from './history/ui';
import { setupModes } from './modes/ui';

const TIMER_REFRESH_MS = 100;

const first = element<HTMLSelectElement>('first');
const second = element<HTMLSelectElement>('second');
const mode = element<HTMLSelectElement>('mode');
const independent = element<HTMLInputElement>('independent');
const diagnostics = element<HTMLInputElement>('diagnostics');
const reviewed = element<HTMLInputElement>('reviewed');
const device = element<HTMLInputElement>('device');
const browser = element<HTMLInputElement>('browser');
const environment = element<HTMLTextAreaElement>('environment');
const referenceTimes = element<HTMLTextAreaElement>('reference-times');
const referenceEvidence = element<HTMLInputElement>('reference-evidence');
const referenceAttested = element<HTMLInputElement>('reference-attested');
let timingEditorLoaded = false;
let updateLocked = false;
let pwa: Pwa | undefined;
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
const history = setupHistory(render);
const modes = setupModes({ changed: render, safe: history.safe, begin: history.beginRecord,
  completed: history.retainRecord });

function configuration(): RunConfig {
  return {
    pair: [first.value as Chord, second.value as Chord],
    mode: diagnostics.checked ? mode.value as RunMode : 'pair',
    independent: diagnostics.checked && independent.checked,
    ...(diagnostics.checked ? {} : { durationMs: ROUND_MS }),
  };
}
function statusMessage(run: SessionSnapshot): string {
  if (run.config.durationMs !== undefined || run.phase === 'idle' && !diagnostics.checked) {
    switch (run.phase) {
      case 'idle': return 'Pick two chords. One minute. Let’s play!';
      case 'starting': return 'Requesting microphone. Allow access to start practice.';
      case 'calibrating': return 'Calibrating. Stay quiet for 2 seconds, then we’ll start automatically.';
      case 'ready': return 'Ready for practice.';
      case 'running': return 'Go! Strum your starting chord, then alternate at your own pace.';
      case 'paused': return 'Round reset and discarded. Tap Restart for a fresh minute.';
      case 'finished': return run.discarded ? 'Round reset. Ready when you are.' : 'Nice practice! Microphone off. Play again?';
    }
  }
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
function render(): void {
  const run = session.snapshot();
  history.observe(run, updateLocked, modes.active());
  modes.render(updateLocked, !['idle', 'finished'].includes(run.phase));
  // begin() changes phase before notifying, so a synchronous ready callback cannot recurse.
  if (run.phase === 'ready' && run.config.durationMs !== undefined) {
    session.begin(); return;
  }
  if (run.phase === 'finished' && !timingEditorLoaded) {
    referenceTimes.value = run.references.slice(1).map(({ atMs }) => String(atMs)).join('\n');
    referenceEvidence.value = '';
    referenceAttested.checked = false;
    timingEditorLoaded = true;
  }
  const locked = updateLocked || !['idle', 'finished'].includes(run.phase);
  const preview = ['idle', 'finished'].includes(run.phase);
  const config = preview ? configuration() : run.config;
  const practice = preview ? !diagnostics.checked : run.config.durationMs !== undefined;
  const pair: Pair = config.pair;
  const labeling = run.config.mode === 'pair' && run.config.independent;
  const hidePredictions = labeling && !['idle', 'finished', 'paused'].includes(run.phase);
  const active = ['starting', 'calibrating', 'ready', 'running'].includes(run.phase);
  const last = run.references.at(-1)?.chord ?? pair[0];
  const current = preview ? pair[0] : hidePredictions ? last : run.source ?? last;
  const control = config.mode !== 'pair';
  element<HTMLFieldSetElement>('configuration').disabled = locked;
  element<HTMLFieldSetElement>('validation-configuration').disabled = locked;
  diagnostics.disabled = locked;
  text('live-title', practice ? 'Your one-minute jam' : 'Detector validation');
  text('status', statusMessage(run));
  text('error', run.error); element('error').hidden = !run.error;
  text('evidence', control ? 'Zero-switch control' : config.independent ? 'Independent observer' : 'Exploratory · not gate evidence');
  text('current', current); text('next', control ? pair[0] : current === pair[0] ? pair[1] : pair[0]);
  text('count', String(practice && run.config.durationMs === undefined ? 0
    : hidePredictions ? Math.max(0, run.references.length - 1) : run.events.length));
  text('count-label', hidePredictions ? 'actual switches labeled' : practice ? 'confirmed switches' : 'detector switches');
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
      : practice ? 'Strum, switch, repeat. Let each chord ring clearly. Every confirmed change counts!'
        : 'Exploratory practice only. Tap Begin, establish the starting chord, then alternate. No accuracy or gate claim.');
  element('observer').hidden = !config.independent || control;
  element('reference-review').hidden = run.phase !== 'finished'
    || !labeling || run.discarded || run.references.length === 0;
  text('reference-labels', run.references.slice(1)
    .map(({ chord }, index) => `${index + 1}: ${chord}`).join(' · ')
    || 'No transitions were labeled.');
  element<HTMLButtonElement>('reference-attested').disabled = !referenceEvidence.value.trim();
  let validTimingReview = false;
  try {
    const review = timingReview(run);
    if (review) {
      evaluate(review.references, [], run.elapsedMs);
      validTimingReview = true;
    }
  } catch {
    validTimingReview = false;
  }
  text('reference-status', referenceAttested.checked && referenceEvidence.value.trim() && validTimingReview
    ? 'Attestation recorded. Exported metrics will use these reviewed times.'
    : referenceAttested.checked && !validTimingReview
      ? 'Timing entries are invalid or incomplete; cannot certify.'
      : 'Cannot certify: independent timing evidence and a fresh attestation are required.');
  for (const [index, id] of ['confirm-first', 'confirm-second'].entries()) {
    text(id, `Actual ${pair[index]} · key ${index + 1}`);
    button(id, !['ready', 'running'].includes(run.phase)
      || (run.phase === 'running' && run.references.at(-1)?.chord === pair[index]));
  }
  element('begin').hidden = practice || !control && config.independent;
  text('begin', control
    ? run.source === pair[0] ? `Begin ${config.mode} · source ${pair[0]} recognized`
      : `Establish ${pair[0]} before beginning`
    : 'Begin exploratory observation');
  button('begin', run.phase !== 'ready' || (control && run.source !== pair[0]));
  text('prediction', hidePredictions ? 'Detector predictions and confidence hidden during independent labeling.'
    : run.prediction ? `Detector: ${run.prediction.chord ?? 'uncertain / rejected'} · uncalibrated margin-based indicator ${(run.prediction.confidence * 100).toFixed(0)}%`
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
  renderPractice(run, pair, practice);
  text('start', practice ? run.phase === 'finished' ? 'Play again · 60 seconds' : 'Start practice' : 'Start microphone');
  text('resume', practice ? 'Restart · fresh minute' : 'Resume as new attempt');
  text('pause', practice ? 'Stop & reset' : 'Pause & discard');
  text('finish', practice ? 'End round' : 'Finish');
  element('elapsed-stat').hidden = practice;
  element('evidence').hidden = practice;
  button('start', locked || modes.active() || !history.safe() || first.value === second.value);
  button('pause', !active);
  button('resume', run.phase !== 'paused');
  button('finish', !active && run.phase !== 'paused');
  button('export', updateLocked || run.phase !== 'finished' || !reviewed.checked || !device.value.trim() || !browser.value.trim());
  pwa?.refresh();
}

element('start').addEventListener('click', () => {
  text('export-status', '');
  timingEditorLoaded = false;
  void session.start(configuration());
});
element('resume').addEventListener('click', () => {
  timingEditorLoaded = false;
  void session.start(session.snapshot().config);
});
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
for (const input of [first, second, mode, independent, diagnostics, reviewed]) input.addEventListener('change', render);
for (const input of [device, browser, environment]) input.addEventListener('input', () => {
  reviewed.checked = false; render();
});
for (const input of [referenceTimes, referenceEvidence]) input.addEventListener('input', () => {
  referenceAttested.checked = false;
  render();
});
referenceAttested.addEventListener('change', render);
element('export').addEventListener('click', () => downloadReport(session.snapshot()));
document.addEventListener('visibilitychange', () => { if (document.hidden) session.pause('hidden page'); });
window.addEventListener('pagehide', () => session.pause('leaving page'));
window.addEventListener('beforeunload', () => session.pause('unloading page'));
window.setInterval(() => {
  session.tick();
  modes.tick();
  if (session.snapshot().phase === 'running') render();
}, TIMER_REFRESH_MS);
pwa = setupPwa({
  safe: () => ['idle', 'finished'].includes(session.snapshot().phase) && !modes.active() && history.safe(),
  lock: (locked) => { updateLocked = locked; render(); },
  changed: (state) => {
    text('offline-status', state.message);
    text('network-status', state.network);
    text('install-status', state.install);
    text('update-status', state.updateMessage);
    button('install-app', !state.canInstall);
    button('apply-update', !state.update);
  },
});
element('install-app').addEventListener('click', () => { void pwa?.install(); });
element('apply-update').addEventListener('click', () => { void pwa?.applyUpdate(); });
render();
