import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'apps/react-ui-reference',
  plugins: [react()],
  resolve: {
    alias: {
      '@reference/ui': fileURLToPath(
        new URL('./apps/react-ui-reference/src/components.tsx', import.meta.url),
      ),
      '@reference/product-image': fileURLToPath(
        new URL('./tests/fixtures/office/images/quadrants.png', import.meta.url),
      ),
      '@reference/dependency-style': fileURLToPath(
        new URL('./apps/react-ui-reference/public/styles/dependency-fixture.css', import.meta.url),
      ),
    },
  },
  server: { host: '0.0.0.0', port: 5174, strictPort: true },
  preview: { host: '0.0.0.0', port: 4174, strictPort: true },
  build: {
    rollupOptions: {
      treeshake: false,
      input: ['apps/react-ui-reference/index.html', 'apps/react-ui-reference/design.html'],
    },
    outDir: '../../dist/react-ui-preview',
    emptyOutDir: true,
  },
});
