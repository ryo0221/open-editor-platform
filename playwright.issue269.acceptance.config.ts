import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const development = process.env.ISSUE269_DEV === '1';
export default defineConfig({
  ...base,
  workers: 1,
  reporter: [['list']],
  outputDir: '/tmp/issue269-acceptance',
  projects: [
    {
      name: 'desktop',
      use: {
        ...base.projects!.find((project) => project.name === 'desktop')!.use,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...base.projects!.find((project) => project.name === 'mobile')!.use,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  testMatch: development
    ? /(?:design-prototype-toggle|document-performance)\.spec\.ts/
    : /(?:design-prototype-toggle|document-performance|canvas-text-visibility)\.spec\.ts/,
  use: { ...base.use, baseURL: `http://127.0.0.1:${development ? 5173 : 4173}` },
  webServer: {
    command: development
      ? 'npx vite --config vite.issue269.config.ts --port 5173 --strictPort'
      : 'npm run preview -- --port 4173 --strictPort',
    url: development
      ? 'http://127.0.0.1:5173/tests/fixtures/design-prototype/large.html'
      : 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
