import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
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
