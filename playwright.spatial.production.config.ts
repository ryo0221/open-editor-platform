import { defineConfig } from '@playwright/test';
import base from './playwright.production.config';
export default defineConfig({
  ...base,
  workers: 1,
  outputDir: '/tmp/editor-platform-spatial-results',
  reporter: [['list']],
  webServer: Array.isArray(base.webServer)
    ? base.webServer.filter((server) => server.url?.includes('4173'))
    : base.webServer,
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch:
      project.name === 'mobile'
        ? /(^|\/)spatial-wasm-mobile\.spec\.ts$/
        : /(^|\/)spatial-wasm\.spec\.ts$/,
  })),
});
