import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Exercise the production history UI and real IndexedDB on isolated device origins.
 * The existing offline harness supplies its CDP, server and cleanup boundaries.
 */
export async function checkHistory({ page, otherOrigin, newTab, until, directory }) {
  const downloads = resolve(directory, 'downloads');
  await mkdir(downloads, { recursive: true });
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await page.send('Page.bringToFront');
  // Synthesized silence exercises actual capture/calibration without accessing a microphone.
  await page.evaluate(`(() => {
    const nativeNow = performance.now.bind(performance);
    globalThis.historyClockOffset = 0;
    performance.now = () => nativeNow() + globalThis.historyClockOffset;
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0;
      const output = context.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(output); oscillator.start();
      globalThis.historyTestAudio?.close();
      globalThis.historyTestAudio = context;
      return output.stream;
    };
  })()`);
  const finishRound = async (full) => {
    await page.evaluate(`document.getElementById('start').click()`);
    await until(() => page.evaluate(`document.getElementById('status').textContent.startsWith('Go!')`),
      'synthetic-silence practice calibrated');
    assert.equal(await page.evaluate(`document.getElementById('nav-history').disabled`), true);
    await page.evaluate(`location.hash = '#history'`);
    await until(() => page.evaluate(`location.hash === '#practice'`), 'active hash redirected safely');
    await page.evaluate(`globalThis.historyClockOffset += ${full ? 60_100 : 1500};
      document.getElementById('finish').click()`);
    await until(() => page.evaluate(`document.getElementById('history-save').textContent === 'Saved on this device.'`),
      'practice transaction committed');
  };
  await page.evaluate(`(() => {
    for (const [id, value] of [['first', 'F'], ['second', 'Bm']]) {
      const select = document.getElementById(id);
      select.value = value; select.dispatchEvent(new Event('change'));
    }
  })()`);
  await finishRound(true);
  await page.evaluate(`document.getElementById('first').dispatchEvent(new Event('change'));
    document.getElementById('nav-history').click()`);
  await until(() => page.evaluate(`document.getElementById('history-total-rounds').textContent === '1'`), 'full round visible');
  assert.match(await page.evaluate(`document.querySelector('#history-pairs dd').textContent`), /0 switches/);
  await page.evaluate(`document.getElementById('nav-practice').click()`);
  assert.match(await page.evaluate(`document.getElementById('practice-result').textContent`), /One minute/);
  await finishRound(false);
  await page.evaluate(`globalThis.historyTestAudio.close(); document.getElementById('nav-history').click()`);
  await until(() => page.evaluate(`document.getElementById('history-total-rounds').textContent === '2'`), 'early round retained');
  await page.send('Page.reload');
  await until(() => page.evaluate(`document.getElementById('history-total-rounds')?.textContent === '2'`),
    'real IndexedDB survives reload on history hash');
  const ids = await page.evaluate(`(() => {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  })()`);
  assert.deepEqual(ids, []);
  await page.evaluate(`document.getElementById('history-export').click()`);
  const exported = await until(async () => {
    const name = (await readdir(downloads)).find(name => name.endsWith('.json'));
    if (!name) return null;
    return readFile(resolve(downloads, name), 'utf8');
  }, 'explicit version-2 JSON download');
  const backup = JSON.parse(exported);
  assert.equal(backup.version, 2);
  assert.equal(backup.records.length, 2);
  assert.deepEqual(backup.records[0].pair, ['Bm', 'F']);
  assert.equal(backup.records.filter(record => record.completed).length, 1);
  assert.equal(backup.records.find(record => record.completed).activeMs, 60_000);
  assert(backup.records.find(record => !record.completed).activeMs < 60_000);
  assert(backup.records.every(record => record.tracking === 'microphone'));

  const { client: target, id: targetId } = await newTab(`${otherOrigin}/#history`);
  await until(() => target.evaluate(`document.getElementById('history-total-rounds')?.textContent === '0'`),
    'separate device origin starts empty');
  const select = (client, json, filename = 'progress.json') => client.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(json)}], ${JSON.stringify(filename)}, {type:'application/json'}));
    const input = document.getElementById('history-file');
    input.files = transfer.files; input.dispatchEvent(new Event('change'));
  })()`);
  await select(target, exported, 'backup.txt');
  await until(() => target.evaluate(`!document.getElementById('history-preview').hidden`), 'import preview');
  assert.equal(await target.evaluate(`document.getElementById('history-total-rounds').textContent`), '0');
  await target.evaluate(`document.getElementById('history-cancel').click()`);
  assert.equal(await target.evaluate(`document.getElementById('history-total-rounds').textContent`), '0');
  await select(target, exported);
  await until(() => target.evaluate(`!document.getElementById('history-preview').hidden`), 'repeat-file preview');
  await target.evaluate(`document.getElementById('history-confirm').click()`);
  await until(() => target.evaluate(`document.getElementById('history-total-rounds').textContent === '2'`), 'device merge committed');
  await select(target, exported);
  await until(() => target.evaluate(`document.getElementById('history-preview-text').textContent.includes('0 to add')`), 'dedup preview');
  await target.evaluate(`document.getElementById('history-confirm').click()`);
  await until(() => target.evaluate(`document.getElementById('history-transfer-status').textContent.includes('0 added · 2 duplicates')`),
    'identical records skipped');
  await select(target, '{"malformed":');
  await until(() => target.evaluate(`!document.getElementById('history-transfer-error').hidden`), 'invalid JSON rejected');
  assert.equal(await target.evaluate(`document.getElementById('history-total-rounds').textContent`), '2');
  await target.send('Page.reload');
  await until(() => target.evaluate(`document.getElementById('history-total-rounds')?.textContent === '2'`), 'transferred data survives reload');

  const extra = { ...backup.records[0], id: '00000000-0000-4000-8000-000000000001' };
  await select(target, JSON.stringify({ ...backup, records: [extra, ...backup.records] }));
  await until(() => target.evaluate(`document.getElementById('history-preview-text').textContent.includes('1 to add')`), 'concurrent conflict preview');
  await target.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('guitar-practice', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(${JSON.stringify({ ...backup.records[0], switches: 777 })});
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  })`);
  await target.evaluate(`document.getElementById('history-confirm').click()`);
  await until(() => target.evaluate(`document.getElementById('history-transfer-error').textContent.includes('conflict')`),
    'concurrent conflict rejected at confirmation');
  await target.evaluate(`document.getElementById('history-refresh').click()`);
  await until(() => target.evaluate(`document.getElementById('history-total-switches').textContent === '777'`), 'concurrent record untouched');
  assert.equal(await target.evaluate(`document.getElementById('history-total-rounds').textContent`), '2');

  // Populate enough real persisted summaries to verify bounded rendering and screenshots.
  const additional = Array.from({ length: 25 }, (_, index) => ({
    ...backup.records.find(record => record.completed),
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    completedAt: `2026-11-15T20:${String(index).padStart(2, '0')}:00.000Z`, switches: index,
  }));
  await select(page, JSON.stringify({ ...backup, records: additional }));
  await until(() => page.evaluate(`!document.getElementById('history-preview').hidden`), 'pagination fixture preview');
  await page.evaluate(`document.getElementById('history-confirm').click()`);
  await until(() => page.evaluate(`document.getElementById('history-total-rounds').textContent === '27'`), 'fixture committed');
  assert.equal(await page.evaluate(`document.querySelectorAll('#history-rounds > details').length`), 20);
  await page.evaluate(`document.getElementById('history-more').click()`);
  assert.equal(await page.evaluate(`document.querySelectorAll('#history-rounds > details').length`), 27);
  assert.equal(await page.evaluate(`document.getElementById('history-more').hidden`), true);
  await page.evaluate(`document.querySelector('#history-rounds details').open = true`);
  assert.match(await page.evaluate(`document.querySelector('#history-rounds details').textContent`),
    /Completed \(UTC\).*Active time.*Target time.*Microphone estimate/s);
  await page.send('Page.bringToFront');
  for (const [width, height] of [[1280, 960], [390, 844], [320, 740]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
    if (process.env.PRACTICE_SCREENSHOTS) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(resolve(process.env.PRACTICE_SCREENSHOTS, `history-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  if (process.env.PRACTICE_SCREENSHOTS) {
    for (const [section, filename] of [['history-rounds', 'history-detail-320.png'], ['history-transfer-title', 'history-transfer-320.png']]) {
      await page.evaluate(`document.getElementById('${section}').scrollIntoView()`);
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(resolve(process.env.PRACTICE_SCREENSHOTS, filename), Buffer.from(shot.data, 'base64'));
    }
    await page.evaluate('scrollTo(0, 0)');
  }
  console.log('PASS history: real capture autosave full/early, one identity, hash guard, reload persistence, JSON download/transfer across origins, cancel/dedup/malformed/concurrent conflict preservation, pagination, responsive layouts');
  return targetId;
}
