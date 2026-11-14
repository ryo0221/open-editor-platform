import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The circuit board Surface's test host (PB1): no kernel.
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  build: { target: 'es2022', outDir: '/tmp/pcb-surface-build', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4207, strictPort: true },
  preview: { host: '127.0.0.1', port: 4207, strictPort: true },
});
