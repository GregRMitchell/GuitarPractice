import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Exercise real audio-clock play-alongs, cancellation and portable history in Edge. */
export async function checkProgressions({ page, otherOrigin, newTab, until }) {
  await page.send('Page.bringToFront');
  await page.evaluate(`document.getElementById('nav-practice').click(); document.getElementById('practice-progression').click()`);
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await page.evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    if (process.env.PRACTICE_SCREENSHOTS) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(resolve(process.env.PRACTICE_SCREENSHOTS, `progression-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await page.evaluate(`(() => {
    const preset = document.getElementById('progression-preset');
    preset.value = 'four'; preset.dispatchEvent(new Event('change'));
    if (document.querySelectorAll('#progression-editor select').length !== 4) throw Error('preset');
    const chord = document.querySelectorAll('#progression-editor select')[1];
    chord.value = 'G'; chord.dispatchEvent(new Event('change'));
    document.getElementById('progression-add').click();
    if (document.querySelectorAll('#progression-editor select').length !== 5) throw Error('add');
    document.querySelectorAll('#progression-editor button')[4].click();
    if (document.querySelectorAll('#progression-editor select').length !== 4) throw Error('remove');
    preset.value = 'first'; preset.dispatchEvent(new Event('change'));
    for (const [id, value] of [['progression-bpm', '160'], ['progression-loops', '1']]) {
      const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('change'));
    }
    globalThis.progressionMicCalls = 0;
    navigator.mediaDevices.getUserMedia = () => {
      globalThis.progressionMicCalls++;
      return new Promise(resolve => { globalThis.progressionGrant = resolve; });
    };
  })()`);
  assert.match(await page.evaluate(`document.getElementById('progression-preview').textContent`), /3\.0 seconds/);
  const trustedClick = async (id) => {
    const point = await page.evaluate(`(() => {
      const button = document.getElementById('${id}'); button.scrollIntoView({block:'center'});
      const rect = button.getBoundingClientRect(); return {x:rect.x + rect.width / 2, y:rect.y + rect.height / 2};
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  await trustedClick('progression-start');
  await until(() => page.evaluate(`document.getElementById('progression-status').textContent.includes('Get ready')`), 'progression count-in');
  assert.equal(await page.evaluate(`document.getElementById('practice-rhythm').disabled && document.getElementById('nav-history').disabled`), true);
  await until(() => page.evaluate(`document.getElementById('progression-status').textContent.includes('Play Em')`), 'first prompted chord');
  assert.equal(await page.evaluate(`document.getElementById('progression-next').textContent`), 'Am');
  await until(() => page.evaluate(`document.getElementById('progression-status').textContent.includes('Play Am')`), 'second prompted chord');
  await until(() => page.evaluate(`document.getElementById('history-save').textContent === 'Saved on this device.'
    && !document.getElementById('progression-start').disabled`), 'natural progression saved');
  assert.equal(await page.evaluate(`globalThis.progressionMicCalls`), 0);
  await trustedClick('progression-start');
  await until(() => page.evaluate(`document.getElementById('progression-status').textContent.includes('Play Em')`), 'early round begins');
  await trustedClick('progression-finish');
  await until(() => page.evaluate(`document.getElementById('history-save').textContent === 'Saved on this device.'
    && !document.getElementById('progression-start').disabled`), 'early progression saved');
  await page.evaluate(`document.getElementById('progression-microphone').checked = true;
    document.getElementById('progression-microphone').dispatchEvent(new Event('change'))`);
  await trustedClick('progression-start');
  assert.match(await page.evaluate(`document.getElementById('progression-error').textContent`), /headphones/);
  assert.equal(await page.evaluate(`globalThis.progressionMicCalls`), 0);
  await page.evaluate(`document.getElementById('progression-audible').checked = false;
    document.getElementById('progression-audible').dispatchEvent(new Event('change'))`);
  await trustedClick('progression-start');
  await until(() => page.evaluate(`globalThis.progressionMicCalls === 1`), 'pending progression microphone');
  const { client: target, id } = await newTab(`${otherOrigin}/#history`);
  await target.send('Page.bringToFront');
  await until(() => page.evaluate(`document.getElementById('progression-status').textContent.includes('discarded')
    && !document.getElementById('progression-start').disabled`), 'hidden progression abort');
  await page.evaluate(`(async () => {
    globalThis.progressionLateContext = new AudioContext();
    globalThis.progressionLateOutput = globalThis.progressionLateContext.createMediaStreamDestination();
    globalThis.progressionGrant(globalThis.progressionLateOutput.stream);
  })()`);
  await until(() => page.evaluate(`globalThis.progressionLateOutput.stream.getTracks().every(track => track.readyState === 'ended')`),
    'late progression grant released');
  await page.evaluate(`globalThis.progressionLateContext.close()`);
  await page.send('Page.bringToFront');
  await page.evaluate(`(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      globalThis.progressionAudio = new AudioContext();
      await globalThis.progressionAudio.resume();
      globalThis.progressionOutput = globalThis.progressionAudio.createMediaStreamDestination();
      return globalThis.progressionOutput.stream;
    };
  })()`);
  await trustedClick('progression-start');
  await until(() => page.evaluate(`document.getElementById('progression-status').textContent.includes('Play Em')`), 'measured progression starts');
  await until(() => page.evaluate(`document.getElementById('history-save').textContent === 'Saved on this device.'
    && !document.getElementById('progression-start').disabled`), 'measured progression naturally saved');
  assert.equal(await page.evaluate(`globalThis.progressionOutput.stream.getTracks().every(track => track.readyState === 'ended')`), true);
  await page.evaluate(`globalThis.progressionAudio.close()`);
  await page.evaluate(`document.getElementById('nav-history').click()`);
  await until(() => page.evaluate(`document.getElementById('history-total-rounds').textContent === '33'`), 'progression totals');
  assert.equal(await page.evaluate(`document.getElementById('history-total-switches').textContent`), '300');
  await page.evaluate(`(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { globalThis.progressionBackup = blob; return create(blob); };
    document.getElementById('history-export').click();
  })()`);
  const json = await until(() => page.evaluate(`globalThis.progressionBackup?.text()`), 'progression export');
  const records = JSON.parse(json).records.filter((record) => record.mode === 'progression');
  assert.equal(records.length, 3);
  assert.deepEqual(records.find((record) => record.completed).sequence, ['Em', 'Am']);
  assert.equal(records.find((record) => record.completed).targetMs, 3000);
  assert.equal(records.find((record) => record.completed).activeMs, 3000);
  assert(records.some((record) => !record.completed && record.activeMs > 0 && record.activeMs < 3000));
  assert(records.some((record) => record.completed && record.timingMeasured && record.tracking === 'microphone'));
  await until(() => target.evaluate(`document.getElementById('history-total-rounds')?.textContent === '0'`), 'transfer target');
  await target.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(json)}], 'backup.json', { type: 'application/json' }));
    const input = document.getElementById('history-file');
    input.files = transfer.files; input.dispatchEvent(new Event('change'));
  })()`);
  await until(() => target.evaluate(`!document.getElementById('history-preview').hidden`), 'progression transfer preview');
  await target.evaluate(`document.getElementById('history-confirm').click()`);
  await until(() => target.evaluate(`document.getElementById('history-total-rounds').textContent === '33'`), 'progression transfer committed');
  await target.send('Page.reload');
  await until(() => target.evaluate(`document.getElementById('history-total-rounds')?.textContent === '33'`), 'progression transfer reload');
  console.log('PASS progressions: presets/custom edits, responsive screens, trusted audio start, count-in/chords, natural and early saves, optional timing, microphone guard/hidden abort/late release, mixed transfer/reload');
  return id;
}
