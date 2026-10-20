import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { animationRuntimePin } from './scripts/animation-runtime-pin.mjs';
export default defineConfig({
  base: './',
  root: 'apps/animation-reference',
  plugins: [react(), animationRuntimePin()],
  build: { outDir: '../../dist/animation-host', emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 4189, strictPort: true },
});
