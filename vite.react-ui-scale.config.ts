import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'tests/fixtures/react-ui-scale',
  plugins: [react()],
  build: {
    sourcemap: true,
    target: 'es2022',
    outDir: '../../../work/complete24/scale-dist',
    emptyOutDir: true,
    rollupOptions: {
      treeshake: false,
      input: [
        'tests/fixtures/react-ui-scale/index.html',
        'tests/fixtures/react-ui-scale/preview.html',
      ],
    },
  },
});
