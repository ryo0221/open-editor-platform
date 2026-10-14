import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /(?:issue2-embedding|practical-host|practical-history-review).spec.ts/,
  workers: 1,
  timeout: 60000,
  outputDir: 'test-results-cross',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'firefox', use: { browserName: 'firefox' } },
    {
      name: 'webkit',
      use: {
        browserName: 'webkit',
        launchOptions: process.env.EDITOR_WEBKIT_EXECUTABLE
          ? { executablePath: process.env.EDITOR_WEBKIT_EXECUTABLE }
          : {},
      },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run collaboration:server',
      url: 'http://127.0.0.1:4180/collaboration-api/health',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
