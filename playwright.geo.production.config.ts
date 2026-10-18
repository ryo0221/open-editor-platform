import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'geo-workspace.spec.ts',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: '/tmp/issue97-playground-evidence/results',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4197',
    screenshot: 'only-on-failure',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'narrow', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: './node_modules/.bin/vite preview --host 127.0.0.1 --port 4197 --strictPort',
    url: 'http://127.0.0.1:4197',
    reuseExistingServer: false,
  },
});
