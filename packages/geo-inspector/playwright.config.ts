import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: './tests',
  outputDir: '/tmp/geo-inspector-evidence/results',
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4199',
    headless: true,
    launchOptions: {
      executablePath: '/usr/bin/chromium',
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'narrow', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: './node_modules/.bin/vite preview --config packages/geo-inspector/vite.config.ts',
    url: 'http://127.0.0.1:4199',
    reuseExistingServer: false,
  },
});
