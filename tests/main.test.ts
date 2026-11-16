import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('shows the pair and starts without claiming microphone capture is available', async () => {
  let click: (() => void) | undefined;
  const button = {
    disabled: false,
    addEventListener: (_event: string, handler: () => void): void => {
      click = handler;
    },
  };
  const status = { textContent: '' };
  const pair = { textContent: '' };
  const elements: Record<string, unknown> = {
    '#start': button,
    '#status': status,
    '#pair': pair,
  };
  vi.stubGlobal('document', { querySelector: (selector: string) => elements[selector] });

  await import('../src/main');
  expect(pair.textContent).toBe('A and D');
  expect(click).toBeDefined();
  click?.();
  expect(button.disabled).toBe(true);
  expect(status.textContent).toBe('Drill started. Microphone capture is not available yet.');
});
