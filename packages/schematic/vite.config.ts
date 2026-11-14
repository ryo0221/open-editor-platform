import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The schematic Surface's test host (SL1).
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  build: { target: 'es2022', outDir: '/tmp/schematic-surface-build', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4209, strictPort: true },
  preview: { host: '127.0.0.1', port: 4209, strictPort: true },
});
