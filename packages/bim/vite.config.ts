import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cadDevelopmentKernel } from '../../scripts/dev/cad-kernel.mjs';

// The building Surface's test host; the kernel is the development build (CAD_OCCT_DIST).
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  plugins: [cadDevelopmentKernel()],
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: '/tmp/bim-surface-build', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4204, strictPort: true },
  preview: { host: '127.0.0.1', port: 4204, strictPort: true },
});
