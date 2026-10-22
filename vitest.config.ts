import { defineConfig } from 'vitest/config';
import { animationRuntimePin } from './scripts/animation-runtime-pin.mjs';
import { cadDevelopmentKernel } from './scripts/dev/cad-kernel.mjs';
export default defineConfig({
  plugins: [animationRuntimePin(), cadDevelopmentKernel()],
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], maxWorkers: 2 },
});
