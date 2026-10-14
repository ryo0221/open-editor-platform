import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  projects: base.projects!.map((project) => ({
    ...project,
    testMatch:
      project.name === 'mobile'
        ? /design-reuse-graphics-mobile\.spec\.ts/
        : /design-reuse-graphics\.spec\.ts/,
  })),
  workers: 1,
  reporter: [['list']],
  outputDir: '/tmp/design-reuse-production-results',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    {
      command: 'npm run preview -- --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
  ],
});
