import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'tests/fixtures/fiction-map-d2',
  publicDir: false,
  plugins: [react()],
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5192, strictPort: true },
  preview: { host: '127.0.0.1', port: 4192, strictPort: true },
  build: {
    outDir: '../../../dist/fiction-map',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        surface: 'tests/fixtures/fiction-map-d2/index.html',
        host: 'tests/fixtures/fiction-map-d2/d3.html',
      },
    },
  },
});
