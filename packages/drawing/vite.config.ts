import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The drawing Surface's standalone test host (DW1, N06): no Playground state or CSS.
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  // The fixed fonts (`npm run fonts:fetch`) for PDF export (DW6).
  publicDir: fileURLToPath(new URL('../../apps/playground/public', import.meta.url)),
  build: { target: 'es2022', outDir: '/tmp/drawing-surface-build', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4233, strictPort: true },
  preview: { host: '127.0.0.1', port: 4233, strictPort: true },
});
