import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('page opens on practice with diagnostics collapsed and installation last', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  expect(html).not.toMatch(/RECOGNITION LAB|Honest evidence|<[^>]+class="lede"/);
  expect(html.indexOf('id="start"')).toBeLessThan(html.indexOf('id="advanced"'));
  expect(html).toMatch(/<details[^>]*id="advanced"[^>]*>/);
  expect(html.match(/<details[^>]*id="advanced"[^>]*>/)?.[0]).not.toMatch(/\bopen\b/);
  expect(html.indexOf('id="offline-title"')).toBeGreaterThan(html.indexOf('id="export-title"'));
  expect(html).not.toMatch(/id="independent"[^>]*checked/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
});
