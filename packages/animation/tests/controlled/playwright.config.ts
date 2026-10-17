import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.',
  testMatch: '*.controlled.ts',
  workers: 1,
  reporter: 'list',
  outputDir: '/tmp/animation-controlled-results',
  use: { baseURL: 'http://127.0.0.1:5197', launchOptions: { executablePath: '/usr/bin/chromium' } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    command:
      'npx vite preview --config packages/animation/tests/controlled/vite.config.ts --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
  },
});
