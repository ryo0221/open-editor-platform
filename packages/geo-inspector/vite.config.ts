import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./test-host', import.meta.url)),
  define: { EDITOR_PINS: JSON.stringify({ '@editor-platform/geo-inspector': 'a'.repeat(64) }) },
  build: {
    target: 'es2022',
    outDir: '/tmp/geo-inspector-build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        inspector: fileURLToPath(new URL('./test-host/index.html', import.meta.url)),
        importWorkbench: fileURLToPath(new URL('./test-host/import.html', import.meta.url)),
        editFixture: fileURLToPath(new URL('./test-host/edit.html', import.meta.url)),
        sourceEditFixture: fileURLToPath(new URL('./test-host/source-edit.html', import.meta.url)),
        dataExportFixture: fileURLToPath(new URL('./test-host/export.html', import.meta.url)),
        workspaceFixture: fileURLToPath(new URL('./test-host/workspace.html', import.meta.url)),
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4199, strictPort: true },
});
