import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dependencySecurity } from './scripts/dev/dependency-security.mjs';
const js = buildSync({
  entryPoints: ['apps/artifact-host/src/preview.tsx'],
  bundle: true,
  write: false,
  minify: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const digest = createHash('sha256').update(js).digest('base64');
const preview = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"></head><body><div id="root"></div><script>${js}</script></body></html>`;
export default defineConfig({
  root: 'apps/artifact-host',
  plugins: [react(), dependencySecurity()],
  worker: { format: 'es', plugins: () => [dependencySecurity('worker')] },
  resolve: {
    alias: [
      {
        find: /^mermaid$/,
        replacement: fileURLToPath(
          new URL('./node_modules/mermaid/dist/mermaid.core.mjs', import.meta.url),
        ),
      },
    ],
  },
  define: { __ARTIFACT_PREVIEW_DOCUMENT__: JSON.stringify(preview) },
  server: { host: '0.0.0.0', port: 5177, strictPort: true },
  preview: { host: '0.0.0.0', port: 4177, strictPort: true },
  build: {
    outDir: '../../dist/artifact-host',
    emptyOutDir: true,
    rollupOptions: {
      treeshake: false,
      input: {
        index: fileURLToPath(new URL('./apps/artifact-host/index.html', import.meta.url)),
        access: fileURLToPath(new URL('./apps/artifact-host/access.html', import.meta.url)),
        lifecycle: fileURLToPath(new URL('./apps/artifact-host/lifecycle.html', import.meta.url)),
      },
    },
  },
});
