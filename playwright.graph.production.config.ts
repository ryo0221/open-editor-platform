import { defineConfig } from '@playwright/test';
import base from './playwright.production.config';
export default defineConfig({
  ...base,
  workers: 1,
  outputDir: '/tmp/editor-platform-graph-results',
  reporter: [['list']],
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch:
      project.name === 'mobile'
        ? /(^|\/)(?:structured-graph(?:-reading)?-mobile|mobile)\.spec\.ts$/
        : /(^|\/)(?:structured-graph(?:-reading)?|issue2-data|issue2-embedding|practical-data)\.spec\.ts$/,
  })),
});
