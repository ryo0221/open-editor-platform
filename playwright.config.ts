import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  // DOM trace snapshots inject a script into sandboxed frames; keep screenshots/network traces without that instrumentation.
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: { mode: 'retain-on-failure', snapshots: false },
    screenshot: 'only-on-failure',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /mobile.spec.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testMatch: /mobile.spec.ts/,
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: [
    {
      command: 'node scripts/react-ui-export-server.mjs',
      url: 'http://127.0.0.1:4175',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run react-ui:dev',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run collaboration:server',
      url: 'http://127.0.0.1:4180/collaboration-api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
