import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: './tests',
  workers: 1,
  reporter: 'list',
  outputDir: '/tmp/animation-player-browser-results',
  use: {
    baseURL: 'http://127.0.0.1:5194',
    screenshot: 'only-on-failure',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    command:
      'npx vite preview --config packages/animation-player/vite.config.ts --host 127.0.0.1 --port 5194 --strictPort',
    url: 'http://127.0.0.1:5194',
    reuseExistingServer: false,
  },
});
