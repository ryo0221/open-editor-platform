import { defineConfig } from '@playwright/test';
import base from './playwright.production.config';
export default defineConfig({
  ...base,
  outputDir: '/tmp/editor-platform-design-react-results',
  workers: 1,
  projects: base.projects?.map((p) => ({
    ...p,
    testMatch:
      p.name === 'mobile'
        ? /design-react-mobile.spec.ts/
        : /design-react(?:-(?:shared|regeneration|review))?.spec.ts/,
  })),
  webServer: [
    ...(Array.isArray(base.webServer) ? base.webServer : []),
    {
      command: 'node scripts/design-react-export-server.mjs',
      url: 'http://127.0.0.1:4176/health',
      reuseExistingServer: false,
    },
  ],
});
