import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Exercise the shipped mode screens, real worklets and mixed-summary JSON with Edge.
 * The offline harness owns the isolated origins, CDP and browser cleanup.
 */
export async function checkModes({ page, otherOrigin, newTab, until }) {
  await page.send('Page.bringToFront');
  await page.evaluate(`(() => {
    document.getElementById('nav-practice').click();
    globalThis.modeMicCalls = 0;
    globalThis.modeTracks = [];
    navigator.mediaDevices.getUserMedia = async () => {
      globalThis.modeMicCalls++;
      const context = new AudioContext();
      await context.resume();
      globalThis.modeAudio?.close();
      globalThis.modeAudio = context;
      const gain = context.createGain();
      gain.gain.value = 0;
      globalThis.modeGain = gain;
      const output = context.createMediaStreamDestination();
      gain.connect(output);
      for (const midi of [45, 52, 57, 60, 64]) {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
        oscillator.connect(gain); oscillator.start();
      }
      globalThis.modeTracks.push(...output.stream.getTracks());
      return output.stream;
    };
    document.getElementById('practice-coach').click();
    const chord = document.getElementById('extra-chord');
    for (const value of ['F', 'Bm']) {
      chord.value = value; chord.dispatchEvent(new Event('change'));
      if (!document.getElementById('coach-tip').textContent.includes('Barre')) throw new Error('Missing barre tip');
      if (!document.querySelector('#extra-diagram .barre')) throw new Error('Missing barre diagram');
    }
    chord.value = 'Am'; chord.dispatchEvent(new Event('change'));
  })()`);
  const screenshot = async (mode) => {
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width, height: 844, deviceScaleFactor: 1, mobile: true,
      });
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
      if (process.env.PRACTICE_SCREENSHOTS) {
        await page.evaluate('scrollTo(0, 0)');
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        await writeFile(resolve(process.env.PRACTICE_SCREENSHOTS, `${mode}-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  };
  await screenshot('coach');
  await page.evaluate(`document.getElementById('extra-start').click()`);
  await until(() => page.evaluate(`document.getElementById('extra-status').textContent.includes('minute starts')`),
    'coach calibration ready');
  assert.equal(await page.evaluate(`document.getElementById('nav-history').disabled`), true);
  assert.equal(await page.evaluate(`document.getElementById('practice-rhythm').disabled`), true);
  await page.evaluate(`globalThis.modeGain.gain.value = 0.035`);
  await until(() => page.evaluate(`!document.getElementById('coach-counts').textContent.startsWith('0 ')`),
    'actual synthetic Am spectrum produces stable chord feedback');
  assert.match(await page.evaluate(`document.getElementById('coach-quality').textContent`), /close/i);
  await page.evaluate(`document.querySelectorAll('#coach-strings button')[1].click()`);
  assert.match(await page.evaluate(`document.getElementById('coach-target').textContent`), /A.*open.*A2.*alone/);
  assert.equal(await page.evaluate(`document.querySelectorAll('#coach-strings button')[0].disabled`), true);
  // Use real elapsed time: jumping performance.now would intentionally trip stale-capture protection.
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  try {
    await until(() => page.evaluate(`document.getElementById('history-save').textContent === 'Saved on this device.'
      && document.getElementById('extra-countdown').textContent === '0'`), 'natural coach completion saved');
  } catch (error) {
    console.error(await page.evaluate(`({
      status: document.getElementById('extra-status').textContent,
      error: document.getElementById('extra-error').textContent,
      countdown: document.getElementById('extra-countdown').textContent,
      save: document.getElementById('history-save').textContent,
      hidden: document.hidden, tracks: globalThis.modeTracks.map(track => track.readyState)
    })`));
    throw error;
  }
  assert.equal(await page.evaluate(`globalThis.modeTracks.every(track => track.readyState === 'ended')`), true);
  await page.evaluate(`globalThis.modeAudio.close();
    document.getElementById('practice-rhythm').click()`);
  assert.equal(await page.evaluate(`document.getElementById('rhythm-bpm').value`), '80');
  assert.equal(await page.evaluate(`document.getElementById('rhythm-sound').value`), 'beat');
  await screenshot('strumming');
  await page.evaluate(`(() => {
    const original = AudioContext.prototype.createOscillator;
    globalThis.rhythmFrequencies = [];
    AudioContext.prototype.createOscillator = function() {
      const oscillator = original.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (...args) => { globalThis.rhythmFrequencies.push(oscillator.frequency.value); start(...args); };
      return oscillator;
    };
  })();
    document.getElementById('extra-chord').value = 'F';
    document.getElementById('extra-chord').dispatchEvent(new Event('change'));
    document.getElementById('rhythm-sound').value = 'strums';
    document.getElementById('rhythm-pattern').value = 'offbeat-ups';
    document.getElementById('rhythm-pattern').dispatchEvent(new Event('change'))`);
  await page.evaluate(`document.getElementById('extra-start').click()`);
  await until(() => page.evaluate(`document.getElementById('rhythm-position').textContent.includes('Count in')`), 'one bar count-in');
  assert.match(await page.evaluate(`document.getElementById('rhythm-timing').textContent`), /timing not measured/);
  await until(() => page.evaluate(`document.getElementById('rhythm-position').textContent.includes('Bar 1')`),
    'guided rhythm exercise starts after count-in');
  await until(() => page.evaluate(`globalThis.rhythmFrequencies.length >= 5`), 'offbeat strum cue scheduled');
  assert.deepEqual(await page.evaluate(`globalThis.rhythmFrequencies.slice(0, 5)`), [1200, 800, 800, 800, 880]);
  assert.equal(await page.evaluate(`globalThis.modeMicCalls`), 1, 'guided metronome never requests a microphone');
  await page.evaluate(`document.getElementById('extra-finish').click()`);
  await until(() => page.evaluate(`document.getElementById('history-save').textContent === 'Saved on this device.'
    && !document.getElementById('extra-start').disabled`), 'early guided rhythm saved');
  await page.evaluate(`document.getElementById('rhythm-microphone').checked = true;
    document.getElementById('rhythm-microphone').dispatchEvent(new Event('change'));
    document.getElementById('extra-start').click()`);
  assert.match(await page.evaluate(`document.getElementById('extra-error').textContent`), /headphones/);
  assert.equal(await page.evaluate(`globalThis.modeMicCalls`), 1, 'missing headphone consent prevents mic startup');
  await page.evaluate(`document.getElementById('rhythm-headphones').checked = true;
    document.getElementById('rhythm-sound').value = 'beat';
    document.getElementById('rhythm-bpm').value = '160';
    document.getElementById('extra-start').click()`);
  await until(() => page.evaluate(`document.getElementById('extra-status').textContent.includes('calibration')`),
    'microphone timing calibration visible');
  await until(() => page.evaluate(`document.getElementById('rhythm-position').textContent.includes('Bar 1')`),
    'optional timing starts after calibration and count-in');
  await page.evaluate(`document.getElementById('extra-finish').click()`);
  await until(() => page.evaluate(`document.getElementById('history-save').textContent === 'Saved on this device.'
    && !document.getElementById('extra-start').disabled`), 'measured rhythm saved');
  assert.equal(await page.evaluate(`globalThis.modeTracks.every(track => track.readyState === 'ended')`), true);
  assert.match(await page.evaluate(`document.getElementById('rhythm-timing').textContent`), /Estimated timing \(uncalibrated\)/);
  await page.evaluate(`(async () => {
    await globalThis.modeAudio.close();
    globalThis.lateContext = new AudioContext();
    await globalThis.lateContext.resume();
    globalThis.lateOutput = globalThis.lateContext.createMediaStreamDestination();
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => globalThis.lateGrant = resolve);
    document.getElementById('extra-start').click();
  })()`);
  await until(() => page.evaluate(`typeof globalThis.lateGrant === 'function'`), 'pending microphone setup');
  const { client: target, id } = await newTab(`${otherOrigin}/#history`);
  await target.send('Page.bringToFront');
  await until(() => page.evaluate(`document.getElementById('extra-status').textContent.includes('discarded')
    && !document.getElementById('extra-start').disabled`), 'hiding aborts unresolved permission setup promptly');
  await page.evaluate(`globalThis.lateGrant(globalThis.lateOutput.stream)`);
  await until(() => page.evaluate(`globalThis.lateOutput.stream.getTracks().every(track => track.readyState === 'ended')`),
    'late microphone grant is stopped after hidden cancellation');
  await page.evaluate(`globalThis.lateContext.close()`);
  await page.send('Page.bringToFront');
  await page.evaluate(`document.getElementById('nav-history').click()`);
  await until(() => page.evaluate(`document.getElementById('history-total-rounds').textContent === '30'`), 'mixed mode totals');
  assert.equal(await page.evaluate(`document.getElementById('history-total-switches').textContent`), '300');
  assert.match(await page.evaluate(`document.getElementById('history-mode-totals').textContent`), /Learn a chord: 1.*Strumming: 2/);
  const exported = await page.evaluate(`(async () => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { globalThis.modeBackupBlob = blob; return create(blob); };
    document.getElementById('history-export').click();
    return true;
  })()`);
  assert.equal(exported, true);
  const json = await until(() => page.evaluate(`globalThis.modeBackupBlob?.text()`), 'mixed JSON backup download');
  const backup = JSON.parse(json);
  assert.equal(backup.version, 2);
  assert.equal(backup.records.filter(record => record.mode === 'coach').length, 1);
  assert.equal(backup.records.filter(record => record.mode === 'rhythm').length, 2);
  const guided = backup.records.find(record => record.mode === 'rhythm' && !record.timingMeasured);
  assert.equal(guided.tracking, 'guided');
  assert.equal(guided.soundMode, 'strums');
  assert.equal(guided.patternId, 'offbeat-ups');
  assert.equal(guided.heldChord, 'F');
  assert.equal(guided.matched, null);
  assert.equal(guided.completed, false);
  assert.equal(backup.records.find(record => record.mode === 'coach').completed, true);
  await until(() => target.evaluate(`document.getElementById('history-total-rounds')?.textContent === '0'`), 'new mixed-transfer device');
  const select = async (data) => {
    await target.evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(data)}], 'modes.json', { type: 'application/json' }));
      const input = document.getElementById('history-file');
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    })()`);
    await until(() => target.evaluate(`!document.getElementById('history-preview').hidden`), 'mixed backup preview');
    await target.evaluate(`document.getElementById('history-confirm').click()`);
  };
  await select(json);
  await until(() => target.evaluate(`document.getElementById('history-total-rounds').textContent === '30'`), 'mixed transfer committed');
  await select(JSON.stringify({ ...backup, version: 1, records: backup.records.filter(record => !record.mode) }));
  await until(() => target.evaluate(`document.getElementById('history-transfer-status').textContent.includes('0 added · 27 duplicates')`),
    'legacy reimport deduplicates canonical switch summaries');
  await target.send('Page.reload');
  await until(() => target.evaluate(`document.getElementById('history-total-rounds')?.textContent === '30'`), 'mixed records survive reload');
  console.log('PASS new modes: real synthetic chord coach, natural finish and track release, explicit string target, guided no-mic/count-in, headphones consent, optional timing worklet, early finish, hidden pending-setup abort and late-grant release, responsive screens, mixed v2 transfer/reload and v1 dedup');
  return id;
}
