import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./fixture', import.meta.url)),
  build: {
    target: 'es2022',
    outDir: '/tmp/animation-player-fixture-dist',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        prototype: fileURLToPath(new URL('./fixture/index.html', import.meta.url)),
        v1: fileURLToPath(new URL('./fixture/v1.html', import.meta.url)),
      },
    },
  },
  server: { host: '127.0.0.1', port: 5194, strictPort: true },
});
