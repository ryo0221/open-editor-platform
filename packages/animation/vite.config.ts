import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./fixture', import.meta.url)),
  build: {
    target: 'es2022',
    outDir: '/tmp/animation-editing-dist',
    emptyOutDir: false,
    // Match the ordinary Host build: Rollup's call-argument tree-shaking analysis
    // stalls on this graph. Keep esbuild minification; no runtime/API change.
    rollupOptions: { treeshake: false },
  },
  server: { host: '127.0.0.1', port: 5195, strictPort: true },
});
