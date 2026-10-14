import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/react-ui-reference',
  plugins: [react()],
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
