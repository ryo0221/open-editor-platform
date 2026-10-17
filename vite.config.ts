import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { officeMermaidHtml } from './scripts/dev/office-mermaid-html.mjs';
import { fileURLToPath } from 'node:url';
import { privateVideoBuild } from './scripts/dev/private-video.mjs';
export default defineConfig({
  root: 'apps/playground',
  plugins: [react(), officeMermaidHtml(), privateVideoBuild()],
  worker: { format: 'es' },
  // Resolve dependencies separately so security pins apply to emitted Mermaid
  // code; the minified upstream entry bundles older sanitizer/math dependencies.
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
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/collaboration-api': 'http://127.0.0.1:4180' },
  },
  preview: { proxy: { '/collaboration-api': 'http://127.0.0.1:4180' } },
  // Prebundle lazy PDF/Office entries before the first import/export. Otherwise
  // a cold dev server can reload an already-open editor when discovering them.
  optimizeDeps: {
    include: [
      'pdfjs-dist',
      'prosemirror-collab',
      'prosemirror-transform',
      'saxes',
      '@resvg/resvg-wasm',
      'docx',
      'pptxgenjs',
    ],
  },
  build: {
    rollupOptions: {
      treeshake: false,
      input: {
        collaboration: fileURLToPath(
          new URL('./apps/playground/collaboration.html', import.meta.url),
        ),
        templates: fileURLToPath(new URL('./apps/playground/template-host.html', import.meta.url)),
        playground: fileURLToPath(new URL('./apps/playground/index.html', import.meta.url)),
        referenceHost: fileURLToPath(
          new URL('./apps/playground/reference-host.html', import.meta.url),
        ),
        graphHost: fileURLToPath(new URL('./apps/playground/graph-host.html', import.meta.url)),
        embed: fileURLToPath(new URL('./apps/playground/embed.html', import.meta.url)),
        officeMermaid: fileURLToPath(
          new URL('./apps/playground/office-mermaid.html', import.meta.url),
        ),
      },
    },
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
