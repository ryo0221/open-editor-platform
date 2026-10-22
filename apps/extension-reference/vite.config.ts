import { defineConfig } from 'vite';
import { bundledCounterPlugin } from './bundled-counter-build';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [bundledCounterPlugin()],
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: '../../work/extension-reference',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        legacy: fileURLToPath(new URL('index.html', import.meta.url)),
        draft2: fileURLToPath(new URL('draft2.html', import.meta.url)),
        animationViewer: fileURLToPath(new URL('animation-viewer.html', import.meta.url)),
      },
    },
  },
});
