import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  build: {
    outDir: '/tmp/geo-inspector-build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        inspector: fileURLToPath(new URL('./test-host/index.html', import.meta.url)),
        importWorkbench: fileURLToPath(new URL('./test-host/import.html', import.meta.url)),
        editFixture: fileURLToPath(new URL('./test-host/edit.html', import.meta.url)),
        sourceEditFixture: fileURLToPath(new URL('./test-host/source-edit.html', import.meta.url)),
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4199, strictPort: true },
});
