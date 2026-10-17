import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  projects: base.projects!.map((p) => ({
    ...p,
    testMatch:
      p.name === 'mobile'
        ? /design-(?:prototype-(?:mobile|toggle)|virtualization)\.spec\.ts/
        : /design-(?:prototype(?:-toggle)?|virtualization)\.spec\.ts/,
  })),
  workers: 1,
  reporter: [['list']],
  outputDir: '/tmp/design-prototype-production-results',
  testMatch: /design-(?:prototype(?:-(?:mobile|toggle))?|virtualization)\.spec\.ts/,
  use: { ...base.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    {
      command: 'npm run preview -- --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
    {
      command: 'npm run collaboration:server',
      url: 'http://127.0.0.1:4180/collaboration-api/health',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
