import { defineConfig } from '@playwright/test';
import base from './playwright.production.config';
export default defineConfig({
  ...base,
  outputDir: '/tmp/editor-platform-react-ui-results',
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch:
      project.name === 'mobile'
        ? /react-ui-mobile.spec.ts/
        : /react-ui(?:-shared|-acceptance|-failures)?.spec.ts/,
  })),
});
