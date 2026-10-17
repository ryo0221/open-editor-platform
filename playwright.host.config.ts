import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'host-integration.spec.ts',
  workers: 2,
  timeout: 60000,
  reporter: [['list']],
  outputDir: process.env.HOST_STUDIO_URL
    ? 'work/issue-33-36/studio-results'
    : 'work/issue-33-36/reference-results',
  use: {
    baseURL: process.env.HOST_STUDIO_URL ?? 'http://127.0.0.1:4177',
    launchOptions: { executablePath: '/usr/bin/chromium' },
    screenshot: 'only-on-failure',
    trace: { mode: 'retain-on-failure', snapshots: false },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: process.env.HOST_STUDIO_URL
    ? undefined
    : {
        command: 'npx vite preview --config vite.artifact-host.config.ts',
        url: 'http://127.0.0.1:4177',
        reuseExistingServer: false,
        timeout: 60000,
      },
});
