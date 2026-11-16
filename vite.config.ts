import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rolldownOptions: {
      input: { app: 'index.html', capture: 'src/audio/capture.ts' },
      preserveEntrySignatures: 'exports-only',
    },
  },
});
