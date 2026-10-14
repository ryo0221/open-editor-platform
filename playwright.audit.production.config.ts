import { defineConfig } from '@playwright/test';
import base from './playwright.design-react.production.config';
export default defineConfig({
  ...base,
  outputDir: '/tmp/editor-platform-audit-results',
  reporter: [['list']],
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch:
      project.name === 'mobile'
        ? /audit-mobile.spec.ts$/
        : /(?:audit|pr52-review|pr52-remaining).spec.ts$/,
  })),
});
