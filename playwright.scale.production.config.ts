import { defineConfig } from '@playwright/test';
import base from './playwright.scale.config';
export default defineConfig({
  ...base,
  outputDir: '/tmp/editor-platform-scale-results',
  webServer: [
    {
      command: 'npm run preview -- --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
    {
      command: 'npm run collaboration:server',
      url: 'http://127.0.0.1:4180/collaboration-api/health',
      reuseExistingServer: false,
    },
  ],
});
