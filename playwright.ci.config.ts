import { defineConfig } from '@playwright/test';
import base from './playwright.production.config';

/** Push/PR essentials. Full regression remains a separate manually dispatched job. */
export default defineConfig({
  ...base,
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch:
      project.name === 'mobile'
        ? /(?:issue2-mobile|office-pptx-mobile|office-docx-mobile|react-ui-mobile)\.spec\.ts/
        : /(?:issue2-embedding|office-pptx-ui|office-docx-ui|practical-history-review|reuse-recovery|react-ui|react-ui-shared|react-ui-acceptance|react-ui-failures)\.spec\.ts/,
  })),
});
