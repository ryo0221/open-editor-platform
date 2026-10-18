import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Independent public-API Hosts, with actual Vite development React/StrictMode.
export default defineConfig({
  root: '.',
  plugins: [react()],
  publicDir: 'apps/playground/public',
  optimizeDeps: {
    entries: [
      'tests/fixtures/design-prototype/large.html',
      'tests/fixtures/document-performance/index.html',
    ],
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
