import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The character Surface's test host (no kernel: characters need none).
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  build: { target: 'es2022', outDir: '/tmp/character-surface-build', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4205, strictPort: true },
  preview: { host: '127.0.0.1', port: 4205, strictPort: true },
});
