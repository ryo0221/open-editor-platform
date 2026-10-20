import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/scale/animation/*.bench.test.ts'], testTimeout: 600000 },
});
