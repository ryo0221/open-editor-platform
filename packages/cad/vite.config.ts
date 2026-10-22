import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cadDevelopmentKernel } from '../../scripts/dev/cad-kernel.mjs';

export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  plugins: [cadDevelopmentKernel()],
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: '/tmp/cad-surface-build', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4201, strictPort: true },
  preview: { host: '127.0.0.1', port: 4201, strictPort: true },
});
