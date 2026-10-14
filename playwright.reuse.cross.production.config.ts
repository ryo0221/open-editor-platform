import { defineConfig } from '@playwright/test';
import base from './playwright.cross.config';
import production from './playwright.production.config';
export default defineConfig({
  ...base,
  testMatch:
    /(?:reuse-common|reuse-composition-host|reuse-style-shared|reuse-canvas|issue2-rich-canvas|react-ui|react-ui-shared|react-ui-acceptance|react-ui-mobile|react-ui-failures)\.spec\.ts/,
  timeout: 180000,
  outputDir: '/tmp/editor-platform-reuse-cross-results',
  use: {
    ...base.use,
    baseURL: 'http://127.0.0.1:4173',
    // Match the normal production runner: trace DOM snapshots would inject
    // automation scripts into the intentionally script-free preview frames.
    trace: { mode: 'retain-on-failure', snapshots: false },
  },
  webServer: production.webServer,
});
