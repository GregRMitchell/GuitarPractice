import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { offlineRuntime } from './offline-runtime.mjs';

/**
 * Generate a base-aware manifest and service worker from every emitted runtime file.
 * @returns {import('vite').Plugin} Vite build-only offline plugin.
 */
export function offlinePlugin() {
  const version = randomUUID();
  let base = '/';
  let output;
  return {
    name: 'guitar-offline',
    apply: 'build',
    config: () => ({ define: { __APP_VERSION__: JSON.stringify(version) } }),
    configResolved(config) {
      if (!config.base.startsWith('/') || config.base.startsWith('//')) {
        throw new Error('Offline builds require a same-origin absolute --base, e.g. /guitar/');
      }
      base = config.base;
      output = resolve(config.root, config.build.outDir);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset', fileName: 'manifest.webmanifest',
        source: JSON.stringify({
          id: base, name: 'Chord Play · Guitar practice', short_name: 'Chord Play',
          description: 'Local open-chord microphone validation. No audio saved or uploaded.',
          start_url: base, scope: base, display: 'standalone',
          background_color: '#111d2b', theme_color: '#111d2b',
          icons: [192, 512].map((size) => ({
            src: `${base}icons/chord-${size}.png`, sizes: `${size}x${size}`,
            type: 'image/png', purpose: 'any maskable',
          })),
        }),
      });
    },
    async writeBundle() {
      const walk = async (directory, prefix = '') => {
        const entries = await readdir(directory, { withFileTypes: true });
        const groups = await Promise.all(entries.map((entry) => entry.isDirectory()
          ? walk(join(directory, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`]));
        return groups.flat();
      };
      const assets = (await walk(output)).filter((file) => file !== 'sw.js' && !file.endsWith('.map')).sort();
      const integrity = Object.fromEntries(await Promise.all(assets.map(async (file) => [
        file, `sha256-${createHash('sha256').update(await readFile(resolve(output, file))).digest('base64')}`,
      ])));
      await writeFile(join(output, 'sw.js'),
        `(${offlineRuntime.toString()})(self,caches,fetch,${JSON.stringify({ version, assets, integrity })});\n`);
    },
  };
}
