import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CaptureHandlers } from '../src/audio/capture';

const start = vi.hoisted(() => vi.fn());
vi.mock('../src/audio/capture', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/audio/capture')>(), startCapture: start,
}));

class ScreenElement extends EventTarget {
  value = '';
  textContent = '';
  checked = false;
  disabled = false;
  hidden = false;
  href = '';
  download = '';
  readonly children: ScreenElement[] = [];
  clicked = false;
  append(child: ScreenElement): void { this.children.push(child); }
  remove(): void {}
  click(): void {
    if (this.disabled) return;
    this.clicked = true; this.dispatchEvent(new Event('click'));
  }
}

class ScreenDocument extends EventTarget {
  hidden = false;
  readonly body = new ScreenElement();
  readonly elements = new Map<string, ScreenElement>();
  getElementById(id: string): ScreenElement {
    let value = this.elements.get(id);
    if (!value) {
      value = new ScreenElement(); this.elements.set(id, value);
    }
    return value;
  }
  createElement(): ScreenElement { return new ScreenElement(); }
}

let screen: ScreenDocument;
let callbacks: CaptureHandlers;
let now: number;
const stop = vi.fn(async (): Promise<void> => {});
const blobs: Blob[] = [];
const timers: (() => void)[] = [];
const revoke = vi.fn();
const get = (id: string): ScreenElement => screen.getElementById(id);

beforeEach(() => {
  vi.resetModules(); start.mockReset(); stop.mockClear(); revoke.mockClear();
  blobs.length = 0; timers.length = 0; now = 1000;
  screen = new ScreenDocument();
  get('independent').checked = true;
  get('mode').value = 'pair';
  vi.stubGlobal('document', screen);
  vi.stubGlobal('navigator', { userAgent: 'Chrome test boundary' });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const window = Object.assign(new EventTarget(), {
    setInterval: vi.fn(),
    setTimeout: (callback: () => void): number => timers.push(callback),
  });
  vi.stubGlobal('window', window);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob): string => {
    if (!(blob instanceof Blob)) throw new Error('Expected report Blob');
    blobs.push(blob); return 'blob:local-report';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
  start.mockImplementation((_pair, handlers: CaptureHandlers) => {
    callbacks = handlers;
    handlers.onCalibration({ status: 'calibrating', remainingMs: 2000 });
    return Promise.resolve({ settings: { sampleRate: 44100 }, analysisSampleRate: 48000, stop });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('trusted start, independent labeling, finish and explicit report download are wired end to end', async () => {
  await import('../src/main');
  get('start').click();
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0][0]).toEqual(['A', 'D']);
  expect(get('configuration').disabled).toBe(true);
  expect(get('status').textContent).toContain('Calibrating');
  get('confirm-first').click();
  callbacks.onCalibration({ status: 'ready', remainingMs: 0, noiseFloorRms: 0.001 });
  await Promise.resolve();
  expect(blobs).toHaveLength(0);
  get('confirm-first').click();
  expect(get('prediction').textContent).toContain('hidden');
  now = 2000;
  get('confirm-second').click();
  expect(get('count').textContent).toBe('1');
  now = 3000;
  get('finish').click();
  expect(stop).toHaveBeenCalledOnce();
  expect(blobs).toHaveLength(0);
  get('device').value = 'Android test device';
  get('reviewed').checked = true;
  get('reviewed').dispatchEvent(new Event('change'));
  get('export').click();
  expect(blobs).toHaveLength(1);
  const report = JSON.parse(await blobs[0].text());
  expect(report.references).toEqual([{ chord: 'A', atMs: 0 }, { chord: 'D', atMs: 1000 }]);
  expect(report.results).toMatchObject({ misses: 1, passed: false });
  expect(report.analysisSampleRate).toBe(48000);
  expect(report.settings.sampleRate).toBe(44100);
  expect(screen.body.children.at(-1)?.clicked).toBe(true);
  expect(screen.body.children.at(-1)?.download).toMatch(/^chord-validation-v1-/);
  timers.forEach((callback) => callback());
  expect(revoke).toHaveBeenCalledWith('blob:local-report');
});

test('hidden page discards capture and returning visible cannot restart it without a tap', async () => {
  await import('../src/main');
  get('start').click();
  callbacks.onCalibration({ status: 'ready', remainingMs: 0 });
  await Promise.resolve();
  get('confirm-first').click();
  screen.hidden = true; screen.dispatchEvent(new Event('visibilitychange'));
  expect(stop).toHaveBeenCalledOnce();
  expect(get('status').textContent).toContain('discarded');
  screen.hidden = false; screen.dispatchEvent(new Event('visibilitychange'));
  expect(start).toHaveBeenCalledOnce();
  get('resume').click();
  expect(start).toHaveBeenCalledTimes(2);
  expect(get('status').textContent).toContain('Calibrating');
});

test('denied permission is visible and leaves a new-attempt resume path', async () => {
  start.mockImplementation((_pair, handlers: CaptureHandlers) => {
    const error = new Error('Permission denied by browser');
    handlers.onError(error);
    return Promise.reject(error);
  });
  await import('../src/main');
  get('start').click();
  await Promise.resolve();
  expect(get('error').hidden).toBe(false);
  expect(get('error').textContent).toContain('Permission denied by browser');
  expect(get('resume').disabled).toBe(false);
  expect(blobs).toHaveLength(0);
});
