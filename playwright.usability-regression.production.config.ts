import { defineConfig } from '@playwright/test';
import base from './playwright.design-react.production.config';

export default defineConfig({
  ...base,
  outputDir: '/tmp/editor-platform-usability-regression-results',
  reporter: [['list']],
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch:
      project.name === 'mobile'
        ? /(?:structured-graph|design-react|usability)-mobile.spec.ts$/
        : /(?:structured-graph|design-react(?:-(?:shared|regeneration|review))?|issue2-(?:canvas|rich-canvas|data|slide)|usability).spec.ts$/,
  })),
});
