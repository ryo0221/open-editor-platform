import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'scripts/extension-hosts/geo-source-{storage,adapter,profile}.test.ts',
      'scripts/extension-hosts/geo-data-export.test.ts',
    ],
    maxWorkers: 1,
  },
});
