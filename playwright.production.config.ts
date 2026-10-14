import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  outputDir: '/tmp/editor-platform-production-results',
  reporter: [['list']],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    {
      command: 'node scripts/react-ui-export-server.mjs',
      url: 'http://127.0.0.1:4175',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run react-ui:preview',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
    },
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
