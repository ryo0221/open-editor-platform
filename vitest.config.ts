import { defineConfig } from 'vitest/config';
import { animationRuntimePin } from './scripts/animation-runtime-pin.mjs';
export default defineConfig({
  plugins: [animationRuntimePin()],
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], maxWorkers: 2 },
});
