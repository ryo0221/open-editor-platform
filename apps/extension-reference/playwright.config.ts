import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './tests',
  outputDir: '../../test-results/extension-reference',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4196',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command:
      'npx vite preview --config apps/extension-reference/vite.config.ts --host 127.0.0.1 --port 4196',
    url: 'http://127.0.0.1:4196',
    cwd: '../..',
  },
});
