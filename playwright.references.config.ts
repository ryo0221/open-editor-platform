import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const production = process.env.EDITOR_REFERENCE_PRODUCTION === '1';
const baseURL = production ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:5173';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['artifact-references.spec.ts', 'artifact-references-review.spec.ts'],
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: production ? 'npm run preview -- --port 4173 --strictPort' : 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
