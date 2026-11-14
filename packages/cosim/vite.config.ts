import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The co-simulation Surface's test host (SL8b).
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  build: { target: 'es2022', outDir: '/tmp/cosim-surface-build', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4217, strictPort: true },
  preview: { host: '127.0.0.1', port: 4217, strictPort: true },
});
