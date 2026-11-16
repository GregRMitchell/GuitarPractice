import { defineConfig } from 'vite';
import { offlinePlugin } from './build/offline-plugin.mjs';

export default defineConfig({
  plugins: [offlinePlugin()],
  build: {
    rolldownOptions: {
      input: { app: 'index.html', capture: 'src/audio/capture.ts' },
      preserveEntrySignatures: 'exports-only',
    },
  },
});
