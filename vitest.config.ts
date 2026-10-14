import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // Codec tests launch isolated child processes. One file worker avoids
    // oversubscribing those decoders on shared/cloud verification runners.
    maxWorkers: 1,
    // Large boundary/corpus cases verify correctness, not a five-second SLA.
    // Explicit per-case limits remain authoritative.
    testTimeout: 120_000,
  },
});
