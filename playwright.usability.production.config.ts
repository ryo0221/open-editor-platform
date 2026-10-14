import { defineConfig } from '@playwright/test';
import base from './playwright.design-react.production.config';
export default defineConfig({
  ...base,
  outputDir: '/tmp/editor-platform-usability-results',
  reporter: [['list']],
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch: project.name === 'mobile' ? /usability-mobile.spec.ts$/ : /usability.spec.ts$/,
  })),
});
