import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'apps/playground',
  plugins: [react()],
  worker: { format: 'es' },
  // Resolve Mermaid's dependencies separately so lockfile security updates apply
  // to the emitted runtime instead of using its older prebundled dependencies.
  // Chunks remain lazy-loaded and esbuild still minifies them.
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
  // Prebundle the lazy PDF entry before the first viewer is opened. Otherwise a
  // cold dev server can invalidate module URLs in an already-open editor.
  optimizeDeps: { include: ['pdfjs-dist', 'prosemirror-collab', 'prosemirror-transform'] },
  build: {
    rollupOptions: {
      treeshake: false,
      input: {
        collaboration: fileURLToPath(
          new URL('./apps/playground/collaboration.html', import.meta.url),
        ),
        templates: fileURLToPath(new URL('./apps/playground/template-host.html', import.meta.url)),
        playground: fileURLToPath(new URL('./apps/playground/index.html', import.meta.url)),
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
