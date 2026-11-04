import { defineConfig } from 'vitest/config';
import { animationRuntimePin } from './scripts/animation-runtime-pin.mjs';
import { cadDevelopmentKernel } from './scripts/dev/cad-kernel.mjs';
import { playgroundMangaSample } from './scripts/dev/playground-manga.mjs';
export default defineConfig({
  plugins: [animationRuntimePin(), cadDevelopmentKernel(), playgroundMangaSample()],
  // Native-size and browser-backed fixtures must not compete for the same memory/CPU
  // budget. Keep every test and its existing deadline; run test files sequentially.
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], maxWorkers: 1 },
});
